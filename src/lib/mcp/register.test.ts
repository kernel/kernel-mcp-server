import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { registerMcpCapabilities } from "@/lib/mcp/register";
import { KERNEL_MCP_TOOL_NAMES } from "@/lib/mcp/tool-names";

const NON_AUTH_TOOLSETS = [
  "profiles",
  "docs",
  "browsers",
  "projects",
  "api_keys",
  "browser_pools",
  "config_registry",
  "browser_curl",
  "proxies",
  "extensions",
  "apps",
  "computer",
  "shell",
  "playwright",
  "webmcp",
  "replays",
  "credentials",
  "credential_providers",
  "vaults",
].join(",");

async function captureRegistration(
  mcpApps: boolean,
  vaults = false,
  analytics = false,
) {
  const mcp = await connectTestMcp((server) => {
    registerMcpCapabilities(server, { mcpApps, vaults });
    if (analytics) instrumentMcpAnalytics(server, null);
  }, {});
  try {
    const { tools } = await mcp.client.listTools();
    const { resources } = await mcp.client.listResources();
    const appNames = new Set(["open_auth_login", "begin_auth_login"]);
    return {
      legacyTools: tools
        .filter((tool) => !appNames.has(tool.name))
        .map((tool) => tool.name),
      appTools: tools
        .filter((tool) => appNames.has(tool.name))
        .map((tool) => tool.name),
      resources: resources.map((resource) => resource.name),
      schemas: new Map(
        tools.map((tool) => [tool.name, tool.inputSchema.properties ?? {}]),
      ),
    };
  } finally {
    await mcp.close();
  }
}

describe("MCP tool ownership", () => {
  test("matches every registered KERNEL tool in both directions", async () => {
    const registration = await captureRegistration(true, true, true);
    const registeredTools = new Set([
      ...registration.legacyTools,
      ...registration.appTools,
    ]);
    const knownTools = new Set<string>(KERNEL_MCP_TOOL_NAMES);

    expect(
      [...registeredTools].filter((tool) => !knownTools.has(tool)),
    ).toEqual([]);
    expect(
      [...knownTools].filter((tool) => !registeredTools.has(tool)),
    ).toEqual([]);
  });
});

describe("MCP Apps additive registration", () => {
  test("keeps managed auth unchanged and only adds the App tools for capable clients", async () => {
    const previous = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
    process.env.KERNEL_MCP_DISABLED_TOOLSETS = NON_AUTH_TOOLSETS;
    try {
      const base = await captureRegistration(false);
      expect(base.legacyTools).toEqual([
        "get_connection_context",
        "manage_auth_connections",
      ]);
      expect(base.appTools).toEqual([]);
      expect(base.resources).toEqual([]);

      const withApps = await captureRegistration(true);
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

describe("MCP toolset allowlist", () => {
  test.each([false, true])(
    "requires vault access even with an allowlist (MCP Apps: %s)",
    async (mcpApps) => {
      const previousEnabled = process.env.KERNEL_MCP_ENABLED_TOOLSETS;
      const previousDisabled = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
      process.env.KERNEL_MCP_ENABLED_TOOLSETS = "vaults";
      delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
      try {
        expect((await captureRegistration(mcpApps)).legacyTools).toEqual([
          "get_connection_context",
        ]);
        expect((await captureRegistration(mcpApps, true)).legacyTools).toEqual([
          "get_connection_context",
          "manage_vault_provider_configs",
          "manage_vault_wallets",
          "manage_vault_cards",
          "manage_vault_credentials",
          "manage_vault_items",
          "manage_vaults",
        ]);
        process.env.KERNEL_MCP_DISABLED_TOOLSETS = "vaults";
        expect((await captureRegistration(mcpApps, true)).legacyTools).toEqual([
          "get_connection_context",
        ]);
      } finally {
        if (previousEnabled === undefined)
          delete process.env.KERNEL_MCP_ENABLED_TOOLSETS;
        else process.env.KERNEL_MCP_ENABLED_TOOLSETS = previousEnabled;
        if (previousDisabled === undefined)
          delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
        else process.env.KERNEL_MCP_DISABLED_TOOLSETS = previousDisabled;
      }
    },
  );

  test("keeps connection context and only the selected browser controls", async () => {
    const previousEnabled = process.env.KERNEL_MCP_ENABLED_TOOLSETS;
    const previousDisabled = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
    process.env.KERNEL_MCP_ENABLED_TOOLSETS =
      "execute_playwright_code computer_action";
    delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
    try {
      const registration = await captureRegistration(false);
      expect(registration.legacyTools).toEqual([
        "get_connection_context",
        "computer_action",
        "execute_playwright_code",
      ]);
      expect(registration.appTools).toEqual([]);
      expect(registration.resources).toEqual([]);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.KERNEL_MCP_ENABLED_TOOLSETS;
      } else {
        process.env.KERNEL_MCP_ENABLED_TOOLSETS = previousEnabled;
      }
      if (previousDisabled === undefined) {
        delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
      } else {
        process.env.KERNEL_MCP_DISABLED_TOOLSETS = previousDisabled;
      }
    }
  });
});

describe("project selection registration", () => {
  const projectScopedTools = [
    "manage_profiles",
    "manage_config_registry",
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
    "manage_vaults",
    "manage_vault_wallets",
    "manage_vault_cards",
    "manage_vault_credentials",
    "manage_vault_items",
    "open_auth_login",
    "begin_auth_login",
  ];

  test("advertises one stable project-aware tool contract", async () => {
    const registration = await captureRegistration(true, true);

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
