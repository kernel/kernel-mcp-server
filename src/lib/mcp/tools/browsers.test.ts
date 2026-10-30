/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  connectTestMcp,
  toolResultJSON,
  toolResultText,
} from "@/lib/mcp/mcp-test-fixtures";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";

const event = {
  seq: 42,
  event: {
    ts: 1_700_000_000_000_000,
    category: "network",
    type: "network_response",
    source: { service: "cdp" },
    truncated: true,
    data: {
      headers: { "set-cookie": "secret" },
      post_data: "query=secret",
      body: '{"result":"complete"}',
      status: 200,
    },
  },
};

function telemetryClient(queries: unknown[], items: unknown[] = [event]) {
  return {
    browsers: {
      telemetry: {
        events: async (_sessionId: string, query: unknown) => {
          queries.push(query);
          return {
            getPaginatedItems: () => items,
            has_more: true,
            next_offset: 43,
          };
        },
      },
    },
  };
}

type TextResourceResult = {
  contents: Array<{ text: string }>;
};

describe("manage_browsers telemetry", () => {
  test("re-fetches a cursor page without compaction", async () => {
    const queries: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries),
    );
    const page = {
      action: "get_telemetry",
      session_id: "brr_123",
      categories: ["network"],
      offset: 41,
      limit: 1,
      order: "asc",
    };

    try {
      const compact = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: page,
        }),
      );
      const raw = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: compact.raw_replay_best_effort,
        }),
      );

      expect(compact.items).toEqual([
        {
          seq: 42,
          ts: 1_700_000_000_000_000,
          time: "2023-11-14T22:13:20.000Z",
          category: "network",
          type: "network_response",
          source: { service: "cdp" },
          data: { status: 200 },
          truncated: true,
          omitted_fields: ["headers", "post_data", "body"],
        },
      ]);
      expect(compact.raw_replay_best_effort).toEqual({
        ...page,
        compact: false,
      });
      expect(raw).toEqual({
        items: [event],
        has_more: true,
        next_offset: 43,
      });
      expect(queries).toEqual([
        {
          limit: 1,
          category: ["network"],
          offset: 41,
          order: "asc",
        },
        {
          limit: 1,
          category: ["network"],
          offset: 41,
          order: "asc",
        },
      ]);
    } finally {
      await close();
    }
  });

  test("preserves API time and tail semantics", async () => {
    const queries: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries),
    );

    try {
      const descending = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "get_telemetry",
            session_id: "brr_123",
            categories: ["network"],
            limit: 1,
            order: "desc",
          },
        }),
      );
      const relative = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "get_telemetry",
            session_id: "brr_123",
            categories: ["network"],
            since: "30m",
            until: "5m",
            limit: 1,
          },
        }),
      );

      expect(queries).toEqual([
        { limit: 1, category: ["network"], order: "desc" },
        {
          limit: 1,
          category: ["network"],
          since: "30m",
          until: "5m",
        },
      ]);
      expect(descending.raw_replay_best_effort).not.toHaveProperty("until");
      expect(relative.raw_replay_best_effort).toMatchObject({
        since: "30m",
        until: "5m",
        compact: false,
      });
    } finally {
      await close();
    }
  });

  test("forwards event-type filters and preserves new captcha metadata", async () => {
    const queries: unknown[] = [];
    const captchaEvent = {
      seq: 43,
      event: {
        ts: 1_700_000_000_000_001,
        category: "captcha",
        type: "captcha_solve_result",
        source: { service: "captcha" },
        data: { captcha_provider: "binance", media: "video" },
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries, [captchaEvent]),
    );

    try {
      const result = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "get_telemetry",
            session_id: "brr_123",
            categories: ["captcha", "platform"],
            event_types: ["captcha_solve_result"],
            limit: 1,
          },
        }),
      );

      expect(queries).toEqual([
        {
          limit: 1,
          category: ["captcha", "platform"],
          type: ["captcha_solve_result"],
          since: "1970-01-01T00:00:00Z",
        },
      ]);
      expect(result.items[0].data).toEqual({
        captcha_provider: "binance",
        media: "video",
      });
      expect(result.raw_replay_best_effort.event_types).toEqual([
        "captcha_solve_result",
      ]);
    } finally {
      await close();
    }
  });

  test("requires an explicit small raw limit", async () => {
    const queries: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries),
    );

    try {
      const missing = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "get_telemetry",
          session_id: "brr_123",
          categories: ["network"],
          compact: false,
        },
      });
      const tooLarge = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "get_telemetry",
          session_id: "brr_123",
          categories: ["network"],
          limit: 6,
          compact: false,
        },
      });

      expect(missing.isError).toBeTrue();
      expect(toolResultText(missing)).toContain(
        "explicit limit between 1 and 5",
      );
      expect(tooLarge.isError).toBeTrue();
      expect(toolResultText(tooLarge)).toContain(
        "explicit limit between 1 and 5",
      );
      expect(queries).toEqual([]);
    } finally {
      await close();
    }
  });

  test("caps the serialized raw response", async () => {
    const queries: unknown[] = [];
    const oversizedEvents = [1, 2, 3].map((seq) => ({
      ...event,
      seq,
      event: {
        ...event.event,
        data: { body: "x".repeat(400_000) },
      },
    }));
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries, oversizedEvents),
    );

    try {
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "get_telemetry",
          session_id: "brr_123",
          categories: ["network"],
          limit: 3,
          compact: false,
        },
      });

      expect(result.isError).toBeTrue();
      expect(toolResultText(result)).toContain(
        "raw telemetry response exceeds 1048576 bytes",
      );
    } finally {
      await close();
    }
  });

  test("keeps screenshot PNGs out of raw JSON", async () => {
    const queries: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries),
    );

    try {
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "get_telemetry",
          session_id: "brr_123",
          categories: ["screenshot"],
          limit: 1,
          compact: false,
        },
      });

      expect(result.isError).toBeTrue();
      expect(toolResultText(result)).toContain(
        "does not support the screenshot category",
      );
      expect(queries).toEqual([]);
    } finally {
      await close();
    }
  });

  test("rejects PNG fields returned under another category", async () => {
    const queries: unknown[] = [];
    const pngEvent = {
      ...event,
      event: { ...event.event, data: { png: "base64" } },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries, [pngEvent]),
    );

    try {
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "get_telemetry",
          session_id: "brr_123",
          categories: ["network"],
          limit: 1,
          compact: false,
        },
      });

      expect(result.isError).toBeTrue();
      expect(toolResultText(result)).toContain(
        "raw screenshot pngs are not available",
      );
      expect(queries).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test("preserves the payment-window proxy error and documents its meaning", async () => {
    const queries: unknown[] = [];
    const proxyError = {
      seq: 44,
      event: {
        ts: 1_700_000_000_000_002,
        category: "network",
        type: "browser_proxy_error",
        source: { service: "proxy" },
        data: { code: "payment_window_expired" },
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries, [proxyError]),
    );

    try {
      const result = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "get_telemetry",
            session_id: "brr_123",
            categories: ["network"],
            limit: 1,
          },
        }),
      );
      expect(result.items[0].data).toEqual({
        code: "payment_window_expired",
      });

      const { tools } = await client.listTools();
      const tool = tools.find(({ name }) => name === "manage_browsers");
      const categories = tool?.inputSchema.properties?.categories as
        | { description?: string }
        | undefined;
      expect(categories?.description).toContain("payment_window_expired");
      expect(categories?.description).toContain("raw_code");
    } finally {
      await close();
    }
  });

  test("documents bounded best-effort raw replay", async () => {
    const kernelClient = { browsers: {} };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find(({ name }) => name === "manage_browsers");
      const compact = tool?.inputSchema.properties?.compact as
        | { description?: string }
        | undefined;

      expect(compact?.description).toContain(
        "body, headers, post_data, or png",
      );
      expect(compact?.description).toContain("raw_replay_best_effort");
      expect(compact?.description).toContain(
        "late events or retention may change results",
      );
      expect(compact?.description).toContain("limit<=5");
      expect(compact?.description).toContain("1 mib");
    } finally {
      await close();
    }
  });
});

