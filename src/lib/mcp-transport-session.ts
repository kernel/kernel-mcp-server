import { createHmac, timingSafeEqual } from "node:crypto";
import {
  decodeSessionId,
  encodeSessionId,
  newSessionId,
  type SessionTokenPayload,
} from "@posthog/mcp";

const TOKEN_VERSION = "v1";

function signingKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return key;
}

function signature(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

export type McpTransportSession = {
  id: string;
  /** Signed value returned to and replayed by the MCP client. */
  token: string;
  /** PostHog-compatible value passed only to the in-process MCP handler. */
  analyticsToken: string;
};

export function createMcpTransportSession(
  client: Omit<SessionTokenPayload, "sessionId"> = {},
): McpTransportSession {
  const analyticsToken = encodeSessionId({
    sessionId: newSessionId(),
    ...client,
  });
  const signed = `${TOKEN_VERSION}.${analyticsToken}`;
  return {
    id: decodeSessionId(analyticsToken)!.sessionId,
    token: `${signed}.${signature(signed)}`,
    analyticsToken,
  };
}

/**
 * Verifies a transport session minted by this server. The client-controlled
 * header is never used for capability state until its HMAC is valid.
 */
export function verifyMcpTransportSession(
  token: string | null | undefined,
): McpTransportSession | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(signed));
  const actual = Buffer.from(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  const payload = decodeSessionId(parts[1]);
  if (!payload) return null;
  return {
    id: payload.sessionId,
    token,
    analyticsToken: parts[1],
  };
}
