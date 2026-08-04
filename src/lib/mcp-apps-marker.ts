import { createHmac } from "node:crypto";

function markerSecret(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return key;
}

function hash(value: string): string {
  return createHmac("sha256", markerSecret()).update(value).digest("hex");
}

/**
 * Stable authenticated subject for capability storage. Clerk callers use the
 * verified user id so access-token refresh is harmless. Opaque API keys use an
 * HMAC so the credential itself never enters Redis keys.
 */
export function mcpAppsAuthSubject({
  token,
  userId,
}: {
  token: string;
  userId?: string | null;
}): string {
  return userId ? `user:${hash(userId)}` : `apikey:${hash(token)}`;
}

/**
 * Capability state belongs to one authenticated subject *and* one signed MCP
 * transport session. Clients sharing a Clerk user or API key therefore cannot
 * expose or clear each other's App-only tools.
 */
export function mcpAppsMarkerKey(
  authSubject: string,
  transportSessionId: string,
): string {
  return `mcp-apps:${hash(`${authSubject}\0${transportSessionId}`)}`;
}