describe("manage_browsers proxy routes", () => {
  test("advertises create-only route selection and host matching", async () => {
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {},
    );
    try {
      const { tools } = await client.listTools();
      const browser = tools.find(({ name }) => name === "manage_browsers");
      const network = browser?.inputSchema.properties?.network as
        | { properties?: Record<string, unknown> }
        | undefined;
      const routes = network?.properties?.proxy_routes as
        | {
            description?: string;
            maxItems?: number;
            items?: {
              properties?: { hosts?: { minItems?: number; maxItems?: number } };
            };
          }
        | undefined;
      expect(routes?.maxItems).toBe(10);
      expect(routes?.items?.properties?.hosts).toMatchObject({
        minItems: 1,
        maxItems: 50,
      });
      expect(routes?.description).toContain("subdomains only, not the apex");
      expect(routes?.description).toContain("including to start_url");
      expect(routes?.description).toContain("fail closed");
    } finally {
      await close();
    }
  });

  test("passes routes and the top-level proxy through SDK create and returns the SDK network on create/get", async () => {
    const requests: unknown[] = [];
    const network = {
      proxy_routes: [
        { hosts: ["example.com", "*.example.org"], proxy: { id: "prx_route" } },
      ],
    };
    const browser = {
      session_id: "brr_123",
      leased_at: "2026-08-08T00:05:00Z",
      network,
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async (params: unknown) => {
            requests.push(params);
            return browser;
          },
          retrieve: async () => browser,
        },
      },
    );

    try {
      const routes = [
        { hosts: ["example.com", "*.example.org"], proxy_id: "prx_route" },
        { hosts: ["other.example.com"], proxy_name: "backup" },
      ];
      const created = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "create",
            proxy_id: "prx_default",
            proxy_routes: routes,
          },
        }),
      );
      expect(requests).toEqual([
        {
          proxy_id: "prx_default",
          network: {
            proxy_routes: [
              { hosts: routes[0].hosts, proxy: { id: "prx_route" } },
              { hosts: routes[1].hosts, proxy: { name: "backup" } },
            ],
          },
        },
      ]);
      expect(created.browser.network).toEqual(network);
      expect(created.browser.leased_at).toBe("2026-08-08T00:05:00Z");
      const retrieved = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: { action: "get", session_id: "brr_123" },
        }),
      );
      expect(retrieved.network).toEqual(network);
      expect(retrieved.leased_at).toBe("2026-08-08T00:05:00Z");
    } finally {
      await close();
    }
  });

  test("rejects invalid route selectors and bounded arrays before SDK create", async () => {
    let creates = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async () => {
            creates++;
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const invalid = [
        [{ hosts: ["example.com"] }],
        [{ hosts: ["example.com"], proxy_id: "one", proxy_name: "two" }],
        [{ hosts: [], proxy_id: "one" }],
        [{ hosts: Array(51).fill("example.com"), proxy_id: "one" }],
        Array.from({ length: 11 }, () => ({
          hosts: ["example.com"],
          proxy_id: "one",
        })),
      ];
      for (const proxy_routes of invalid) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: { action: "create", proxy_routes },
        });
        expect(result.isError).toBe(true);
      }
      expect(creates).toBe(0);
    } finally {
      await close();
    }
  });

  test("passes network.proxy_routes through SDK create unchanged", async () => {
    const requests: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async (params: unknown) => {
            requests.push(params);
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const network = {
        private_hosts: ["*.preview.example.ts.net", "100.64.0.0/10"],
        proxy_routes: [
          { hosts: ["example.com"], proxy: { id: "prx_route" } },
          { hosts: ["*.example.org"], proxy: { name: "backup" } },
        ],
      };
      for (const args of [
        { proxy: { name: "default" }, network },
        { network: { private_hosts: [] } },
      ]) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: { action: "create", ...args },
        });
        expect(result.isError).toBeFalsy();
      }
      expect(requests).toEqual([
        { proxy: { name: "default" }, network },
        { network: { private_hosts: [] } },
      ]);
    } finally {
      await close();
    }
  });

  test("rejects invalid network routes before SDK create", async () => {
    let creates = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async () => {
            creates++;
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          {
            network: { proxy_routes: [{ hosts: ["example.com"], proxy: {} }] },
          },
          "network.proxy_routes[0].proxy requires exactly one of id or name",
        ],
        [
          {
            network: {
              proxy_routes: [
                {
                  hosts: ["example.com"],
                  proxy: { id: "prx_route", name: "backup" },
                },
              ],
            },
          },
          "network.proxy_routes[0].proxy requires exactly one of id or name",
        ],
        [
          {
            network: { proxy_routes: [] },
            proxy_routes: [{ hosts: ["example.com"], proxy_id: "prx_route" }],
          },
          "network cannot be combined with proxy_routes",
        ],
      ];
      for (const [args, message] of cases) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: { action: "create", ...args },
        });
        expect(result.isError).toBe(true);
        expect(toolResultText(result)).toContain(message);
      }
      expect(creates).toBe(0);
    } finally {
      await close();
    }
  });

  test.each([
    { memory: "16GiB" },
    { video_memory: "4GiB" },
    { region: "us-west" },
  ])("rejects creation-only %p on update", async (extra) => {
    let updates = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          update: async () => {
            updates++;
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: { action: "update", session_id: "brr_123", ...extra },
      });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toBe(
        "error: memory, video_memory, and region are creation-only.",
      );
      expect(updates).toBe(0);
    } finally {
      await close();
    }
  });

  test("rejects routes on update without calling the SDK", async () => {
    let updates = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          update: async () => {
            updates++;
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "update",
          session_id: "brr_123",
          name: "renamed",
          proxy_routes: [{ hosts: ["example.com"], proxy_id: "prx_route" }],
        },
      });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toContain("creation-only");
      expect(updates).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers egress allowlist", () => {
  test("advertises a bounded allowlist that update can clear with null", async () => {
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {},
    );
    try {
      const { tools } = await client.listTools();
      const browser = tools.find(({ name }) => name === "manage_browsers");
      const network = browser?.inputSchema.properties?.network as
        | { properties?: Record<string, unknown> }
        | undefined;
      const allowedHosts = network?.properties?.allowed_hosts as
        | { anyOf?: unknown[]; description?: string }
        | undefined;
      expect(allowedHosts?.anyOf).toContainEqual(
        expect.objectContaining({ type: "array", minItems: 1, maxItems: 100 }),
      );
      expect(allowedHosts?.anyOf).toContainEqual({ type: "null" });
      expect(allowedHosts?.description).toContain("network_policy_denied");
      expect(allowedHosts?.description).toContain("null removes it");
    } finally {
      await close();
    }
  });

  test("passes network.allowed_hosts through SDK create", async () => {
    const requests: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async (params: unknown) => {
            requests.push(params);
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const network = {
        private_hosts: ["*.preview.example.ts.net"],
        allowed_hosts: ["example.com", "*.example.com", "8.8.8.8"],
      };
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "create",
          start_url: "https://example.com",
          network,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(requests).toEqual([{ network, start_url: "https://example.com" }]);
    } finally {
      await close();
    }
  });

  test("replaces or removes the allowlist through SDK update", async () => {
    const updates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          update: async (sessionId: string, params: unknown) => {
            updates.push([sessionId, params]);
            return { session_id: sessionId };
          },
        },
      },
    );
    try {
      for (const allowed_hosts of [["example.com"], null]) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "update",
            session_id: "brr_123",
            network: { allowed_hosts },
          },
        });
        expect(result.isError).toBeFalsy();
      }
      expect(updates).toEqual([
        ["brr_123", { network: { allowed_hosts: ["example.com"] } }],
        ["brr_123", { network: { allowed_hosts: null } }],
      ]);
    } finally {
      await close();
    }
  });

  test("rejects invalid allowlist requests without calling the SDK", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
          update: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const cases: Array<[Record<string, unknown>, string?]> = [
        [{ action: "create", network: { allowed_hosts: null } }, "update-only"],
        [{ action: "create", network: { allowed_hosts: [] } }],
        [
          {
            action: "create",
            network: { allowed_hosts: Array(101).fill("example.com") },
          },
        ],
        [
          {
            action: "update",
            session_id: "brr_123",
            network: { allowed_hosts: ["example.com"], private_hosts: [] },
          },
          "creation-only",
        ],
        [
          {
            action: "update",
            session_id: "brr_123",
            network: { proxy_routes: [] },
          },
          "creation-only",
        ],
        [
          { action: "update", session_id: "brr_123", network: {} },
          "at least one update field is required",
        ],
      ];
      for (const [args, message] of cases) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: args,
        });
        expect(result.isError).toBe(true);
        if (message) expect(toolResultText(result)).toContain(message);
      }
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers proxy", () => {
  test("passes the proxy config through SDK create and update", async () => {
    const creates: unknown[] = [];
    const updates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async (params: unknown) => {
            creates.push(params);
            return { session_id: "brr_123" };
          },
          update: async (sessionId: string, params: unknown) => {
            updates.push([sessionId, params]);
            return { session_id: sessionId };
          },
        },
      },
    );
    try {
      for (const proxy of [{ name: "residential" }, { id: "prx_123" }]) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: { action: "create", proxy },
        });
        expect(result.isError).toBeFalsy();
      }
      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "update",
          session_id: "brr_123",
          proxy: { mode: "direct" },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(creates).toEqual([
        { proxy: { name: "residential" } },
        { proxy: { id: "prx_123" } },
      ]);
      expect(updates).toEqual([["brr_123", { proxy: { mode: "direct" } }]]);
    } finally {
      await close();
    }
  });

  test("rejects ambiguous proxy selection without calling the SDK", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
          update: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
        },
      },
    );
    try {
      const invalid = [
        { action: "create", proxy: {} },
        { action: "create", proxy: { id: "prx_123", name: "residential" } },
        {
          action: "create",
          proxy: { name: "residential" },
          proxy_id: "prx_123",
        },
        {
          action: "update",
          session_id: "brr_123",
          proxy: { name: "residential" },
          clear_proxy: true,
        },
        {
          action: "update",
          session_id: "brr_123",
          proxy: { mode: "default" },
          disable_default_proxy: false,
        },
      ];
      for (const args of invalid) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: args,
        });
        expect(result.isError).toBe(true);
      }
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers location, memory, and conditional allowlists", () => {
  test("forwards create and update fields including false and null", async () => {
    const creates: unknown[] = [];
    const updates: unknown[] = [];
    const revision = "a".repeat(64);
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async (params: unknown) => {
            creates.push(params);
            return { session_id: "brr_123" };
          },
          update: async (sessionId: string, params: unknown) => {
            updates.push([sessionId, params]);
            return { session_id: sessionId };
          },
        },
      },
    );

    try {
      const telemetry = {
        enabled: true,
        browser: {
          control: { enabled: false },
          screenshot: { enabled: true },
        },
        export: {
          otlp: { destination: { id: "otel_1" } },
        },
        storage: { enabled: false },
      };
      const extensions = [{ id: "ext_1" }, { name: "second-extension" }];
      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "create",
          headless: false,
          memory: "8GiB",
          extensions,
          telemetry,
          location: {
            timezone: "America/Los_Angeles",
            locale: "en-US",
          },
        },
      });
      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "create",
          gpu: true,
          video_memory: "4GiB",
        },
      });
      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "update",
          session_id: "brr_123",
          location: { timezone: null, locale: "fr-FR" },
          telemetry: { enabled: false },
          network: {
            allowed_hosts: null,
            expected_allowlist_revision: revision,
            mutation_id: "allowlist_retry_0",
          },
        },
      });

      expect(creates).toEqual([
        {
          headless: false,
          memory: "8GiB",
          extensions,
          telemetry,
          location: {
            timezone: "America/Los_Angeles",
            locale: "en-US",
          },
        },
        { gpu: true, video_memory: "4GiB" },
      ]);
      expect(updates).toEqual([
        [
          "brr_123",
          {
            location: { timezone: null, locale: "fr-FR" },
            telemetry: { enabled: false },
            network: {
              allowed_hosts: null,
              expected_allowlist_revision: revision,
              mutation_id: "allowlist_retry_0",
            },
          },
        ],
      ]);
    } finally {
      await close();
    }
  });

  test("requires the conditional allowlist pair and keeps null out of create", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
          update: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
        },
      },
    );

    try {
      for (const arguments_ of [
        {
          action: "create",
          location: { timezone: null },
        },
        {
          action: "update",
          session_id: "brr_123",
          network: {
            allowed_hosts: ["example.com"],
            expected_allowlist_revision: "a".repeat(64),
          },
        },
        {
          action: "create",
          telemetry: { enabled: true },
          telemetry_network: false,
        },
        {
          action: "create",
          extensions: [{ id: "ext_1" }],
          extension_name: "legacy-extension",
        },
      ]) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
      }
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });

  test("forwards include_deleted=false on get", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          retrieve: async (...args: unknown[]) => {
            calls.push(args);
            return { session_id: "brr_deleted" };
          },
        },
      },
    );

    try {
      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "get",
          session_id: "brr_deleted",
          include_deleted: false,
        },
      });
      expect(calls).toEqual([["brr_deleted", { include_deleted: false }]]);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers fingerprint overrides", () => {
  test("advertises and forwards the closed-beta macos override with required false values", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async (params: unknown) => {
            creates.push(params);
            return { session_id: "brr_123" };
          },
        },
      },
    );

    try {
      const { tools } = await client.listTools();
      const browser = tools.find(({ name }) => name === "manage_browsers");
      const fingerprint = browser?.inputSchema.properties?.fingerprint as
        | {
            description?: string;
            properties?: { os?: { const?: string; description?: string } };
          }
        | undefined;
      expect(fingerprint?.properties?.os).toMatchObject({ const: "macos" });
      expect(fingerprint?.description).toContain("closed beta");
      expect(fingerprint?.description).toContain("headless=false");
      expect(fingerprint?.description).toContain("gpu=false");
      expect(fingerprint?.description).toContain("omitted memory");

      const result = await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "create",
          fingerprint: { os: "macos" },
          stealth: true,
          headless: false,
          gpu: false,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(creates).toEqual([
        {
          fingerprint: { os: "macos" },
          stealth: true,
          headless: false,
          gpu: false,
        },
      ]);
    } finally {
      await close();
    }
  });

  test("rejects invalid or update-time fingerprint overrides before the SDK", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          create: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
          update: async () => {
            calls++;
            return { session_id: "brr_123" };
          },
        },
      },
    );

    try {
      for (const arguments_ of [
        {
          action: "create",
          fingerprint: { os: "macos" },
          stealth: true,
          headless: false,
          gpu: false,
          memory: "8GiB",
        },
        {
          action: "create",
          fingerprint: { os: "macos" },
          stealth: true,
          headless: true,
          gpu: false,
        },
        {
          action: "update",
          session_id: "brr_123",
          fingerprint: { os: "macos" },
        },
      ]) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
      }
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers region", () => {
  test("passes region to create and list", async () => {
    const createCalls: unknown[] = [];
    const listCalls: unknown[] = [];
    const kernelClient = {
      browsers: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return { session_id: "brr_123" };
        },
        list: async (params: unknown) => {
          listCalls.push(params);
          return {
            getPaginatedItems: () => [
              {
                session_id: "brr_eu",
                leased_at: "2026-08-08T00:05:00Z",
                cdp_ws_url: "ws://example.test",
              },
            ],
            has_more: false,
            next_offset: null,
          };
        },
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      const created = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: { action: "create", region: "eu-west", stealth: true },
        }),
      );
      expect(createCalls).toEqual([{ stealth: true, region: "eu-west" }]);
      expect(created.browser.session_id).toBe("brr_123");

      const listed = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: { action: "list", region: "eu-west" },
        }),
      );
      expect(listCalls).toEqual([{ region: "eu-west" }]);
      expect(listed.items).toEqual([
        {
          session_id: "brr_eu",
          leased_at: "2026-08-08T00:05:00Z",
        },
      ]);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers save profile", () => {
  test("advertises the restart and destination contract", async () => {
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {},
    );

    try {
      const { tools } = await client.listTools();
      const browser = tools.find(({ name }) => name === "manage_browsers");
      const action = browser?.inputSchema.properties?.action as
        | { enum?: string[] }
        | undefined;
      const profileId = browser?.inputSchema.properties?.profile_id as
        | { minLength?: number; description?: string }
        | undefined;
      const profileName = browser?.inputSchema.properties?.profile_name as
        | {
            minLength?: number;
            maxLength?: number;
            pattern?: string;
            description?: string;
          }
        | undefined;

      expect(action?.enum).toContain("save_profile");
      expect(profileId).toMatchObject({ minLength: 1 });
      expect(profileId?.description).toContain(
        "existing destination profile id to overwrite",
      );
      expect(profileName).toMatchObject({
        minLength: 1,
        maxLength: 255,
        pattern: "^[a-zA-Z0-9._-]{1,255}$",
      });
      expect(profileName?.description).toContain(
        "create when no matching profile exists",
      );
      expect(browser?.description).toContain("leased_at");
      expect(browser?.description).toContain(
        "active cdp, playwright, and webdriver connections close and must reconnect",
      );
      expect(browser?.description).toContain(
        "call save_profile at a stable point, such as right after a login completes",
      );
      expect(browser?.description).toContain(
        "a browser_busy conflict is temporary; retry the call",
      );
      expect(browser?.description).toContain(
        "browser_not_active (the browser is no longer running) are not retryable",
      );
      expect(browser?.description).toContain(
        "caches, service worker storage, and google drive indexeddb data are omitted",
      );
      expect(browser?.description).toContain("the most recently started wins");
      expect(browser?.description).toContain(
        "a successful save restarts timeout_seconds",
      );
    } finally {
      await close();
    }
  });

  test("forwards exactly one destination by id or name", async () => {
    const calls: unknown[] = [];
    const requestOptions: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          saveProfile: async (
            sessionId: string,
            destination: { id?: string; name?: string },
            options?: { maxRetries?: number; timeout?: number },
          ) => {
            calls.push([sessionId, destination]);
            requestOptions.push({
              maxRetries: options?.maxRetries,
              timeout: options?.timeout,
            });
            return {
              id: destination.id ?? "prf_created_from_name",
              name: destination.name ?? "existing-profile",
            };
          },
        },
      },
    );

    try {
      const byId = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "save_profile",
            session_id: "checkout-flow",
            profile_id: "prf_existing",
          },
        }),
      );
      const byName = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "save_profile",
            session_id: "brr_123",
            profile_name: "checkout.snapshot-1",
          },
        }),
      );

      expect(calls).toEqual([
        ["checkout-flow", { id: "prf_existing" }],
        ["brr_123", { name: "checkout.snapshot-1" }],
      ]);
      // A slow save must not time out at the SDK default or start a second save.
      expect(requestOptions).toEqual([
        { maxRetries: 0, timeout: 190_000 },
        { maxRetries: 0, timeout: 190_000 },
      ]);
      expect(byId).toEqual({
        id: "prf_existing",
        name: "existing-profile",
      });
      expect(byName).toEqual({
        id: "prf_created_from_name",
        name: "checkout.snapshot-1",
      });
    } finally {
      await close();
    }
  });

  test("rejects missing, ambiguous, and inapplicable save inputs", async () => {
    let saves = 0;
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      {
        browsers: {
          saveProfile: async () => {
            saves++;
            return { id: "prf_123", name: "profile" };
          },
        },
      },
    );

    try {
      const cases: Array<Record<string, unknown>> = [
        { action: "save_profile", profile_id: "prf_123" },
        { action: "save_profile", session_id: "brr_123" },
        {
          action: "save_profile",
          session_id: "brr_123",
          profile_id: "prf_123",
          profile_name: "profile",
        },
        {
          action: "save_profile",
          session_id: "brr_123",
          profile_id: "prf_123",
          save_profile_changes: false,
        },
        {
          action: "save_profile",
          session_id: "brr_123",
          profile_name: "invalid profile name",
        },
        {
          action: "save_profile",
          session_id: "brr_123",
          profile_id: "",
        },
        {
          action: "save_profile",
          session_id: "brr_123",
          profile_name: "x".repeat(256),
        },
      ];

      for (const arguments_ of cases) {
        const result = await client.callTool({
          name: "manage_browsers",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
      }
      expect(saves).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers id or name", () => {
  test("passes name and tags through create and update", async () => {
    const createCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const kernelClient = {
      browsers: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return { session_id: "brr_123", name: "checkout-flow" };
        },
        update: async (idOrName: string, params: unknown) => {
          updateCalls.push([idOrName, params]);
          return {
            session_id: "brr_123",
            leased_at: "2026-08-08T00:05:00Z",
          };
        },
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "create",
          name: "checkout-flow",
          tags: { team: "payments" },
        },
      });
      expect(createCalls).toEqual([
        { name: "checkout-flow", tags: { team: "payments" } },
      ]);

      const updated = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "update",
            session_id: "checkout-flow",
            name: "checkout-flow-2",
            tags: {},
            start_url: "https://example.com/checkout",
          },
        }),
      );
      expect(updated.browser.leased_at).toBe("2026-08-08T00:05:00Z");
      expect(updateCalls).toEqual([
        [
          "checkout-flow",
          {
            name: "checkout-flow-2",
            tags: {},
            start_url: "https://example.com/checkout",
          },
        ],
      ]);

      await client.callTool({
        name: "manage_browsers",
        arguments: { action: "update", session_id: "brr_123", name: "" },
      });
      expect(updateCalls[1]).toEqual(["brr_123", { name: "" }]);
    } finally {
      await close();
    }
  });

  test("passes query and tags filters to list", async () => {
    const listCalls: unknown[] = [];
    const kernelClient = {
      browsers: {
        list: async (params: unknown) => {
          listCalls.push(params);
          return {
            getPaginatedItems: () => [],
            has_more: false,
            next_offset: null,
          };
        },
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "list",
          query: "checkout",
          tags: { team: "payments" },
        },
      });
      expect(listCalls).toEqual([
        { query: "checkout", tags: { team: "payments" } },
      ]);
    } finally {
      await close();
    }
  });

  test("forwards a session name unchanged to get and delete", async () => {
    const seen: string[] = [];
    const kernelClient = {
      browsers: {
        retrieve: async (idOrName: string) => {
          seen.push(`get:${idOrName}`);
          return { session_id: "brr_123", name: idOrName };
        },
        deleteByID: async (idOrName: string) => {
          seen.push(`delete:${idOrName}`);
        },
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      const got = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: { action: "get", session_id: "checkout-flow" },
        }),
      );
      expect(got.session_id).toBe("brr_123");
      await client.callTool({
        name: "manage_browsers",
        arguments: { action: "delete", session_id: "checkout-flow" },
      });
      expect(seen).toEqual(["get:checkout-flow", "delete:checkout-flow"]);
    } finally {
      await close();
    }
  });
});

