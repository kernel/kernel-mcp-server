import { decodeSessionId, MCP_SESSION_HEADER } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  clientDeclaresExtension,
  initializeClientCapabilities,
  MCP_APPS_EXTENSION,
} from "@/lib/mcp/client-capabilities";
import { hasMcpAppsClient } from "@/lib/redis";

export { MCP_APPS_EXTENSION };

// Sliding TTL for the Redis capability marker. Long enough that an active App
// never loses it mid-flow; refreshed on every gated call.
const MCP_APPS_MARKER_TTL_SECONDS = 24 * 60 * 60;

/**
 * Whether a JSON-RPC payload is a standalone initialize request that declares
 * MCP Apps support. Mixed batches fail closed so they cannot self-attest and
 * invoke an app-only tool in the same HTTP request.
 */
export function initializeDeclaresMcpApps(body: unknown): boolean {
  const capabilities = initializeClientCapabilities(body);
  return clientDeclaresExtension(capabilities, MCP_APPS_EXTENSION);
}

/**
 * App-only tools are hidden from the model via `_meta.ui.visibility`, but that
 * is a hint hosts without MCP Apps support are free to ignore. Fail closed:
 * only execute them when the connected client actually declared the MCP Apps
 * extension. Persistent transports (SSE) expose client capabilities directly;
 * on the stateless streamable-HTTP transport the route layer records the
 * capability per authenticated subject and signed transport session.
 */
export function mcpTransportSessionId(headers: unknown): string | null {
  if (!headers || typeof headers !== "object") return null;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === MCP_SESSION_HEADER,
  );
  const value = key ? record[key] : undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return decodeSessionId(first)?.sessionId ?? null;
}

export async function clientSupportsMcpApps(
  server: McpServer,
  authSubject: string,
  transportSessionId: string | null,
): Promise<boolean> {
  const capabilities = server.server.getClientCapabilities();
  if (clientDeclaresExtension(capabilities, MCP_APPS_EXTENSION)) return true;
  if (!transportSessionId) return false;
  try {
    return await hasMcpAppsClient({
      authSubject,
      transportSessionId,
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
  authSubject: string,
  transportSessionId: string | null,
  deniedMessage: string,
): Promise<string | null> {
  if (await clientSupportsMcpApps(server, authSubject, transportSessionId)) {
    return null;
  }
  return deniedMessage;
}
