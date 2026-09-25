import { describe, expect, test } from "bun:test";
import { organizationWideAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item } from "./vaults.test-fixtures";

const access = "review-secret-access-sentinel";
const refresh = "review-secret-refresh-sentinel";
const authorization = {
  method: "oauth",
  client: {
    type: "customer_managed",
    provider_config: { name: "configured-link" },
  },
  tokens: { access_token: access, refresh_token: refresh },
};
const wallet = {
  action: "create",
  provider: "link",
  vault: "checkout",
  key: "imported-wallet",
  spec: { authorization },
};

function expectSecretFree(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(access);
  expect(text).not.toContain(refresh);
}

describe("vault validation boundary", () => {
  test.each([
    { ...wallet.spec, [access]: refresh },
    { authorization: { ...authorization, [access]: refresh } },
    {
      authorization: {
        ...authorization,
        client: { ...authorization.client, [access]: refresh },
      },
    },
    {
      authorization: {
        ...authorization,
        client: {
          ...authorization.client,
          provider_config: { name: "configured-link", [access]: refresh },
        },
      },
    },
    {
      authorization: {
        ...authorization,
        tokens: { ...authorization.tokens, [access]: refresh },
      },
    },
    { authorization: { ...authorization, method: access } },
    {
      authorization: {
        ...authorization,
        client: { ...authorization.client, type: access },
      },
    },
  ])(
    "sanitizes rejected keys and values at every wallet nesting level",
    async (spec) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          ...wallet,
          spec,
        });
        expect(result.isError).toBe(true);
        expectSecretFree(result);
        expect(JSON.stringify(result)).toContain("Invalid vault tool input");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { action: access },
    { action: "create", provider: access },
    {
      action: "create",
      credentials: {
        client_id: "client",
        client_secret: refresh,
        [access]: refresh,
      },
    },
  ])("sanitizes config validation before the callback runs", async (args) => {
    const fixture = await connectVaultTest([], organizationWideAuthInfo());
    try {
      const result = await fixture.call("manage_vault_provider_configs", args);
      expect(result.isError).toBe(true);
      expectSecretFree(result);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("advertises strict credential and token objects", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const configs = tools.find(
        ({ name }) => name === "manage_vault_provider_configs",
      );
      const wallets = tools.find(({ name }) => name === "manage_vault_wallets");
      expect(configs?.inputSchema.properties?.credentials).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(wallets?.inputSchema.properties?.spec).toMatchObject({
        anyOf: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              authorization: expect.objectContaining({
                anyOf: expect.arrayContaining([
                  expect.objectContaining({
                    properties: expect.objectContaining({
                      tokens: expect.objectContaining({
                        type: "object",
                        additionalProperties: false,
                      }),
                    }),
                  }),
                ]),
              }),
            }),
          }),
        ]),
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("complete vault response boundary", () => {
  test.each(["key", "vault", "project"])(
    "omits executable hints when %s contains a supplied token",
    async (field) => {
      const fixture = await connectVaultTest(
        [
          Response.json({
            ...item,
            key: access,
            type: "wallet",
            spec: { authorization },
            state: { provider: "link", status: "connected" },
          }),
        ],
        organizationWideAuthInfo(),
      );
      try {
        const result = await fixture.call("manage_vault_wallets", {
          ...wallet,
          [field]: access,
        });
        expect(result.isError).not.toBe(true);
        expectSecretFree(result);
        const data = toolResultJSON(result);
        expect(data.item.key).toBe("[redacted]");
        expect(data.hints).toEqual({ observation: [], invocation: [] });
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("omits only unsafe invocation hints without modifying safe identifiers", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [
          { type: access, description: "Unsafe echo" },
          { type: "fill", description: "Safe operation" },
        ],
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_wallets", wallet);
      expect(result.isError).not.toBe(true);
      expectSecretFree(result);
      const hints = toolResultJSON(result).hints;
      expect(hints.observation).toHaveLength(2);
      expect(hints.invocation).toHaveLength(1);
      expect(hints.invocation[0].arguments).toMatchObject({
        key: wallet.key,
        vault: wallet.vault,
        operation: "fill",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each([204, 404])(
    "redacts config selectors in deletion acknowledgments (HTTP %s)",
    async (status) => {
      const fixture = await connectVaultTest(
        [new Response(null, { status })],
        organizationWideAuthInfo(),
      );
      try {
        const result = await fixture.call("manage_vault_provider_configs", {
          action: "delete",
          config: access,
          credentials: { client_secret: access },
        });
        expect(result.isError).not.toBe(true);
        expectSecretFree(result);
        expect(toolResultJSON(result)).toEqual({
          status: "deleted_or_not_found",
          config: "[redacted]",
        });
        expect(fixture.requests[0].body).toBeUndefined();
      } finally {
        await fixture.close();
      }
    },
  );
});
