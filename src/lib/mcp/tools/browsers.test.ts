/// <reference types="bun-types" />

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
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

function toolResultText(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
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
        "Raw screenshot PNGs are not available",
      );
      expect(queries).toHaveLength(1);
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
      expect(compact?.description).toContain("1 MiB");
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
              { session_id: "brr_eu", cdp_ws_url: "ws://example.test" },
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
      expect(listed.items).toEqual([{ session_id: "brr_eu" }]);
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
          return { session_id: "brr_123" };
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

      await client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "update",
          session_id: "checkout-flow",
          name: "checkout-flow-2",
          tags: {},
        },
      });
      expect(updateCalls).toEqual([
        ["checkout-flow", { name: "checkout-flow-2", tags: {} }],
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
