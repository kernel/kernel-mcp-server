import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, vault } from "./vaults.test-fixtures";

const target = { vault: "user-123", key: "login" };
const spec = {
  description: "Example",
  fields: [
    {
      name: "username",
      label: "Membership Number or Username",
      type: "text",
      required: true,
      sensitive: false,
    },
    {
      name: "password",
      type: "password",
      required: true,
      sensitive: true,
    },
  ],
};
const pending = {
  id: "item-1",
  key: "login",
  type: "credential",
  version: 1,
  spec,
  state: {
    status: "pending_collection",
    fields: { username: { has_value: false }, password: { has_value: false } },
  },
  action: {
    name: "collect",
    url: "https://vault.example/collect#token=capability",
  },
  available_operations: [{ type: "collect", description: "Reopen form" }],
  available_expansions: [],
};
const ready = {
  ...pending,
  version: 2,
  state: {
    status: "ready",
    fields: {
      username: { has_value: true, value: "secret-username" },
      password: { has_value: true },
    },
  },
  available_operations: [
    { type: "collect", description: "Reopen form" },
    { type: "fill", description: "Fill browser" },
  ],
};
const fill = {
  browser_id: "browser-1",
  page_url: "https://example.com/login",
  fields: [
    { field: "username", selector: "#username" },
    { field: "password", selector: "#password" },
  ],
};
const completed = {
  type: "fill",
  status: "completed",
  fields: [
    { index: 0, status: "filled" },
    { index: 1, status: "filled" },
  ],
};
const invoke = { ...target, action: "invoke", operation: "fill", inputs: fill };

