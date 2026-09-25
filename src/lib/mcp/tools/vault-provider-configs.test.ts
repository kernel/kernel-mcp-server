import { describe, expect, test } from "bun:test";
import {
  organizationWideAuthInfo,
  projectScopedAuthInfo,
} from "@/lib/mcp/auth-context.test-fixtures";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item, linkSpec } from "./vaults.test-fixtures";

const tool = "manage_vault_provider_configs";
const secret = "secret-sentinel+/configuration";
const access = "access-sentinel+/grant";
const refresh = "refresh-sentinel+/grant";
const config = {
  id: "vpc_example",
  name: "checkout-client",
  provider: "agentcard",
  client_id: "application-id",
  test_mode: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const create = {
  action: "create",
  name: config.name,
  provider: config.provider,
  credentials: { client_id: config.client_id, client_secret: secret },
};
const importedSpec = {
  authorization: {
    method: "oauth",
    client: {
      type: "customer_managed",
      provider_config: { name: config.name },
    },
    tokens: { access_token: access, refresh_token: refresh },
  },
};
const importedCreate = {
  action: "create",
  vault: "checkout",
  key: "imported-wallet",
  provider: "link",
  spec: importedSpec,
};

function expectSecretFree(result: unknown) {
  const text = JSON.stringify(result);
  for (const value of [secret, access, refresh]) {
    expect(text).not.toContain(value);
    expect(text).not.toContain(encodeURIComponent(value));
  }
}

describe("vault provider config SDK routing", () => {
  test.each(["link", "agentcard"])(
    "creates %s configs and projects only public metadata",
    async (provider) => {
      const fixture = await connectVaultTest(
        [
          Response.json({
            ...config,
            provider,
            credentials: create.credentials,
            client_secret: secret,
            tokens: importedSpec.authorization.tokens,
          }),
        ],
        organizationWideAuthInfo(),
      );
      try {
        const result = await fixture.call(tool, { ...create, provider });
        expect(result.isError).not.toBe(true);
        expectSecretFree(result);
        expect(toolResultJSON(result)).toEqual({ ...config, provider });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({
          method: "POST",
          path: "/vault-provider-configs",
        });
        expect(fixture.requests[0].body).toEqual({
          name: config.name,
          provider,
          credentials: create.credentials,
        });
        expect(fixture.requests[0].headers.has("X-Kernel-Project")).toBe(false);
        expect(fixture.requests[0].headers.has("X-Kernel-Project-Id")).toBe(
          false,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test("gets, paginates a single page, renames, and rotates without defaulting omitted fields", async () => {
    const fixture = await connectVaultTest(
      [
        Response.json(config),
        Response.json([config], {
          headers: { "X-Has-More": "true", "X-Next-Offset": "40" },
        }),
        Response.json([], { headers: { "X-Has-More": "false" } }),
        Response.json({ ...config, name: "renamed" }),
        Response.json(config),
      ],
      organizationWideAuthInfo(),
    );
    try {
      expect(
        toolResultJSON(
          await fixture.call(tool, { action: "get", config: config.id }),
        ),
      ).toEqual(config);
      expect(
        toolResultJSON(
          await fixture.call(tool, { action: "list", limit: 20, offset: 20 }),
        ),
      ).toEqual({ items: [config], has_more: true, next_offset: 40 });
      expect(
        toolResultJSON(
          await fixture.call(tool, { action: "list", offset: 40 }),
        ),
      ).toMatchObject({ items: [], has_more: false });
      await fixture.call(tool, {
        action: "update",
        config: config.name,
        name: "renamed",
      });
      const rotated = await fixture.call(tool, {
        action: "update",
        config: config.id,
        credentials: { client_secret: secret },
      });
      expectSecretFree(rotated);
      expect(
        fixture.requests.map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/vault-provider-configs/${config.id}`,
          body: undefined,
        },
        {
          method: "GET",
          path: "/vault-provider-configs?limit=20&offset=20",
          body: undefined,
        },
        {
          method: "GET",
          path: "/vault-provider-configs?offset=40",
          body: undefined,
        },
        {
          method: "PATCH",
          path: `/vault-provider-configs/${config.name}`,
          body: { name: "renamed" },
        },
        {
          method: "PATCH",
          path: `/vault-provider-configs/${config.id}`,
          body: { credentials: { client_secret: secret } },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test.each([204, 404, 409])(
    "delete preserves HTTP %s semantics",
    async (status) => {
      const fixture = await connectVaultTest(
        [
          status === 204
            ? new Response(null, { status })
            : Response.json(
                {
                  code: status === 409 ? "conflict" : "not_found",
                  message: secret,
                },
                { status },
              ),
        ],
        organizationWideAuthInfo(),
      );
      try {
        const result = await fixture.call(tool, {
          action: "delete",
          config: config.id,
        });
        expect(result.isError === true).toBe(status === 409);
        expectSecretFree(result);
        if (status !== 409)
          expect(toolResultJSON(result)).toEqual({
            status: "deleted_or_not_found",
            config: config.id,
          });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0].method).toBe("DELETE");
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([400, 403, 409, 429, 500])(
    "redacts HTTP %s errors and never retries credential writes",
    async (status) => {
      const fixture = await connectVaultTest(
        [
          Response.json(
            {
              code: secret,
              message: secret,
              credentials: create.credentials,
              tokens: importedSpec.authorization.tokens,
            },
            { status, headers: { "Retry-After": "0", "x-request-id": secret } },
          ),
        ],
        organizationWideAuthInfo(),
      );
      try {
        const result = await fixture.call(tool, create);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(`${status} `);
        expectSecretFree(result);
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("redacts a secret echoed inside a public response field", async () => {
    const fixture = await connectVaultTest(
      [
        Response.json({
          ...config,
          name: `echo ${secret} ${encodeURIComponent(secret)}`,
        }),
      ],
      organizationWideAuthInfo(),
    );
    try {
      expectSecretFree(await fixture.call(tool, create));
    } finally {
      await fixture.close();
    }
  });
});

describe("config scope and validation", () => {
  test.each([
    create,
    { action: "update", config: config.id, name: "renamed" },
    { action: "delete", config: config.id },
  ])("rejects project-scoped writes locally", async (args) => {
    const fixture = await connectVaultTest([], projectScopedAuthInfo());
    try {
      expect((await fixture.call(tool, args)).isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("allows project credentials to read organization configs", async () => {
    const fixture = await connectVaultTest(
      [Response.json(config), Response.json([])],
      projectScopedAuthInfo(),
    );
    try {
      expect(
        (await fixture.call(tool, { action: "get", config: config.id }))
          .isError,
      ).not.toBe(true);
      expect((await fixture.call(tool, { action: "list" })).isError).not.toBe(
        true,
      );
      expect(fixture.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  test.each(["list", "get", "delete"])(
    "%s ignores unused write fields without sending credentials",
    async (action) => {
      const response =
        action === "list"
          ? Response.json([config])
          : action === "get"
            ? Response.json(config)
            : new Response(null, { status: 204 });
      const fixture = await connectVaultTest(
        [response],
        organizationWideAuthInfo(),
      );
      try {
        const result = await fixture.call(tool, {
          ...create,
          action,
          config: config.id,
        });
        expect(result.isError).not.toBe(true);
        expectSecretFree(result);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0].body).toBeUndefined();
        expect(fixture.requests[0].path).toBe(
          action === "list"
            ? "/vault-provider-configs"
            : `/vault-provider-configs/${config.id}`,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test("update ignores the create-only provider without changing identity", async () => {
    const fixture = await connectVaultTest(
      [Response.json({ ...config, name: "renamed" })],
      organizationWideAuthInfo(),
    );
    try {
      const result = await fixture.call(tool, {
        action: "update",
        config: config.id,
        provider: "link",
        name: "renamed",
      });
      expect(result.isError).not.toBe(true);
      expect(toolResultJSON(result).provider).toBe(config.provider);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].body).toEqual({ name: "renamed" });
    } finally {
      await fixture.close();
    }
  });

  const invalidConfigInputs: Record<string, unknown>[] = [
    { action: "create" },
    { ...create, credentials: { client_secret: secret } },
    { ...create, credentials: { ...create.credentials, [access]: refresh } },
    {
      ...create,
      credentials: { client_id: config.client_id, client_secret: "" },
    },
    { action: "update", config: config.id, credentials: create.credentials },
    { action: "update", config: config.id },
    { action: "update", name: "renamed" },
    { action: "get" },
    { action: "get", config: "../bad" },
    { action: "delete" },
    { action: "list", limit: 101 },
    { action: "list", offset: -1 },
  ];
  test.each(invalidConfigInputs)(
    "rejects malformed or immutable config changes without disclosure",
    async (args) => {
      const fixture = await connectVaultTest([], organizationWideAuthInfo());
      try {
        const result = await fixture.call(tool, args);
        expect(result.isError).toBe(true);
        expectSecretFree(result);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );
});

describe("configured wallets and recovery", () => {
  test.each([400, 409, 429, 500])(
    "does not expose or retry a rejected imported grant (HTTP %s)",
    async (status) => {
      const fixture = await connectVaultTest([
        Response.json(
          {
            code: "provider_error",
            message: access,
            tokens: importedSpec.authorization.tokens,
          },
          { status },
        ),
      ]);
      try {
        const result = await fixture.call(
          "manage_vault_wallets",
          importedCreate,
        );
        expect(result.isError).toBe(true);
        expectSecretFree(result);
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("an identical card PUT returns recovery unchanged without repeating approval", async () => {
    const recovery = {
      ...item,
      state: { provider: "link", status: "recovery_required" },
      available_operations: [],
    };
    const fixture = await connectVaultTest([Response.json(recovery)]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        action: "create",
        vault: "checkout",
        key: "order-1",
        provider: "link",
        spec: linkSpec,
      });
      expect(toolResultJSON(result).item.state).toEqual(recovery.state);
      expect(toolResultJSON(result).hints.invocation).toEqual([]);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].method).toBe("PUT");
    } finally {
      await fixture.close();
    }
  });
  test.each([{ id: config.id }, { name: config.name }])(
    "imports Link tokens separately from config credentials",
    async (reference) => {
      const spec = {
        authorization: {
          ...importedSpec.authorization,
          client: { type: "customer_managed", provider_config: reference },
        },
      };
      const publicSpec = {
        provider: "link",
        authorization: {
          method: "oauth",
          client: {
            type: "customer_managed",
            provider_config: { id: config.id },
          },
        },
      };
      const fixture = await connectVaultTest([
        Response.json({
          ...item,
          type: "wallet",
          spec: {
            ...publicSpec,
            authorization: {
              ...publicSpec.authorization,
              tokens: importedSpec.authorization.tokens,
            },
          },
          state: {
            provider: "link",
            status: "connected",
            status_reason: `${access} ${encodeURIComponent(refresh)}`,
          },
          available_operations: [],
        }),
      ]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          ...importedCreate,
          spec,
        });
        expect(result.isError).not.toBe(true);
        expectSecretFree(result);
        expect(toolResultJSON(result).item.spec).toEqual(publicSpec);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({
          method: "PUT",
          path: "/vaults/checkout/items/imported-wallet",
          body: { type: "wallet", spec: { ...spec, provider: "link" } },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([{ id: config.id }, { name: config.name }])(
    "selects AgentCard configuration without user grants",
    async (reference) => {
      const spec = { provider_config: reference, user_id: "usr_enrolled" };
      const fixture = await connectVaultTest([
        Response.json({
          ...item,
          type: "wallet",
          spec: { ...spec, provider: "agentcard" },
          available_operations: [],
        }),
      ]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          action: "create",
          vault: "checkout",
          key: "wallet",
          provider: "agentcard",
          spec,
        });
        expect(result.isError).not.toBe(true);
        expect(toolResultJSON(result).item.spec.provider_config).toEqual(
          reference,
        );
        expect(fixture.requests[0].body).toEqual({
          type: "wallet",
          spec: { ...spec, provider: "agentcard" },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { authorization: { ...importedSpec.authorization, tokens: undefined } },
    {
      authorization: {
        ...importedSpec.authorization,
        tokens: { access_token: access },
      },
    },
    {
      authorization: {
        ...importedSpec.authorization,
        tokens: { ...importedSpec.authorization.tokens, [secret]: secret },
      },
    },
    {
      authorization: {
        ...importedSpec.authorization,
        client: { type: "kernel_managed" },
      },
    },
    ...[{}, { id: config.id, name: config.name }, { name: "../bad" }].map(
      (provider_config) => ({
        authorization: {
          ...importedSpec.authorization,
          client: { type: "customer_managed", provider_config },
        },
      }),
    ),
  ])(
    "rejects incomplete/mismatched grants and selectors without leaking tokens",
    async (spec) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          ...importedCreate,
          spec,
        });
        expect(result.isError).toBe(true);
        expectSecretFree(result);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["link", "agentcard"])(
    "preserves %s recovery_required without polling or invocation hints",
    async (provider) => {
      const recovery = {
        ...item,
        state: { provider, status: "recovery_required" },
        available_operations: [],
      };
      const fixture = await connectVaultTest([Response.json(recovery)]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "order-1",
          wait: 60,
        });
        expect(toolResultJSON(result).item.state.status).toBe(
          "recovery_required",
        );
        expect(toolResultJSON(result).hints.invocation).toEqual([]);
        expect(toolResultJSON(result).guidance.join(" ")).toContain(
          "reconcile",
        );
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("forwards omitted vs explicit empty Link card fields unchanged", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(item),
    ]);
    try {
      for (const spec of [
        linkSpec,
        { ...linkSpec, line_items: [], totals: [], metadata: {} },
      ]) {
        await fixture.call("manage_vault_cards", {
          action: "create",
          vault: "checkout",
          key: "order-1",
          provider: "link",
          spec,
        });
      }
      expect(fixture.requests.map(({ body }) => body)).toEqual([
        { type: "card", spec: { ...linkSpec, provider: "link" } },
        {
          type: "card",
          spec: {
            ...linkSpec,
            provider: "link",
            line_items: [],
            totals: [],
            metadata: {},
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
