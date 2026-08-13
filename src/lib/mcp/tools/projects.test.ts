/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerProjectCapabilities } from "@/lib/mcp/tools/projects";

describe("manage_projects", () => {
  test("requires project or project_id for get", async () => {
    const { client, close } = await connectTestMcp(
      registerProjectCapabilities,
      {},
    );
    try {
      const result = await client.callTool({
        name: "manage_projects",
        arguments: { action: "get" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Error: project or project_id is required for get.",
        },
      ]);
    } finally {
      await close();
    }
  });

  test("rejects an empty project selector", async () => {
    const { client, close } = await connectTestMcp(
      registerProjectCapabilities,
      {},
    );
    try {
      const result = await client.callTool({
        name: "manage_projects",
        arguments: { action: "get", project: "", project_id: "proj_123" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
