export const KERNEL_MCP_TOOL_NAMES = [
  "begin_auth_login",
  "browser_curl",
  "computer_action",
  "exec_command",
  "execute_playwright_code",
  "get_connection_context",
  "get_more_tools",
  "manage_api_keys",
  "manage_apps",
  "manage_auth_connections",
  "manage_browser_pools",
  "manage_browsers",
  "manage_credential_providers",
  "manage_credentials",
  "manage_extensions",
  "manage_profiles",
  "manage_projects",
  "manage_proxies",
  "manage_replays",
  "manage_vault_cards",
  "manage_vault_items",
  "manage_vault_provider_configs",
  "manage_vault_wallets",
  "manage_vaults",
  "open_auth_login",
  "search_docs",
  "submit_feedback",
  "webmcp",
] as const;

export type KernelMcpToolName = (typeof KERNEL_MCP_TOOL_NAMES)[number];

const kernelMcpToolNameSet: ReadonlySet<string> = new Set(
  KERNEL_MCP_TOOL_NAMES,
);

export function normalizeKernelMcpToolName(
  value: string,
): KernelMcpToolName | undefined {
  let candidate = value.trim().toLowerCase().replace(/-/g, "_");
  for (const prefix of [
    "mcp__kernel__",
    "kernel__",
    "mcp_kernel_",
    "kernel_",
  ]) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  return kernelMcpToolNameSet.has(candidate)
    ? (candidate as KernelMcpToolName)
    : undefined;
}
