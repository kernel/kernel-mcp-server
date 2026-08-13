/// <reference types="bun-types" />

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { organizationWideAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import { registerProjectCapabilities } from "@/lib/mcp/tools/projects";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
};

type ToolHandler = (
  params: Record<string, unknown>,
  extra: { authInfo?: unknown },
) => Promise<ToolResult>;

function captureHandler() {
  let handler: ToolHandler | undefined;
  const server = {
    resource() {},
    tool(_name: string, ...args: unknown[]) {
      handler = args.at(-1) as ToolHandler;
    },
  } as unknown as McpServer;
  registerProjectCapabilities(server);
  if (!handler) throw new Error("manage_projects was not registered");
  return handler;
}

describe("manage_projects", () => {
  test("requires project or project_id for get", async () => {
    const result = await captureHandler()(
      { action: "get" },
      { authInfo: organizationWideAuthInfo() },
    );
    expect(result.content[0].text).toContain(
      "project or project_id is required",
    );
  });
});
