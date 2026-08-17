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
  "browser_files",
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
  const schemas = new Map<string, Record<string, unknown>>();
  const server = {
    prompt() {},
    resource() {},
    tool(name: string, _description: string, inputSchema: object) {
      legacyTools.push(name);
      schemas.set(name, inputSchema as Record<string, unknown>);
    },
    registerTool(
      name: string,
      config: { inputSchema?: Record<string, unknown> },
    ) {
      appTools.push(name);
      schemas.set(name, config.inputSchema ?? {});
      return { enable() {}, disable() {} };
    },
    registerResource(name: string) {
      resources.push(name);
      return { enable() {}, disable() {} };
    },
  } as unknown as McpServer;
  registerMcpCapabilities(server, { mcpApps });
  return { legacyTools, appTools, resources, schemas };
}

describe("MCP Apps additive registration", () => {
  test("keeps managed auth unchanged and only adds the App tools for capable clients", () => {
    const previous = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
    process.env.KERNEL_MCP_DISABLED_TOOLSETS = NON_AUTH_TOOLSETS;
    try {
      const base = captureRegistration(false);
      expect(base.legacyTools).toEqual([
        "get_connection_context",
        "manage_auth_connections",
      ]);
      expect(base.appTools).toEqual([]);
      expect(base.resources).toEqual([]);

      const withApps = captureRegistration(true);
      expect(withApps.legacyTools).toEqual([
        "get_connection_context",
        "manage_auth_connections",
      ]);
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

describe("project selection registration", () => {
  const projectScopedTools = [
    "manage_profiles",
    "manage_browsers",
    "manage_browser_pools",
    "browser_curl",
    "manage_proxies",
    "manage_extensions",
    "manage_apps",
    "computer_action",
    "exec_command",
    "execute_playwright_code",
    "manage_replays",
    "manage_auth_connections",
    "manage_credentials",
    "open_auth_login",
    "begin_auth_login",
  ];

  test("advertises one stable project-aware tool contract", () => {
    const registration = captureRegistration(true);

    for (const name of projectScopedTools) {
      expect(registration.schemas.get(name)).toHaveProperty("project");
      expect(registration.schemas.get(name)).toHaveProperty("project_id");
    }

    expect(registration.schemas.get("manage_projects")).toHaveProperty(
      "project",
    );
    expect(registration.schemas.get("manage_projects")).toHaveProperty(
      "project_id",
    );

    for (const name of [
      "get_connection_context",
      "search_docs",
      "manage_credential_providers",
    ]) {
      expect(registration.schemas.get(name)).not.toHaveProperty("project");
      expect(registration.schemas.get(name)).not.toHaveProperty("project_id");
    }
  });
});
