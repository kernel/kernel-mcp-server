/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerProjectCapabilities } from "@/lib/mcp/tools/projects";

describe("manage_projects", () => {
  test("requires a non-empty project selector for get", async () => {
    const retrieveArgs: string[] = [];
    const { client, close } = await connectTestMcp(
      registerProjectCapabilities,
      {
        projects: {
          retrieve: async (idOrName: string) => {
            retrieveArgs.push(idOrName);
            return { id: idOrName };
          },
        },
      },
    );
    try {
      const missing = await client.callTool({
        name: "manage_projects",
        arguments: { action: "get" },
      });
      const empty = await client.callTool({
        name: "manage_projects",
        arguments: { action: "get", project: "", project_id: "proj_123" },
      });

      expect(missing.isError).toBe(true);
      expect(missing.content).toEqual([
        {
          type: "text",
          text: "Error: project or project_id is required for get.",
        },
      ]);
      expect(empty.isError).toBe(true);
      expect(retrieveArgs).toEqual([]);
    } finally {
      await close();
    }
  });

  test("retrieves by project name or deprecated project_id", async () => {
    const retrieveArgs: string[] = [];
    const { client, tokens, close } = await connectTestMcp(
      registerProjectCapabilities,
      {
        projects: {
          retrieve: async (idOrName: string) => {
            retrieveArgs.push(idOrName);
            return { id: idOrName };
          },
        },
      },
    );
    try {
      const byName = await client.callTool({
        name: "manage_projects",
        arguments: { action: "get", project: "billing" },
      });
      const byID = await client.callTool({
        name: "manage_projects",
        arguments: { action: "get", project_id: "proj_123" },
      });
      const both = await client.callTool({
        name: "manage_projects",
        arguments: {
          action: "get",
          project: "billing",
          project_id: "proj_123",
        },
      });

      expect(byName.isError).toBeUndefined();
      expect(byID.isError).toBeUndefined();
      expect(both.isError).toBeUndefined();
      expect(tokens).toEqual(["test-token", "test-token", "test-token"]);
      expect(retrieveArgs).toEqual(["billing", "proj_123", "billing"]);
      expect(toolResultJSON(byName)).toEqual({ id: "billing" });
      expect(toolResultJSON(byID)).toEqual({ id: "proj_123" });
      expect(toolResultJSON(both)).toEqual({ id: "billing" });
    } finally {
      await close();
    }
  });
});
