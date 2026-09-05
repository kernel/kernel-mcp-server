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
