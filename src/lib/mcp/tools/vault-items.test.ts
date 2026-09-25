import { APIConnectionTimeoutError } from "@onkernel/sdk";
import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerVaultCapabilities } from "@/lib/mcp/tools/vaults";
import { connectVaultTest, item, linkSpec } from "./vaults.test-fixtures";

describe("advertised vault operations", () => {
  test.each([
    {
      type: "card",
      provider: "link",
      status: "ready",
      operation: "fill",
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
      operation: "prepare_checkout",
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
          { type: "fill", description: "Fill the bound checkout." },
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
        ).toEqual(["fill", operation]);
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
        operation: "fill",
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
          operation: "fill",
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
        operation: "fill",
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
    "returns the exact provider message for a rejected operation HTTP %s",
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
          operation: "fill",
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(reason);
        expect(text).toContain("Inspect item state and events before acting.");
        expect(text).toContain("Do not retry automatically.");
        expect(text).toContain("[code: invalid_spend_request]");
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

  test("keeps unmarked rate limits distinct from provider rejections", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(
        {
          code: "spend_request_rate_limited",
          message: "private provider text",
        },
        { status: 429 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "fill",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("rate limited spend requests");
      expect(JSON.stringify(result)).not.toContain("private provider text");
    } finally {
      await fixture.close();
    }
  });

  test("uses the API rejection marker rather than an operation-name check", async () => {
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
      expect(JSON.stringify(result)).toContain(
        "Provider declined the request.",
      );
    } finally {
      await fixture.close();
    }
  });

  test("keeps unmarked provider errors curated for other operations", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        available_operations: [{ type: "future_operation", description: "" }],
      }),
      Response.json(
        { code: "provider_error", message: "access_token=hidden" },
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
      expect(JSON.stringify(result)).not.toContain("hidden");
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
          operation: "fill",
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
            operation: "fill",
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
          operation: "fill",
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
        action: "create",
        vault: "checkout",
        key: "order-1",
        provider: "link",
        spec: linkSpec,
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
