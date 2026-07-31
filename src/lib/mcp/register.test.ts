import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "@/lib/mcp/register";

const NON_AUTH_TOOLSETS = [
  "profiles",
  "docs",
  "browsers",
  "projects",
  "api_keys",
  "browser_pools",
  "browser_curl",
  "proxies",
  "extensions",
  "apps",
  "computer",
  "shell",
  "playwright",
  "replays",
  "credentials",
  "credential_providers",
].join(",");

function captureRegistration(mcpApps: boolean) {
  const legacyTools: string[] = [];
  const appTools: string[] = [];
  const resources: string[] = [];
  const server = {
    prompt() {},
    tool(name: string) {
      legacyTools.push(name);
    },
    registerTool(name: string) {
      appTools.push(name);
      return { enable() {}, disable() {} };
    },
    registerResource(name: string) {
      resources.push(name);
      return { enable() {}, disable() {} };
    },
  } as unknown as McpServer;
  registerMcpCapabilities(server, { mcpApps });
  return { legacyTools, appTools, resources };
}

describe("MCP Apps additive registration", () => {
  test("keeps managed auth unchanged and only adds the App tools for capable clients", () => {
    const previous = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
    process.env.KERNEL_MCP_DISABLED_TOOLSETS = NON_AUTH_TOOLSETS;
    try {
      const base = captureRegistration(false);
      expect(base.legacyTools).toEqual(["manage_auth_connections"]);
      expect(base.appTools).toEqual([]);
      expect(base.resources).toEqual([]);

      const withApps = captureRegistration(true);
      expect(withApps.legacyTools).toEqual(["manage_auth_connections"]);
      expect(withApps.appTools).toEqual([
        "open_auth_login",
        "begin_auth_login",
      ]);
      expect(withApps.resources).toEqual(["kernel-managed-auth-login"]);
    } finally {
      if (previous === undefined) {
        delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
      } else {
        process.env.KERNEL_MCP_DISABLED_TOOLSETS = previous;
      }
    }
  });
});
