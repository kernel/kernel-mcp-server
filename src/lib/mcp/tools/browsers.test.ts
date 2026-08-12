/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";

describe("manage_browsers telemetry", () => {
  test("re-fetches the same telemetry page without compaction", async () => {
    const event = {
      seq: 42,
      event: {
        ts: 1_700_000_000_000_000,
        category: "network",
        type: "network_response",
        source: { service: "cdp" },
        data: {
          headers: { "set-cookie": "secret" },
          post_data: "query=secret",
          body: '{"result":"complete"}',
          status: 200,
        },
      },
    };
    const queries: unknown[] = [];
    const kernelClient = {
      browsers: {
        list: async function* () {
          yield { session_id: "brr_123" };
        },
        retrieve: async (sessionId: string) => ({ session_id: sessionId }),
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
    const { client, close } = await connectTestMcp(
      registerBrowserCapabilities,
      kernelClient,
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
          arguments: { ...page, compact: false },
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
          omitted_fields: ["headers", "post_data", "body"],
        },
      ]);
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

      const collection = await client.readResource({
        uri: "kernel://orgs/org_test/projects/proj_test/browsers",
      });
      const item = await client.readResource({
        uri: "kernel://orgs/org_test/projects/proj_test/browsers/brr_123",
      });
      const collectionContent = collection.contents[0];
      const itemContent = item.contents[0];
      const collectionText =
        "text" in collectionContent ? collectionContent.text : "";
      const itemText = "text" in itemContent ? itemContent.text : "";
      expect(JSON.parse(collectionText)).toEqual([{ session_id: "brr_123" }]);
      expect(JSON.parse(itemText)).toEqual({ session_id: "brr_123" });
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
      expect(compact?.description).toContain("same categories, offset");
      expect(compact?.description).toContain("not next_offset");
    } finally {
      await close();
    }
  });
});