describe("manage_browsers next actions", () => {
  test("leads the post-create hint with the preference order", async () => {
    const kernelClient = {
      browsers: {
        create: async () => ({ session_id: "brr_123" }),
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      const created = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: { action: "create" },
        }),
      );
      const hint: string = created.next_actions[0];
      expect(hint).toContain("brr_123");
      expect(hint).toContain("webmcp");
      expect(hint.indexOf("webmcp")).toBeLessThan(
        hint.indexOf("computer_action"),
      );
    } finally {
      await close();
    }
  });
});

describe("browser resources", () => {
  test("uses injected dependencies", async () => {
    const kernelClient = {
      browsers: {
        list: async function* () {
          yield { session_id: "brr_123" };
        },
        retrieve: async (sessionId: string) => ({ session_id: sessionId }),
      },
    };
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
    );

    try {
      const collection = (await client.readResource({
        uri: "kernel://orgs/org_test/projects/proj_test/browsers",
      })) as TextResourceResult;
      const item = (await client.readResource({
        uri: "kernel://orgs/org_test/projects/proj_test/browsers/brr_123",
      })) as TextResourceResult;

      expect(JSON.parse(collection.contents[0].text)).toEqual([
        { session_id: "brr_123" },
      ]);
      expect(JSON.parse(item.contents[0].text)).toEqual({
        session_id: "brr_123",
      });
    } finally {
      await close();
    }
  });
});
