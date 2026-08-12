/// <reference types="bun-types" />

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

function telemetryClient(queries: unknown[]) {
  return {
    browsers: {
      telemetry: {
        events: async (_sessionId: string, query: unknown) => {
          queries.push(query);
          return {
            getPaginatedItems: () => [event],
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
  test("re-fetches the same cursor page without compaction", async () => {
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
          arguments: compact.raw_replay as Record<string, unknown>,
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
      expect(compact.raw_replay).toMatchObject({
        ...page,
        compact: false,
      });
      expect(Date.parse(compact.raw_replay.until as string)).toBeNumber();
      expect(raw).toEqual({
        items: [event],
        has_more: true,
        next_offset: 43,
      });
      expect(queries).toHaveLength(2);
      expect(queries[1]).toEqual(queries[0]);
    } finally {
      await close();
    }
  });

  test("pins an offset-less newest-first page for raw replay", async () => {
    const queries: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries),
    );

    try {
      const compact = toolResultJSON(
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
      await client.callTool({
        name: "manage_browsers",
        arguments: compact.raw_replay as Record<string, unknown>,
      });

      expect(compact.raw_replay).toMatchObject({
        action: "get_telemetry",
        session_id: "brr_123",
        categories: ["network"],
        limit: 1,
        order: "desc",
        compact: false,
      });
      expect(Date.parse(compact.raw_replay.until as string)).toBeNumber();
      expect(queries[1]).toEqual(queries[0]);
    } finally {
      await close();
    }
  });

  test("resolves relative windows once for raw replay", async () => {
    const queries: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      telemetryClient(queries),
    );

    try {
      const compact = toolResultJSON(
        await client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "get_telemetry",
            session_id: "brr_123",
            since: "30m",
            until: "5m",
            limit: 1,
          },
        }),
      );
      await client.callTool({
        name: "manage_browsers",
        arguments: compact.raw_replay as Record<string, unknown>,
      });

      const since = Date.parse(compact.raw_replay.since as string);
      const until = Date.parse(compact.raw_replay.until as string);
      expect(until - since).toBe(25 * 60 * 1_000);
      expect(queries[1]).toEqual(queries[0]);
    } finally {
      await close();
    }
  });

  test("documents compact telemetry recovery on the tool schema", async () => {
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
      expect(compact?.description).toContain("exact page");
      expect(compact?.description).toContain("raw_replay");
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