describe("MCP credential flow", () => {
  test.each(["create", "update"])(
    "%s preserves non-sensitive values, collection URLs, and hints",
    async (action) => {
      const url = `https://vault.example/collect#token=${target.vault}.token`;
      const response = {
        ...ready,
        action: { name: "collect", url },
        state: {
          ...ready.state,
          fields: {
            username: { has_value: true, value: target.vault },
            password: { has_value: true, value: "private-password" },
          },
        },
      };
      const fixture = await connectVaultTest([Response.json(response)]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_credentials", {
            ...target,
            action,
            ...(action === "update"
              ? {
                  version: 2,
                  spec: { fields: { username: { value: target.vault } } },
                }
              : {
                  spec: {
                    ...spec,
                    fields: spec.fields.map((field) =>
                      field.name === "username"
                        ? { ...field, value: target.vault }
                        : field,
                    ),
                  },
                }),
          }),
        );
        expect(result.item.state.fields.username.value).toBe(target.vault);
        expect(result.item.action.url).toBe(url);
        expect(result.hints.observation.length).toBeGreaterThan(0);
        expect(result.hints.invocation.length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain("private-password");
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    ...[
      "element_not_found",
      "invalid_selector",
      "ambiguous_selector",
      "duplicate_target",
      "page_not_found",
      "ambiguous_page",
      "target_changed",
      "element_not_editable",
      "option_not_found",
      "field_unavailable",
      "invalid_request",
      "timeout",
    ].map((code) => ({
      status: 400,
      code,
      message: "vault fill validation failed",
    })),
    {
      status: 403,
      code: "destination_denied",
      message: "destination is not authorized",
    },
    {
      status: 409,
      code: "conflict",
      message: "fill is not currently available",
    },
    {
      status: 500,
      code: "execution_failed",
      message: "vault fill could not start",
    },
  ])(
    "preserves fill API diagnostics for $status / $code without retrying",
    async ({ status, code, message }) => {
      const fixture = await connectVaultTest([
        Response.json(ready),
        Response.json(
          { code, message, details: "private-upstream-secret" },
          { status },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", invoke);
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(`${status} ${message}`);
        expect(text).toContain(`[code: ${code}]`);
        expect(text).toContain("The operation may have partially completed");
        expect(text).toContain("Do not retry automatically.");
        expect(text).not.toContain("private-");
        expect(fixture.requests.map((request) => request.method)).toEqual([
          "GET",
          "POST",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { status: 400, code: "ambiguous_selector" },
    { status: 403, code: "destination_denied" },
    { status: 404, code: "not_found" },
    { status: 409, code: "conflict" },
    { status: 400, code: "field_unavailable" },
    { status: 400, code: "new_api_error" },
  ])(
    "passes through operation errors without interpreting the operation type ($status $code)",
    async ({ status, code }) => {
      const fixture = await connectVaultTest([
        Response.json(ready),
        Response.json({ code, message: "API diagnostic message" }, { status }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", invoke);
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(String(status));
        expect(text).toContain("The operation may have partially completed");
        expect(text).toContain("API diagnostic message");
        expect(text).toContain(`[code: ${code}]`);
        expect(
          fixture.requests.filter((request) => request.method === "POST"),
        ).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );
  test("advertises inline credential and fill schemas", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const credentials = tools.find(
        (tool) => tool.name === "manage_vault_credentials",
      );
      const items = tools.find((tool) => tool.name === "manage_vault_items");
      expect(credentials?.inputSchema.properties).toHaveProperty("spec");
      expect(JSON.stringify(credentials?.inputSchema)).toContain('"label"');
      expect(JSON.stringify(credentials?.inputSchema)).toContain(
        "128 UTF-8 bytes",
      );
      expect(credentials?.inputSchema.properties).toHaveProperty(
        "expected_item_id",
      );
      expect(items?.inputSchema.properties).toHaveProperty("inputs");
      expect(
        JSON.stringify([credentials?.inputSchema, items?.inputSchema]),
      ).not.toContain('"$ref"');
    } finally {
      await fixture.close();
    }
  });

  test("fills TOTP by field name without a value or explicit page URL", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...ready,
        spec: {
          fields: [
            {
              name: "otp",
              type: "totp",
              required: true,
              sensitive: true,
            },
          ],
        },
        state: { status: "ready", fields: { otp: { has_value: true } } },
      }),
      Response.json({
        type: "fill",
        status: "completed",
        fields: [{ index: 0, status: "filled" }],
      }),
    ]);
    try {
      const parameters = {
        browser_id: "browser-1",
        fields: [{ field: "otp", selector: "#otp" }],
      };
      const result = await fixture.call("manage_vault_items", {
        ...invoke,
        inputs: parameters,
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({ type: "fill", ...parameters });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { provider: "link", page_url: "https://example.com", allowed: true },
    { provider: "link", page_url: "http://example.com", allowed: false },
    {
      provider: "link",
      page_url: "https://user:password@example.com",
      allowed: false,
    },
    { provider: "link", page_url: undefined, allowed: false },
    { provider: "agentcard", page_url: "https://example.com", allowed: false },
  ])(
    "forwards card fill policy decisions to the API",
    async ({ provider, page_url, allowed }) => {
      const fixture = await connectVaultTest([
        Response.json({ ...ready, type: "card", spec: { provider } }),
        allowed
          ? Response.json(completed)
          : Response.json({ code: "invalid_request" }, { status: 400 }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...invoke,
          inputs: {
            ...fill,
            page_url,
            fields: [
              { field: "number", selector: "#number" },
              { field: "cvc", selector: "#cvc" },
            ],
          },
        });
        expect(Boolean(result.isError)).toBe(!allowed);
        expect(
          fixture.requests.filter((request) => request.method === "POST"),
        ).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  test("surfaces API credential format validation", async () => {
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json({ code: "invalid_request" }, { status: 400 }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...invoke,
        inputs: {
          ...fill,
          fields: [
            { field: "password", selector: "#password", format: "MM/YY" },
          ],
        },
      });
      expect(result.isError).toBe(true);
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
        "POST",
      ]);
      expect(JSON.stringify(result)).toContain("may have partially completed");
    } finally {
      await fixture.close();
    }
  });
  test("creates a vault and credential, collects, waits for readiness, and fills without exposing values", async () => {
    const fixture = await connectVaultTest(
      [
        Response.json(vault),
        Response.json({ session_id: "browser-1" }),
        Response.json(pending),
        Response.json(pending),
        Response.json(pending),
        Response.json(ready),
        Response.json(ready),
        Response.json({
          ...completed,
          value: "secret-password",
          fields: completed.fields.map((field) => ({
            ...field,
            value: "secret-password",
          })),
        }),
      ],
      undefined,
      true,
    );
    try {
      expect(
        (
          await fixture.call("manage_vaults", {
            action: "create",
            name: target.vault,
          })
        ).isError,
      ).toBeUndefined();
      const browser = await fixture.call("manage_browsers", {
        action: "create",
        vaults: [{ name: target.vault }],
        headless: false,
      });
      expect(browser.isError).toBeUndefined();
      expect(fixture.requests[1].body).toMatchObject({
        vaults: [{ name: target.vault }],
      });
      const created = toolResultJSON(
        await fixture.call("manage_vault_credentials", {
          ...target,
          action: "create",
          spec,
        }),
      );
      expect(created.item.action.url).toBe(pending.action.url);
      expect(created.item.spec.fields).toEqual(spec.fields);
      expect(created.item.spec.fields[0].label).toBe(
        "Membership Number or Username",
      );
      expect(
        (
          await fixture.call("manage_vault_items", {
            ...target,
            action: "invoke",
            operation: "collect",
          })
        ).isError,
      ).toBeUndefined();
      const observed = toolResultJSON(
        await fixture.call("manage_vault_items", {
          ...target,
          action: "get",
          wait: 60,
        }),
      );
      expect(observed.item.state.status).toBe("ready");
      expect(observed.item.state.fields.username.value).toBe("secret-username");
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).result).toEqual(completed);
      expect(JSON.stringify(result)).not.toContain("secret-password");
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "POST",
        "POST",
        "PUT",
        "GET",
        "POST",
        "GET",
        "GET",
        "POST",
      ]);
      expect(fixture.requests[2].body).toEqual({ type: "credential", spec });
      expect(fixture.requests.at(-1)?.body).toEqual({ type: "fill", ...fill });
      expect(fixture.requests[5].path).toContain("wait=60");
    } finally {
      await fixture.close();
    }
  });

  test("updates with version and immutable identity, preserving null/empty clearing", async () => {
    const fixture = await connectVaultTest([Response.json(pending)]);
    try {
      const update = {
        description: "Example",
        fields: { username: { value: "" }, password: { value: null } },
      };
      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        action: "update",
        version: 2,
        expected_item_id: "item-1",
        spec: update,
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[0].method).toBe("PATCH");
      expect(fixture.requests[0].body).toEqual({
        type: "credential",
        version: 2,
        expected_item_id: "item-1",
        spec: update,
      });
    } finally {
      await fixture.close();
    }
  });

  test("redacts supplied initial values even if echoed in metadata", async () => {
    const secret = "private-password-value";
    const fixture = await connectVaultTest([
      Response.json({ ...pending, spec: { ...spec, description: secret } }),
    ]);
    try {
      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        action: "create",
        spec: {
          ...spec,
          fields: [
            {
              name: "password",
              type: "password",
              sensitive: true,
              value: secret,
            },
          ],
        },
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(fixture.requests[0].body).toHaveProperty(
        "spec.fields.0.value",
        secret,
      );
    } finally {
      await fixture.close();
    }
  });

  test.each(["create", "update"] as const)(
    "%s redacts supplied values when the API returns duplicate definitions",
    async (action) => {
      const secret = "private-duplicate-value";
      const fixture = await connectVaultTest([
        Response.json({
          ...pending,
          spec: {
            description: secret,
            fields: [
              { name: "username", type: "text", sensitive: false },
              { name: "username", type: "password", sensitive: true },
            ],
          },
          state: {
            status: "ready",
            fields: {
              username: { has_value: true, value: secret },
            },
          },
        }),
      ]);
      try {
        const result = await fixture.call("manage_vault_credentials", {
          ...target,
          action,
          ...(action === "create"
            ? {
                spec: {
                  fields: [
                    {
                      name: "username",
                      type: "text",
                      sensitive: false,
                      value: secret,
                    },
                  ],
                },
              }
            : {
                version: 2,
                spec: { fields: { username: { value: secret } } },
              }),
        });
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(fixture.requests[0].body)).toContain(secret);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { action: "update", spec: { description: "Example" } },
    { action: "create", version: 1, spec },
    { action: "create", expected_item_id: "item-1", spec },
    { action: "create", spec: { fields: [] } },
    {
      action: "create",
      spec: {
        fields: [{ name: "password", type: "password", sensitive: false }],
      },
    },
    ...[
      "",
      " Username",
      "Username ",
      "User\nname",
      "User\u200bname",
      "x".repeat(129),
    ].map((label) => ({
      action: "create",
      spec: { fields: [{ name: "username", label, type: "text" }] },
    })),
    {
      action: "create",
      spec: {
        fields: [
          { name: "username", type: "text", private_key: "secret-value" },
        ],
      },
    },
    {
      action: "create",
      spec: {
        fields: [
          { name: "username", type: "text" },
          { name: "username", type: "password" },
        ],
      },
    },
    {
      action: "update",
      version: 1,
      spec: { fields: { username: { type: "text", value: "secret-value" } } },
    },
    { action: "update", version: 1, spec: {} },
  ])(
    "rejects invalid credential writes without HTTP requests",
    async (args) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_credentials", {
          ...target,
          ...args,
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("secret-value");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  for (const operation of ["create", "update", "fill"] as const) {
    test.each([409, 429, 500, "transport"])(
      `${operation} does not retry %s`,
      async (failure) => {
        const reply =
          failure === "transport"
            ? new Error("transport failure")
            : Response.json(
                { message: "API diagnostic message" },
                { status: Number(failure) },
              );
        const fixture = await connectVaultTest(
          operation === "fill" ? [Response.json(ready), reply] : [reply],
        );
        try {
          const result =
            operation === "fill"
              ? await fixture.call("manage_vault_items", invoke)
              : await fixture.call("manage_vault_credentials", {
                  ...target,
                  action: operation,
                  ...(operation === "update"
                    ? { version: 2, spec: { description: "Example" } }
                    : { spec }),
                });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain(
            failure === "transport"
              ? "Connection error"
              : "API diagnostic message",
          );
          expect(
            fixture.requests.filter(({ method }) => method !== "GET"),
          ).toHaveLength(1);
          if (operation === "fill")
            expect(JSON.stringify(result)).toContain(
              "Do not retry automatically",
            );
        } finally {
          await fixture.close();
        }
      },
    );
  }

  test.each(["failed", "unknown"])(
    "preserves ordered %s fill outcomes without retry",
    async (status) => {
      const outcome = {
        type: "fill",
        status,
        fields: [
          { index: 0, status: "filled" },
          { index: 1, status, error_code: "timeout", value: "secret-value" },
        ],
      };
      const fixture = await connectVaultTest([
        Response.json(ready),
        Response.json(outcome),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", invoke);
        expect(result.isError).toBe(true);
        expect(toolResultJSON(result).result.status).toBe(status);
        expect(toolResultJSON(result).result.fields[0]).toEqual({
          index: 0,
          status: "filled",
        });
        expect(JSON.stringify(result)).not.toContain("secret-value");
        expect(fixture.requests).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    },
  );

  test("checks current availability before fill", async () => {
    const fixture = await connectVaultTest([Response.json(pending)]);
    try {
      expect((await fixture.call("manage_vault_items", invoke)).isError).toBe(
        true,
      );
      expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { ...fill, fields: [] },
    {
      ...fill,
      fields: [
        { field: "password", selector: "#password", value: "secret-value" },
      ],
    },
    { ...fill, frame_id: "frame-1" },
    { ...fill, timeout_ms: 30001 },
  ])(
    "delegates operation-specific input validation to the API",
    async (parameters) => {
      const fixture = await connectVaultTest([
        Response.json(ready),
        Response.json({ code: "invalid_request" }, { status: 400 }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...invoke,
          inputs: parameters,
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("secret-value");
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          "GET",
          "POST",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("projects an item-shaped operation response without exposing private fields", async () => {
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json({
        ...ready,
        state: {
          ...ready.state,
          fields: {
            ...ready.state.fields,
            password: { has_value: true, value: "secret-password" },
          },
        },
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", invoke);
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).item.key).toBe("login");
      expect(JSON.stringify(result)).not.toContain("secret-password");
    } finally {
      await fixture.close();
    }
  });
});
