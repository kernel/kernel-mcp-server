import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerKernelPrompts } from "@/lib/mcp/prompts";
import { registerAPIKeyCapabilities } from "@/lib/mcp/tools/api-keys";
import { registerAppCapabilities } from "@/lib/mcp/tools/apps";
import { registerBrowserPoolCapabilities } from "@/lib/mcp/tools/browser-pools";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";
import { registerComputerActionTool } from "@/lib/mcp/tools/computer-action";
import { registerDocsTools } from "@/lib/mcp/tools/docs";
import { registerExtensionTools } from "@/lib/mcp/tools/extensions";
import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";
import { registerProfileCapabilities } from "@/lib/mcp/tools/profiles";
import { registerProjectCapabilities } from "@/lib/mcp/tools/projects";
import { registerProxyTools } from "@/lib/mcp/tools/proxies";
import { registerShellTool } from "@/lib/mcp/tools/shell";

type RegisterMcpToolset = (server: McpServer) => void;

const mcpToolRegistrations = [
  ["profiles", registerProfileCapabilities],
  ["docs", registerDocsTools],
  ["browsers", registerBrowserCapabilities],
  ["projects", registerProjectCapabilities],
  ["api_keys", registerAPIKeyCapabilities],
  ["browser_pools", registerBrowserPoolCapabilities],
  ["proxies", registerProxyTools],
  ["extensions", registerExtensionTools],
  ["apps", registerAppCapabilities],
  ["computer", registerComputerActionTool],
  ["shell", registerShellTool],
  ["playwright", registerPlaywrightTool],
] as const satisfies readonly (readonly [string, RegisterMcpToolset])[];

type McpToolset = (typeof mcpToolRegistrations)[number][0];

const mcpToolsets = mcpToolRegistrations.map(([toolset]) => toolset);
const mcpToolsetSet: ReadonlySet<string> = new Set(mcpToolsets);

const standaloneToolsetAliases: Partial<Record<string, McpToolset>> = {
  computer_action: "computer",
  search_docs: "docs",
  execute_playwright_code: "playwright",
  exec_command: "shell",
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
  disabledToolsets: Set<McpToolset>,
  toolset: McpToolset,
) {
  return !disabledToolsets.has(toolset);
}

export function registerMcpCapabilities(server: McpServer) {
  const disabledToolsets = disabledMcpToolsetsFromEnv();

  registerKernelPrompts(server);

  for (const [toolset, registerToolset] of mcpToolRegistrations) {
    if (toolsetEnabled(disabledToolsets, toolset)) {
      registerToolset(server);
    }
  }
}
