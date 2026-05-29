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

export function registerMcpCapabilities(server: McpServer) {
  registerProfileCapabilities(server);
  registerKernelPrompts(server);
  registerDocsTools(server);
  registerBrowserCapabilities(server);
  registerProjectCapabilities(server);
  registerAPIKeyCapabilities(server);
  registerBrowserPoolCapabilities(server);
  registerProxyTools(server);
  registerExtensionTools(server);
  registerAppCapabilities(server);
  registerComputerActionTool(server);
  registerShellTool(server);
  registerPlaywrightTool(server);
}
