import { decodeSessionId, MCP_SESSION_HEADER } from "@posthog/mcp";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  clientDeclaresExtension,
  initializeClientCapabilities,
  isRecord,
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
 * extension. Modern requests carry capabilities in their envelope. Legacy HTTP
 * requests use the marker bound to the authenticated subject and signed session.
 */
export function mcpTransportSessionId(headers?: Headers): string | null {
  return decodeSessionId(headers?.get(MCP_SESSION_HEADER))?.sessionId ?? null;
}

export async function clientSupportsMcpApps(
  server: McpServer,
  authSubject: string,
  transportSessionId: string | null,
  ctx: ServerContext,
): Promise<boolean> {
  const envelope = ctx.mcpReq.envelope;
  if (isRecord(envelope) && envelope[PROTOCOL_VERSION_META_KEY]) {
    return clientDeclaresExtension(
      envelope[CLIENT_CAPABILITIES_META_KEY],
      MCP_APPS_EXTENSION,
    );
  }
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
  ctx: ServerContext,
): Promise<string | null> {
  if (
    await clientSupportsMcpApps(server, authSubject, transportSessionId, ctx)
  ) {
    return null;
  }
  return deniedMessage;
}
