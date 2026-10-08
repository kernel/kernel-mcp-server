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
  "browser_files",
  "proxies",
  "extensions",
  "apps",
  "computer",
  "shell",
  "playwright",
  "repl",
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
  search = false,
) {
  const mcp = await connectTestMcp((server) => {
    registerMcpCapabilities(server, { mcpApps, vaults, search });
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
    const registration = await captureRegistration(true, true, true, true);
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

// [readOnlyHint, destructiveHint, openWorldHint], per the ChatGPT plugin
// submission guidelines: read-only only for pure retrieval, destructive for any
// delete/overwrite/cancel/stop, open world for public or arbitrary destinations.
const EXPECTED_ANNOTATIONS: Record<string, [boolean, boolean, boolean]> = {
  get_more_tools: [false, false, false],
  submit_feedback: [false, false, false],
  get_connection_context: [true, false, false],
  search_docs: [true, false, false],
  web_search: [true, false, true],
  manage_profiles: [false, true, true],
  manage_browsers: [false, true, false],
  manage_projects: [false, true, false],
  manage_api_keys: [false, true, false],
  manage_browser_pools: [false, true, false],
  manage_browser_files: [false, true, false],
  manage_config_registry: [false, true, true],
  browser_curl: [false, true, true],
  manage_proxies: [false, true, true],
  manage_extensions: [false, true, false],
  manage_apps: [false, true, true],
  computer_action: [false, true, true],
  exec_command: [false, true, true],
  execute_playwright_code: [false, true, true],
  manage_playwright_executors: [false, true, false],
  browser_repl: [false, true, true],
  webmcp: [false, true, true],
  manage_replays: [false, true, false],
  manage_auth_connections: [false, true, true],
  open_auth_login: [false, false, true],
  begin_auth_login: [false, false, true],
  manage_credentials: [false, true, false],
  manage_credential_providers: [false, true, true],
  manage_vaults: [false, true, true],
  manage_vault_items: [false, true, true],
  manage_vault_credentials: [false, true, true],
  manage_vault_cards: [false, true, true],
  manage_vault_wallets: [false, false, true],
  manage_vault_provider_configs: [false, true, true],
};

describe("MCP tool annotations", () => {
  test("sets every hint explicitly to the reviewed value", async () => {
    const mcp = await connectTestMcp((server) => {
      registerMcpCapabilities(server, {
        mcpApps: true,
        vaults: true,
        search: true,
      });
      instrumentMcpAnalytics(server, null);
    }, {});
    try {
      const { tools } = await mcp.client.listTools();
      const actual = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          [
            tool.annotations?.readOnlyHint,
            tool.annotations?.destructiveHint,
            tool.annotations?.openWorldHint,
          ],
        ]),
      );
      expect(actual).toEqual(EXPECTED_ANNOTATIONS);
    } finally {
      await mcp.close();
    }
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
    "requires search access with an allowlist (MCP Apps: %s)",
    async (mcpApps) => {
      const previousEnabled = process.env.KERNEL_MCP_ENABLED_TOOLSETS;
      const previousDisabled = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
      process.env.KERNEL_MCP_ENABLED_TOOLSETS = "web_search";
      delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
      try {
        expect((await captureRegistration(mcpApps)).legacyTools).toEqual([
          "get_connection_context",
        ]);
        expect(
          (await captureRegistration(mcpApps, false, false, true)).legacyTools,
        ).toEqual(["get_connection_context", "web_search"]);
        process.env.KERNEL_MCP_DISABLED_TOOLSETS = "web_search";
        expect(
          (await captureRegistration(mcpApps, false, false, true)).legacyTools,
        ).toEqual(["get_connection_context"]);
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
      "execute_playwright_code manage_playwright_executors browser_repl computer_action";
    delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;
    try {
      const registration = await captureRegistration(false);
      expect(registration.legacyTools).toEqual([
        "get_connection_context",
        "computer_action",
        "execute_playwright_code",
        "manage_playwright_executors",
        "browser_repl",
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
    "manage_browser_files",
    "manage_proxies",
    "manage_extensions",
    "manage_apps",
    "computer_action",
    "exec_command",
    "execute_playwright_code",
    "manage_playwright_executors",
    "browser_repl",
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
