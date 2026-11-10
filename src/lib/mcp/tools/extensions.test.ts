/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerExtensionTools } from "@/lib/mcp/tools/extensions";

describe("manage_extensions SDK parity", () => {
  test("forwards list filters and gets metadata without downloading", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerExtensionTools, {
      extensions: {
        list: async (params: unknown) => {
          calls.push(["list", params]);
          return {
            getPaginatedItems: () => [],
            has_more: false,
            next_offset: null,
          };
        },
        get: async (idOrName: string) => {
          calls.push(["get", idOrName]);
          return { id: "ext_1", name: idOrName, size_bytes: 0 };
        },
      },
    });
    try {
      await client.callTool({
        name: "manage_extensions",
        arguments: {
          action: "list",
          name: "ad-blocker",
          query: "block",
          limit: 5,
          offset: 0,
        },
      });
      const result = await client.callTool({
        name: "manage_extensions",
        arguments: { action: "get", id_or_name: "ad-blocker" },
      });

      expect(result.isError).toBeFalsy();
      expect(toolResultJSON(result)).toEqual({
        id: "ext_1",
        name: "ad-blocker",
        size_bytes: 0,
      });
      expect(calls).toEqual([
        ["list", { name: "ad-blocker", query: "block", limit: 5, offset: 0 }],
        ["get", "ad-blocker"],
      ]);
    } finally {
      await close();
    }
  });
});
