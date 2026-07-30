import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasMcpAppsClient } from "@/lib/redis";

// MCP Apps (SEP-1865) extension identifier. Clients that render MCP Apps
// declare it in their initialize capabilities.
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

// Sliding TTL for the Redis capability marker. Long enough that an active App
// never loses it mid-flow; refreshed on every gated call.
const MCP_APPS_MARKER_TTL_SECONDS = 24 * 60 * 60;

/**
 * Whether a JSON-RPC payload (single message or batch) is an initialize that
 * declares MCP Apps support. The route layer uses this to record the client
 * capability, because the stateless streamable-HTTP transport does not expose
 * it to later requests.
 */
export function initializeDeclaresMcpApps(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const request = message as {
      method?: unknown;
      params?: { capabilities?: { extensions?: Record<string, unknown> } };
    };
    return (
      request.method === "initialize" &&
      Boolean(request.params?.capabilities?.extensions?.[MCP_APPS_EXTENSION])
    );
  });
}

/**
 * App-only tools are hidden from the model via `_meta.ui.visibility`, but that
 * is a hint hosts without MCP Apps support are free to ignore. Fail closed:
 * only execute them when the connected client actually declared the MCP Apps
 * extension. Persistent transports (SSE) expose client capabilities directly;
 * on the stateless streamable-HTTP transport the route layer records the
 * declared capability per bearer token at initialize time.
 */
export async function clientSupportsMcpApps(
  server: McpServer,
  authToken: string,
): Promise<boolean> {
  const capabilities = server.server.getClientCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined;
  if (capabilities?.extensions?.[MCP_APPS_EXTENSION]) return true;
  try {
    return await hasMcpAppsClient({
      token: authToken,
      ttlSeconds: MCP_APPS_MARKER_TTL_SECONDS,
    });
  } catch (error) {
    console.error("MCP Apps capability check failed; failing closed:", error);
    return false;
  }
}

/**
 * Returns null when the client may call app-only tools, otherwise a safe
 * denial message to return as an error response.
 */
export async function mcpAppsGateError(
  server: McpServer,
  authToken: string,
  deniedMessage: string,
): Promise<string | null> {
  if (await clientSupportsMcpApps(server, authToken)) return null;
  return deniedMessage;
}
