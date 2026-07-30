import { createHmac } from "crypto";

function hashBearerToken(token: string): string {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return createHmac("sha256", secretKey).update(token).digest("hex");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(
      Buffer.from(normalized + padding, "base64").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Stable identity for a client's MCP Apps capability marker. OAuth access
 * tokens rotate on refresh while the session (sid) survives, so key JWT
 * sessions by sid; anything else (static API keys, sid-less JWTs) falls back
 * to the token hash. The payload is only decoded, not verified: markers are
 * recorded solely after the route layer verified the token, and gated calls
 * only ever see verified tokens, so a sid here always belongs to the caller.
 */
export function mcpAppsMarkerSubject(token: string): string {
  const claims = decodeJwtPayload(token);
  if (claims && typeof claims.sid === "string" && claims.sid) {
    return `sid:${claims.sid}`;
  }
  return `token:${hashBearerToken(token)}`;
}
