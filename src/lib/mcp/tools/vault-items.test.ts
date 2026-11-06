import { APIConnectionTimeoutError } from "@onkernel/sdk";
import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerVaultCapabilities } from "@/lib/mcp/tools/vaults";
import { connectVaultTest, item } from "./vaults.test-fixtures";

describe("advertised vault operations", () => {
  test.each([
    {
      type: "card",
      provider: "link",
      status: "requested",
      operation: "authorize",
    },
    {
      type: "wallet",
      provider: "agentcard",
      status: "connected",
      operation: "future_operation",
    },
    {
      type: "card",
      provider: "agentcard",
      status: "ready",
      operation: "authorize",
    },
  ])(
    "uses API-advertised availability for $provider/$type/$status",
    async ({ type, provider, status, operation }) => {
      const before = {
        ...item,
        type,
        spec: { provider },
        state: { provider, status },
        available_operations: [
          { type: operation, description: "Require user approval." },
        ],
      };
      const after = {
        ...before,
        available_operations: [],
        action: {
          name: "spend_approval",
          url: "https://provider.example/approve",
        },
      };
      const fixture = await connectVaultTest([
        Response.json(before),
        Response.json(after),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation,
        });
        expect(toolResultJSON(result).item).toEqual(after);
        expect(
          fixture.requests.map(({ method, path, body }) => ({
            method,
            path,
            body,
          })),
        ).toEqual([
          {
            method: "GET",
            path: "/vaults/checkout/items/order-1",
            body: undefined,
          },
          {
            method: "POST",
            path: "/vaults/checkout/items/order-1/operations",
            body: { type: operation },
          },
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["prepare_checkout", "future_operation"])(
    "discovers and invokes advertised %s with operation-specific inputs",
    async (operation) => {
      const advertisedItem = {
        ...item,
        available_operations: [
          { type: "authorize", description: "Require user approval." },
          { type: operation, description: "Requires additional inputs." },
        ],
      };
      const inputs = {
        checkout: {
          browser_id: "browser-1",
          merchant_origin: "https://shop.example",
        },
      };
      const fixture = await connectVaultTest([
        Response.json(advertisedItem),
        Response.json(advertisedItem),
        Response.json({ ...item, available_operations: [] }),
      ]);
      try {
        const observed = toolResultJSON(
          await fixture.call("manage_vault_items", {
            action: "get",
            vault: "checkout",
            key: "order-1",
          }),
        );
        expect(observed.item.available_operations).toEqual(
          advertisedItem.available_operations,
        );
        expect(
          observed.hints.invocation.map(
            (hint: { arguments: { operation: string } }) =>
              hint.arguments.operation,
          ),
        ).toEqual(["authorize", operation]);
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation,
          inputs,
        });
        expect(result.isError).toBeUndefined();
        expect(fixture.requests.map((request) => request.method)).toEqual([
          "GET",
          "GET",
          "POST",
        ]);
        expect(fixture.requests[2].body).toEqual({
          type: operation,
          ...inputs,
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test("handles field results for newly advertised operation types", async () => {
    const inputs = {
      browser_id: "browser-1",
      fields: [{ field: "username", selector: "#username" }],
    };
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [
          { type: "future_operation", description: "Write fields." },
        ],
      }),
      Response.json({
        type: "future_operation",
        status: "completed",
        fields: [{ index: 0, status: "filled" }],
        opaque: "hidden",
      }),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "future_operation",
          inputs,
        }),
      );
      expect(result.result).toMatchObject({
        type: "future_operation",
        status: "completed",
      });
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(fixture.requests[1].body).toEqual({
        type: "future_operation",
        ...inputs,
      });
    } finally {
      await fixture.close();
    }
  });

  test("does not select a response type from input field names", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [
          { type: "future_operation", description: "Do work." },
        ],
      }),
      Response.json({
        type: "future_operation",
        status: "pending",
        opaque: "hidden",
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "future_operation",
        inputs: { fields: [{ name: "example" }] },
      });
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).result).toEqual({
        type: "future_operation",
        status: "pending",
      });
      expect(JSON.stringify(result)).not.toContain("hidden");
    } finally {
      await fixture.close();
    }
  });

  test("projects unknown operation results without exposing opaque fields", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [
          { type: "future_operation", description: "Run it." },
        ],
      }),
      Response.json({
        type: "future_operation",
        status: "pending",
        opaque: "hidden",
      }),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "future_operation",
        }),
      );
      expect(result.result).toEqual({
        type: "future_operation",
        status: "pending",
      });
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
        "POST",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("does not report an unrecognized operation response as success", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json({ opaque: "hidden" }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "authorize",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("unrecognized response");
      expect(JSON.stringify(result)).not.toContain("hidden");
    } finally {
      await fixture.close();
    }
  });

  test.each(["type", "id_or_name"])(
    "does not let invocation inputs override %s",
    async (field) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "authorize",
          inputs: { [field]: "hidden" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("hidden");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("re-fetches availability rather than trusting an earlier get", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json({ ...item, available_operations: [] }),
    ]);
    try {
      await fixture.call("manage_vault_items", {
        action: "get",
        vault: "checkout",
        key: "order-1",
      });
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "authorize",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not advertised");
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
        "GET",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test.each([400, 403, 409, 422])(
    "returns the exact provider message for authorize HTTP %s",
    async (status) => {
      const reason = `Funding method cannot be used for this purchase (${status}).`;
      const fixture = await connectVaultTest([
        Response.json(item),
        Response.json(
          {
            code: "invalid_spend_request",
            message: `Payment provider rejected card authorization: ${reason}`,
            inner_error: { code: "provider_rejection_reason", message: reason },
            opaque: "hidden",
          },
          { status },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "authorize",
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(
          `Payment provider rejected card authorization: ${reason}`,
        );
        expect(text).toContain('[code: invalid_spend_request]"');
        expect(text).not.toContain("hidden");
        expect(text).not.toContain(
          "The payment provider could not complete the vault request.",
        );
        expect(fixture.requests.map((request) => request.method)).toEqual([
          "GET",
          "POST",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("passes through rate limit diagnostics", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(
        {
          code: "spend_request_rate_limited",
          message: "Provider rate limit diagnostic",
        },
        { status: 429 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "authorize",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "Provider rate limit diagnostic",
      );
      expect(JSON.stringify(result)).toContain(
        "[code: spend_request_rate_limited]",
      );
    } finally {
      await fixture.close();
    }
  });

  test("preserves the API message instead of substituting inner errors", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [{ type: "future_operation", description: "" }],
      }),
      Response.json(
        {
          code: "future_decline",
          message: "Public error wrapper",
          inner_error: {
            code: "provider_rejection_reason",
            message: "Provider declined the request.",
          },
        },
        { status: 400 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "future_operation",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Public error wrapper");
      expect(JSON.stringify(result)).toContain("[code: future_decline]");
      expect(JSON.stringify(result)).not.toContain(
        "Provider declined the request.",
      );
    } finally {
      await fixture.close();
    }
  });

  test("passes through provider errors for other operations", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [{ type: "future_operation", description: "" }],
      }),
      Response.json(
        { code: "provider_error", message: "Provider diagnostic" },
        { status: 400 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "future_operation",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("400 Provider diagnostic");
      expect(JSON.stringify(result)).toContain("[code: provider_error]");
    } finally {
      await fixture.close();
    }
  });

  test.each(["get", "post"])(
    "does not retry an operation's failed %s",
    async (stage) => {
      const failure = Response.json(
        {
          code: "provider_error",
          message: "Provider unavailable",
          opaque: "hidden",
        },
        { status: 503 },
      );
      const fixture = await connectVaultTest(
        stage === "get" ? [failure] : [Response.json(item), failure],
      );
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "authorize",
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("provider_error");
        expect(JSON.stringify(result)).not.toContain("hidden");
        expect(fixture.requests).toHaveLength(stage === "get" ? 1 : 2);
      } finally {
        await fixture.close();
      }
    },
  );
});

describe("credential passkey operations", () => {
  const passkeyItem = {
    ...item,
    type: "credential",
    spec: {
      provider: "kernel",
      description: "Example",
      fields: [
        {
          name: "passkey",
          type: "passkey",
          required: false,
          sensitive: true,
        },
        {
          name: "new_passkey",
          type: "passkey",
          required: false,
          sensitive: true,
        },
      ],
    },
    state: {
      provider: "kernel",
      status: "ready",
      fields: {
        passkey: { has_value: true },
        new_passkey: { has_value: false },
      },
    },
  };

  test("advertises passkey inputs and browser-session invocation hints", async () => {
    const advertised = {
      ...passkeyItem,
      available_operations: [
        { type: "arm_passkey", description: "Arm the stored passkey." },
        { type: "register_passkey", description: "Register a passkey." },
        { type: "disarm_passkey", description: "Disarm passkeys." },
      ],
    };
    const fixture = await connectVaultTest([Response.json(advertised)]);
    try {
      const { tools } = await fixture.client.listTools();
      const tool = tools.find(({ name }) => name === "manage_vault_items");
      const inputsDescription = JSON.stringify(
        tool?.inputSchema.properties?.inputs,
      );
      expect(inputsDescription).toContain(
        "arm_passkey, register_passkey, and disarm_passkey each take exactly { browser_id, field? }",
      );
      expect(inputsDescription).toContain(
        "field selects the empty passkey field",
      );
      expect(tool?.description).toContain(
        "any script on those pages can trigger sign-in",
      );

      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "login",
        }),
      );
      expect(result.hints.invocation).toEqual(
        advertised.available_operations.map(({ type }) => ({
          tool: "manage_vault_items",
          arguments: {
            project: "proj_test",
            vault: "checkout",
            key: "login",
            action: "invoke",
            operation: type,
          },
          requires_user_approval: true,
          required_inputs: ["browser_id"],
        })),
      );
      expect(result.guidance.join(" ")).toContain(
        "each browser has one pending registration",
      );
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      operation: "arm_passkey",
      inputs: { browser_id: "browser-session-id", field: "passkey" },
      response: {
        type: "arm_passkey",
        status: "armed",
        rp_id: "example.com",
      },
      guidance: "does not mean a page has asked or sign-in succeeded",
    },
    {
      operation: "register_passkey",
      inputs: { browser_id: "browser-session-id", field: "new_passkey" },
      response: { type: "register_passkey", status: "armed" },
      guidance: "does not mean registration finished",
    },
    {
      operation: "disarm_passkey",
      inputs: { browser_id: "browser-session-id" },
      response: { type: "disarm_passkey", status: "disarmed" },
      guidance: "pending registration",
    },
  ] as const)(
    "forwards and handles $operation",
    async ({ operation, inputs, response, guidance }) => {
      const advertised = {
        ...passkeyItem,
        available_operations: [{ type: operation, description: "Use it." }],
      };
      const fixture = await connectVaultTest([
        Response.json(advertised),
        Response.json({ ...response, opaque: "hidden" }),
      ]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            action: "invoke",
            vault: "checkout",
            key: "login",
            operation,
            inputs,
          }),
        );
        expect(result.result).toEqual(response);
        expect(result.guidance).toContain(guidance);
        expect(JSON.stringify(result)).not.toContain("hidden");
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests[1]).toMatchObject({
          method: "POST",
          path: "/vaults/checkout/items/login/operations",
          body: { type: operation, ...inputs },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test("forwards an optional field when disarming one passkey", async () => {
    const advertised = {
      ...passkeyItem,
      available_operations: [
        { type: "disarm_passkey", description: "Disarm one field." },
      ],
    };
    const fixture = await connectVaultTest([
      Response.json(advertised),
      Response.json({ type: "disarm_passkey", status: "disarmed" }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "login",
        operation: "disarm_passkey",
        inputs: { browser_id: "browser-session-id", field: "passkey" },
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({
        type: "disarm_passkey",
        browser_id: "browser-session-id",
        field: "passkey",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      operation: "arm_passkey",
      inputs: {},
      issue: "invalid arm_passkey inputs (browser_id)",
    },
    {
      operation: "register_passkey",
      inputs: { browser_id: "" },
      issue: "invalid register_passkey inputs (browser_id)",
    },
    {
      operation: "disarm_passkey",
      inputs: { browser_id: "browser-session-id", field: "" },
      issue: "invalid disarm_passkey inputs (field)",
    },
    {
      operation: "arm_passkey",
      inputs: { browser_id: "browser-session-id", field: "x".repeat(65) },
      issue: "invalid arm_passkey inputs (field)",
    },
    {
      operation: "register_passkey",
      inputs: { browser_id: "browser-session-id", extra: true },
      issue: 'unknown key "extra" in register_passkey inputs',
    },
  ])(
    "rejects invalid $operation inputs without a request",
    async ({ operation, inputs, issue }) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "login",
          operation,
          inputs,
        });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(text).toContain(issue);
        expect(text).toContain("expected { browser_id, field? }");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("rejects an unrecognized passkey result without exposing fields", async () => {
    const advertised = {
      ...passkeyItem,
      available_operations: [
        { type: "arm_passkey", description: "Arm the passkey." },
      ],
    };
    const fixture = await connectVaultTest([
      Response.json(advertised),
      Response.json({
        type: "arm_passkey",
        status: "pending",
        opaque: "hidden",
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "login",
        operation: "arm_passkey",
        inputs: { browser_id: "browser-session-id" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("unrecognized passkey response");
      expect(JSON.stringify(result)).not.toContain("hidden");
    } finally {
      await fixture.close();
    }
  });
});

describe("vault observation and deletion", () => {
  test("advertises wait as get/events-only", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const tool = tools.find((tool) => tool.name === "manage_vault_items");
      expect(tool?.inputSchema.properties?.wait).toMatchObject({
        description: expect.stringContaining("(get, events)"),
        minimum: 0,
        maximum: 60,
      });
    } finally {
      await fixture.close();
    }
  });

  test.each(["list", "invoke", "delete"])(
    "rejects wait on %s without making a request",
    async (action) => {
      const fixture = await connectVaultTest([]);
      try {
        for (const wait of [0, 60]) {
          const result = await fixture.call("manage_vault_items", {
            action,
            vault: "checkout",
            key: "order-1",
            operation: "authorize",
            wait,
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain(
            "wait is only supported for get and events",
          );
        }
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("returns pending state without polling, and preserves the event cursor on an empty wait", async () => {
    const event = {
      id: "evt_2",
      name: "checkout.outcome",
      created_at: "2026-01-01T00:00:00Z",
      data: { outcome_reason: "indeterminate" },
    };
    const pending = {
      ...item,
      state: { provider: "link", status: "pending_authorization" },
    };
    const fixture = await connectVaultTest([
      Response.json(pending),
      Response.json([event]),
      Response.json([]),
    ]);
    try {
      expect(
        toolResultJSON(
          await fixture.call("manage_vault_items", {
            action: "get",
            vault: "checkout",
            key: "order-1",
            wait: 60,
          }),
        ).item.state.status,
      ).toBe("pending_authorization");
      const first = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "events",
          vault: "checkout",
          key: "order-1",
          after: "evt_1",
          wait: 60,
        }),
      );
      const empty = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "events",
          vault: "checkout",
          key: "order-1",
          after: first.next_after,
          wait: 60,
        }),
      );
      expect(first).toMatchObject({ events: [event], next_after: "evt_2" });
      expect(empty).toMatchObject({ events: [], next_after: "evt_2" });
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.requests[0].path).toBe(
        "/vaults/checkout/items/order-1?wait=60",
      );
      for (const [index, after] of [
        [1, "evt_1"],
        [2, "evt_2"],
      ] as const) {
        const url = new URL(
          fixture.requests[index].path,
          "https://api.example",
        );
        expect(url.searchParams.get("after")).toBe(after);
        expect(url.searchParams.get("wait")).toBe("60");
      }
    } finally {
      await fixture.close();
    }
  });

  test("passes bounded timeout headroom, disables retries, and propagates cancellation", async () => {
    const options: Array<{
      timeout: number;
      maxRetries: number;
      signal: AbortSignal;
    }> = [];
    const fixture = await connectTestMcp(registerVaultCapabilities, {
      vaults: {
        items: {
          retrieve: async (
            _key: string,
            _params: unknown,
            requestOptions: (typeof options)[number],
          ) => {
            options.push(requestOptions);
            return item;
          },
          events: async (
            _key: string,
            _params: unknown,
            requestOptions: (typeof options)[number],
          ) => {
            options.push(requestOptions);
            return [];
          },
        },
      },
    });
    try {
      for (const action of ["get", "events"]) {
        await fixture.client.callTool({
          name: "manage_vault_items",
          arguments: { action, vault: "checkout", key: "order-1", wait: 60 },
        });
      }
      expect(options).toHaveLength(2);
      for (const request of options) {
        expect(request.timeout).toBe(90000);
        expect(request.maxRetries).toBe(0);
        expect(request.signal).toBeInstanceOf(AbortSignal);
      }
    } finally {
      await fixture.close();
    }
  });

  test("reports a timeout once without invoking the operation", async () => {
    let gets = 0;
    const fixture = await connectTestMcp(registerVaultCapabilities, {
      vaults: {
        items: {
          retrieve: async () => {
            gets++;
            throw new APIConnectionTimeoutError();
          },
        },
      },
    });
    try {
      const result = await fixture.client.callTool({
        name: "manage_vault_items",
        arguments: {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "authorize",
        },
      });
      expect(result.isError).toBe(true);
      expect(gets).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test.each([204, 404, 403, 500])(
    "handles vault and item deletion HTTP %s",
    async (status) => {
      for (const name of ["manage_vaults", "manage_vault_items"]) {
        const response =
          status === 204
            ? new Response(null, { status })
            : Response.json(
                { code: "fixture_error", message: "Request rejected" },
                { status },
              );
        const fixture = await connectVaultTest([response]);
        try {
          const result = await fixture.call(name, {
            action: "delete",
            vault: "checkout",
            ...(name === "manage_vault_items" && { key: "order-1" }),
          });
          if (status === 204 || status === 404)
            expect(toolResultJSON(result).status).toBe("deleted_or_not_found");
          else expect(result.isError).toBe(true);
          expect(fixture.requests).toHaveLength(1);
          expect(fixture.requests[0].method).toBe("DELETE");
        } finally {
          await fixture.close();
        }
      }
    },
  );

  test.each([
    ["manage_vaults", { action: "create", name: "checkout" }],
    ["manage_vaults", { action: "list" }],
    [
      "manage_vault_items",
      { action: "events", vault: "checkout", key: "order-1" },
    ],
    [
      "manage_vault_wallets",
      {
        action: "create",
        vault: "checkout",
        key: "wallet-1",
        provider: "agentcard",
        spec: {},
      },
    ],
    [
      "manage_vault_wallets",
      { action: "payment_methods", vault: "checkout", key: "wallet-1" },
    ],
    [
      "manage_vault_cards",
      {
        action: "update",
        vault: "checkout",
        key: "order-1",
        provider: "agentcard",
        spec: {
          wallet: "wallet-1",
          amount: 100,
          merchant: "Example",
          currency: "usd",
        },
      },
    ],
  ] as const)(
    "does not retry a rate-limited %s request",
    async (name, args) => {
      const fixture = await connectVaultTest([
        Response.json(
          { code: "spend_request_rate_limited", message: "Stop and back off" },
          { status: 429, headers: { "retry-after-ms": "1" } },
        ),
      ]);
      try {
        const result = await fixture.call(name, args);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("spend_request_rate_limited");
        expect(fixture.requests).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );
});

describe("Link checkout authorize and fill", () => {
  const target = { vault: "checkout", key: "order-1" };
  const checkout = {
    browser_id: "browser-session-id",
    page_url: "https://shop.example/checkout?session=1#pay",
  };
  const pending = {
    ...item,
    state: { provider: "link", status: "pending_authorization" },
    available_operations: [],
  };

  test.each([{ inputs: checkout }, { inputs: {} }, { inputs: undefined }])(
    "forwards authorize inputs $inputs unchanged",
    async ({ inputs }) => {
      const fixture = await connectVaultTest([
        Response.json(item),
        Response.json(pending),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "authorize",
          ...(inputs && { inputs }),
        });
        expect(result.isError).toBeUndefined();
        expect(fixture.requests[1]).toMatchObject({
          method: "POST",
          path: "/vaults/checkout/items/order-1/operations",
          body: { type: "authorize", ...inputs },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { inputs: { browser_id: checkout.browser_id }, message: "(browser_id)" },
    { inputs: { page_url: checkout.page_url }, message: "(browser_id)" },
    {
      inputs: { ...checkout, page_url: "http://shop.example/checkout" },
      message: "(page_url)",
    },
    {
      inputs: { ...checkout, merchant_account_id: "acct_123" },
      message: 'unknown key "merchant_account_id"',
    },
  ])(
    "rejects authorize inputs $inputs before any request",
    async ({ inputs, message }) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "authorize",
          inputs,
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(result.isError).toBe(true);
        expect(text).toContain(message);
        expect(text).toContain(
          "expected {} or { browser_id, page_url }: pass browser_id and the https page_url of the final checkout page together, or neither.",
        );
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    {
      status: 400,
      code: "page_not_found",
      message:
        "no open tab is at page_url; open the checkout page in the browser and authorize again",
    },
    {
      status: 400,
      code: "ambiguous_page",
      message:
        "more than one tab is at page_url; close the extra tabs and authorize again",
    },
    { status: 404, code: "browser_not_found", message: "browser not found" },
    {
      status: 409,
      code: "browser_unavailable",
      message: "browser is unavailable for checkout inspection",
    },
    {
      status: 403,
      code: "destination_denied",
      message: "checkout destination is not authorized",
    },
    { status: 400, code: "timeout", message: "checkout inspection failed" },
    {
      status: 500,
      code: "browser_error",
      message: "checkout inspection failed",
    },
  ])(
    "passes through $code with the checkout recovery step",
    async ({ status, code, message }) => {
      const fixture = await connectVaultTest([
        Response.json(item),
        Response.json({ code, message }, { status }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "authorize",
          inputs: checkout,
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(result.isError).toBe(true);
        expect(text).toBe(
          `error in manage_vault_items (invoke): ${status} ${message} [code: ${code}] no payment request was made. make sure the checkout is open in exactly one tab at page_url, then authorize again. if checkout inspection keeps failing, authorize without browser_id and page_url to issue a virtual card for the merchant_url origin.`,
        );
        expect(fixture.requests).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    {
      stage: "after the POST was sent",
      replies: () => [Response.json(item), new Error("socket hang up")],
      submitted: true,
      requests: 2,
    },
    {
      stage: "before the POST",
      replies: () => [new Error("socket hang up")],
      submitted: false,
      requests: 1,
    },
  ])(
    "reports a lost Link authorize response $stage",
    async ({ replies, submitted, requests }) => {
      const fixture = await connectVaultTest(replies());
      try {
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "authorize",
          inputs: checkout,
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(result.isError).toBe(true);
        const note =
          "no response was received from the api after the operation was submitted.";
        if (submitted) expect(text).toEndWith(note);
        else expect(text).not.toContain(note);
        expect(fixture.requests).toHaveLength(requests);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    "HTTPS://shop.example/checkout",
    "https://user@shop.example/checkout",
    "https://shop.example/check out",
    "https://*.shop.example/checkout",
  ])("rejects page_url %s that the API pattern rejects", async (page_url) => {
    const fixture = await connectVaultTest([]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "authorize",
        inputs: { ...checkout, page_url },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "invalid authorize inputs (page_url)",
      );
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("passes through other Link authorize errors unchanged", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(
        {
          code: "invalid_request",
          message:
            "Link virtual card amount cannot exceed 50000 minor currency units",
        },
        { status: 400 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "authorize",
        inputs: checkout,
      });
      expect((result.content as Array<{ text: string }>)[0].text).toBe(
        "error in manage_vault_items (invoke): 400 Link virtual card amount cannot exceed 50000 minor currency units [code: invalid_request]",
      );
    } finally {
      await fixture.close();
    }
  });

  test("forwards a Link Pay Token fill without fields", async () => {
    const ready = {
      ...item,
      state: { provider: "link", status: "ready" },
      available_operations: [
        {
          type: "fill",
          description:
            "Invoke fill with a browser_id that has this vault attached and the exact current top-level page_url, and omit fields.",
        },
      ],
    };
    const outcome = { type: "fill", status: "completed", fields: [] };
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json(outcome),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "fill",
        inputs: checkout,
      });
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).result).toEqual(outcome);
      expect(fixture.requests[1]).toMatchObject({
        method: "POST",
        body: { type: "fill", ...checkout },
      });
      expect(fixture.requests[1].body).not.toHaveProperty("fields");
      expect(toolResultJSON(result).guidance).toStartWith(
        "completed means the credential was supplied to the page",
      );
    } finally {
      await fixture.close();
    }
  });
});

describe("KERNEL wallet payment-method operations", () => {
  const wallet = {
    ...item,
    key: "wallet-1",
    type: "wallet",
    spec: { provider: "kernel" },
    state: { provider: "kernel", status: "connected" },
    available_operations: [
      { type: "add_payment_method", description: "Enroll a card." },
      { type: "remove_payment_method", description: "Remove a card." },
    ],
  };

  test.each([
    {
      operation: "add_payment_method",
      inputs: undefined,
      response: {
        type: "add_payment_method",
        payment_method: {
          id: "pm_2",
          provider: "kernel",
          type: "card",
          is_default: false,
          status: "pending_enrollment",
          display: {},
          capabilities: {},
          action: {
            name: "card_enrollment",
            url: "https://vault.example/enroll",
            capture_token: "private-capture-token",
          },
          expires_at: "2026-10-28T12:30:00Z",
        },
      },
      guidance: "only to the intended cardholder",
    },
    {
      operation: "remove_payment_method",
      inputs: { payment_method_id: "pm_2" },
      response: {
        type: "remove_payment_method",
        payment_method_id: "pm_2",
        status: "removed",
      },
      guidance: "removal is not proof that a payment did not occur",
    },
  ])(
    "invoke renders the $operation result",
    async ({ operation, inputs, response, guidance }) => {
      const fixture = await connectVaultTest([
        Response.json(wallet),
        Response.json(response),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "wallet-1",
          operation,
          ...(inputs && { inputs }),
        });
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("private-capture-token");
        const body = toolResultJSON(result);
        expect(body.result.type).toBe(operation);
        if (operation === "add_payment_method")
          expect(body.result.payment_method).toMatchObject({
            id: "pm_2",
            status: "pending_enrollment",
            action: {
              name: "card_enrollment",
              url: "https://vault.example/enroll",
            },
          });
        else expect(body.result).toEqual(response);
        expect(body.guidance).toContain(guidance);
        expect(fixture.requests[1].body).toEqual({
          type: operation,
          ...inputs,
        });
      } finally {
        await fixture.close();
      }
    },
  );
});
