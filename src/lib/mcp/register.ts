import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import { registerKernelPrompts } from "@/lib/mcp/prompts";
import { registerAPIKeyCapabilities } from "@/lib/mcp/tools/api-keys";
import { registerAppCapabilities } from "@/lib/mcp/tools/apps";
import { registerAuthConnectionTools } from "@/lib/mcp/tools/auth-connections";
import { registerAuthLoginApp } from "@/lib/mcp/tools/auth-login-app";
import { registerBrowserPoolCapabilities } from "@/lib/mcp/tools/browser-pools";
import { registerBrowserCurlTool } from "@/lib/mcp/tools/browser-curl";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";
import { registerComputerActionTool } from "@/lib/mcp/tools/computer-action";
import { registerConnectionContextTool } from "@/lib/mcp/tools/connection-context";
import { registerCredentialProviderTools } from "@/lib/mcp/tools/credential-providers";
import { registerCredentialTools } from "@/lib/mcp/tools/credentials";
import { registerDocsTools } from "@/lib/mcp/tools/docs";
import { registerExtensionTools } from "@/lib/mcp/tools/extensions";
import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";
import { registerProfileCapabilities } from "@/lib/mcp/tools/profiles";
import { registerProjectCapabilities } from "@/lib/mcp/tools/projects";
import { registerProxyTools } from "@/lib/mcp/tools/proxies";
import { registerReplayTools } from "@/lib/mcp/tools/replays";
import { registerShellTool } from "@/lib/mcp/tools/shell";
type McpToolOptions = McpDependencies;
type McpRegistrationOptions = {
  mcpApps?: boolean;
  dependencies?: McpDependencies;
};
type RegisterMcpToolset = (server: McpServer, options: McpToolOptions) => void;

function registerManagedAuthCapabilities(server: McpServer) {
  registerAuthConnectionTools(server);
}

const mcpToolRegistrations = [
  ["profiles", registerProfileCapabilities],
  ["docs", registerDocsTools],
  ["browsers", registerBrowserCapabilities],
  ["projects", registerProjectCapabilities],
  ["api_keys", registerAPIKeyCapabilities],
  ["browser_pools", registerBrowserPoolCapabilities],
  ["browser_curl", registerBrowserCurlTool],
  ["proxies", registerProxyTools],
  ["extensions", registerExtensionTools],
  ["apps", registerAppCapabilities],
  ["computer", registerComputerActionTool],
  ["shell", registerShellTool],
  ["playwright", registerPlaywrightTool],
  ["replays", registerReplayTools],
  ["auth_connections", registerManagedAuthCapabilities],
  ["credentials", registerCredentialTools],
  ["credential_providers", registerCredentialProviderTools],
] as const satisfies readonly (readonly [string, RegisterMcpToolset])[];

type McpToolset = (typeof mcpToolRegistrations)[number][0];

const mcpToolsets = mcpToolRegistrations.map(([toolset]) => toolset);
const mcpToolsetSet: ReadonlySet<string> = new Set(mcpToolsets);

const standaloneToolsetAliases: Partial<Record<string, McpToolset>> = {
  computer_action: "computer",
  search_docs: "docs",
  execute_playwright_code: "playwright",
  exec_command: "shell",
  browser_utilities: "browser_curl",
  open_auth_login: "auth_connections",
};

function isMcpToolset(value: string): value is McpToolset {
  return mcpToolsetSet.has(value);
}

function resolveMcpToolset(token: string): McpToolset | undefined {
  if (isMcpToolset(token)) return token;
  return standaloneToolsetAliases[token];
}

function normalizeMcpToolset(value: string): McpToolset | undefined {
  const token = value.trim().toLowerCase().replace(/-/g, "_");
  const toolset = resolveMcpToolset(token);
  if (toolset) return toolset;

  const managePrefix = "manage_";
  if (token.startsWith(managePrefix)) {
    return resolveMcpToolset(token.slice(managePrefix.length));
  }

  return undefined;
}

function enabledMcpToolsetsFromEnv() {
  const raw = process.env.KERNEL_MCP_ENABLED_TOOLSETS;
  if (!raw?.trim()) return undefined;

  const enabled = new Set<McpToolset>();
  const unknown: string[] = [];
  for (const value of raw.split(/[,\s]+/)) {
    const token = value.trim().toLowerCase();
    if (!token || token === "none") continue;
    if (token === "all") return new Set<McpToolset>(mcpToolsets);

    const toolset = normalizeMcpToolset(token);
    if (toolset) {
      enabled.add(toolset);
    } else {
      unknown.push(value);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown KERNEL_MCP_ENABLED_TOOLSETS value(s): ${unknown.join(", ")}. Supported toolsets: ${mcpToolsets.join(", ")}.`,
    );
  }
  return enabled;
}

function disabledMcpToolsetsFromEnv() {
  const raw = process.env.KERNEL_MCP_DISABLED_TOOLSETS;
  if (!raw?.trim()) return new Set<McpToolset>();

  const disabled = new Set<McpToolset>();
  let disableAll = false;
  const unknown: string[] = [];

  for (const value of raw.split(/[,\s]+/)) {
    const token = value.trim().toLowerCase();
    if (!token || token === "none") continue;
    if (token === "all") {
      disableAll = true;
      continue;
    }

    const toolset = normalizeMcpToolset(token);
    if (toolset) {
      disabled.add(toolset);
    } else {
      unknown.push(value);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown KERNEL_MCP_DISABLED_TOOLSETS value(s): ${unknown.join(", ")}. Supported toolsets: ${mcpToolsets.join(", ")}.`,
    );
  }

  if (disableAll) return new Set<McpToolset>(mcpToolsets);

  return disabled;
}

function toolsetEnabled(
  enabledToolsets: Set<McpToolset> | undefined,
  disabledToolsets: Set<McpToolset>,
  toolset: McpToolset,
) {
  return (
    (enabledToolsets === undefined || enabledToolsets.has(toolset)) &&
    !disabledToolsets.has(toolset)
  );
}

export function registerMcpCapabilities(
  server: McpServer,
  {
    mcpApps = false,
    dependencies = defaultMcpDependencies,
  }: McpRegistrationOptions = {},
) {
  const enabledToolsets = enabledMcpToolsetsFromEnv();
  const disabledToolsets = disabledMcpToolsetsFromEnv();

  registerKernelPrompts(server);
  // Connection metadata remains available so clients can select the correct
  // project target even when other toolsets are disabled.
  registerConnectionContextTool(server);

  for (const [toolset, registerToolset] of mcpToolRegistrations) {
    if (toolsetEnabled(enabledToolsets, disabledToolsets, toolset)) {
      registerToolset(server, dependencies);
    }
  }

  // Managed Auth remains fully programmatic for every client. MCP Apps support
  // adds one interactive launcher (plus its app-only implementation tools and
  // resource) without replacing or narrowing manage_auth_connections.
  if (
    mcpApps &&
    toolsetEnabled(enabledToolsets, disabledToolsets, "auth_connections")
  ) {
    registerAuthLoginApp(server);
  }
}
