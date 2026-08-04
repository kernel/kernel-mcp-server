import {
  clearMcpAppsClient,
  hasMcpAppsClient,
  markMcpAppsClient,
} from "@/lib/redis";
import { initializeDeclaresMcpApps } from "@/lib/mcp/tools/mcp-apps-gate";

export type McpAppsMarkerStore = {
  mark: typeof markMcpAppsClient;
  clear: typeof clearMcpAppsClient;
  has: typeof hasMcpAppsClient;
};

const redisMarkerStore: McpAppsMarkerStore = {
  mark: markMcpAppsClient,
  clear: clearMcpAppsClient,
  has: hasMcpAppsClient,
};

/**
 * Records initialize capability and selects App registration for later
 * streamable-HTTP requests. Identity is supplied only after bearer auth and
 * combines the authenticated subject with the signed transport session.
 */
export async function requestUsesMcpApps(
  req: Request,
  identity: {
    authSubject: string;
    transportSessionId: string | null;
    ttlSeconds: number;
  },
  store: McpAppsMarkerStore = redisMarkerStore,
): Promise<boolean> {
  if (req.method !== "POST") return false;
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return false;
  }

  const request =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as {
          method?: unknown;
          params?: { name?: unknown; uri?: unknown };
        })
      : null;
  if (request?.method === "initialize") {
    try {
      if (identity.transportSessionId) {
        const marker = {
          authSubject: identity.authSubject,
          transportSessionId: identity.transportSessionId,
        };
        if (initializeDeclaresMcpApps(body)) {
          await store.mark({ ...marker, ttlSeconds: identity.ttlSeconds });
        } else {
          await store.clear(marker);
        }
      }
    } catch (error) {
      console.error("Failed to record MCP Apps capability:", error);
    }
    return false;
  }

  const needsAppRegistration =
    request?.method === "tools/list" ||
    request?.method === "resources/list" ||
    (request?.method === "resources/read" &&
      typeof request.params?.uri === "string" &&
      request.params.uri.startsWith("ui://kernel/managed-auth-login")) ||
    (request?.method === "tools/call" &&
      (request.params?.name === "open_auth_login" ||
        request.params?.name === "begin_auth_login"));
  if (!needsAppRegistration || !identity.transportSessionId) return false;

  try {
    return await store.has({
      authSubject: identity.authSubject,
      transportSessionId: identity.transportSessionId,
      ttlSeconds: identity.ttlSeconds,
    });
  } catch (error) {
    console.error("MCP Apps capability check failed; using base tools:", error);
    return false;
  }
}
