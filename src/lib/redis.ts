import { createClient } from "redis";
import { createHmac } from "crypto";
import { mcpAppsMarkerKey } from "@/lib/mcp-apps-marker";
import {
  type OAuthAuthorizationContext,
  parseAuthorizationContext,
  serializeAuthorizationContext,
} from "@/lib/oauth-context";

const redisUrl = process.env.REDIS_URL;
const redisTlsServerName = process.env.REDIS_TLS_SERVER_NAME;
const parsedRedisUrl = redisUrl ? new URL(redisUrl) : null;

if (redisTlsServerName && parsedRedisUrl?.protocol !== "rediss:") {
  throw new Error("REDIS_TLS_SERVER_NAME requires REDIS_URL to use rediss://");
}

// Upper bound on any single command, so an unreachable Redis surfaces as an
// error instead of blocking the caller (e.g. OAuth token exchange).
const COMMAND_TIMEOUT_MS = 5000;

// connect() makes one attempt per connectTimeout and consults reconnectStrategy
// between attempts. Bounding both caps how long connect() can block: an
// unreachable Redis fails after ~MAX_CONNECT_ATTEMPTS x CONNECT_TIMEOUT_MS
// instead of retrying forever, while a healthy connect still returns in <1s.
const CONNECT_TIMEOUT_MS = 3000;
const MAX_CONNECT_ATTEMPTS = 2;
const reconnectStrategy = (retries: number) => {
  if (retries >= MAX_CONNECT_ATTEMPTS - 1) {
    return new Error(
      `Redis unavailable after ${MAX_CONNECT_ATTEMPTS} connect attempts`,
    );
  }
  return Math.min(500 + retries * 100, 2000);
};

// Connect on first use; client.isReady is the source of truth for connection state
let connectPromise: Promise<void> | null = null;

const client = createClient({
  url: redisUrl,
  socket: redisTlsServerName
    ? {
        host: parsedRedisUrl!.hostname,
        tls: true,
        servername: redisTlsServerName,
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy,
      }
    : {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy,
      },
});

client.on("error", (err) => {
  console.error("Redis Client Error", err);
});

// node-redis leaves the socket flagged open after a connect fully fails or a
// command stalls, so a plain reconnect would throw "Socket already opened".
// Tear the client down to a known-clean state; destroy() throws when the socket
// is already closed, which is exactly the state we want, so ignore that.
function resetClient(): void {
  if (client.isOpen) {
    try {
      client.destroy();
    } catch {}
  }
}

async function ensureConnected(): Promise<void> {
  if (client.isReady) return;
  // A single in-flight connect is shared so concurrent callers don't each open
  // (and later tear down) the singleton socket out from under one another.
  if (connectPromise) return await connectPromise;
  connectPromise = openConnection().finally(() => {
    connectPromise = null;
  });
  return await connectPromise;
}

async function openConnection(): Promise<void> {
  // A prior failed connect leaves the socket flagged open; clear it first so
  // connect() doesn't throw "Socket already opened". connect() bounds itself via
  // connectTimeout and reconnectStrategy, so no external deadline is needed.
  if (client.isOpen) resetClient();
  try {
    await client.connect();
  } catch (err) {
    resetClient();
    throw err;
  }
}

// Hash JWT using HMAC-SHA256 with CLERK_SECRET_KEY for secure Redis storage
function hashJwt(jwt: string): string {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }

  return createHmac("sha256", secretKey).update(jwt).digest("hex");
}

// Hash opaque tokens (e.g., refresh tokens) for secure Redis storage
function hashOpaqueToken(token: string): string {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }

  return createHmac("sha256", secretKey).update(token).digest("hex");
}

function authorizationRequestKey(
  clientId: string,
  codeChallenge: string,
): string {
  return `oauth-request:${hashOpaqueToken(`${clientId}:${codeChallenge}`)}`;
}

export async function setAuthorizationContextForRequest({
  clientId,
  codeChallenge,
  authorizationContext,
  ttlSeconds,
}: {
  clientId: string;
  codeChallenge: string;
  authorizationContext: OAuthAuthorizationContext;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  await withReconnect(() =>
    client.setEx(
      authorizationRequestKey(clientId, codeChallenge),
      ttlSeconds,
      serializeAuthorizationContext(authorizationContext),
    ),
  );
}

export async function getAuthorizationContextForRequest({
  clientId,
  codeChallenge,
}: {
  clientId: string;
  codeChallenge: string;
}): Promise<OAuthAuthorizationContext | null> {
  await ensureConnected();
  const value = await withReconnect(() =>
    client.get(authorizationRequestKey(clientId, codeChallenge)),
  );
  return value ? parseAuthorizationContext(value) : null;
}

export async function deleteAuthorizationContextForRequest({
  clientId,
  codeChallenge,
}: {
  clientId: string;
  codeChallenge: string;
}): Promise<void> {
  await ensureConnected();
  await withReconnect(() =>
    client.del(authorizationRequestKey(clientId, codeChallenge)),
  );
}

export async function setAuthorizationContextForClientId({
  clientId,
  authorizationContext,
  ttlSeconds,
}: {
  clientId: string;
  authorizationContext: OAuthAuthorizationContext;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const key = `client:${clientId}`;
  await withReconnect(() =>
    client.setEx(
      key,
      ttlSeconds,
      serializeAuthorizationContext(authorizationContext),
    ),
  );
}

export async function getAuthorizationContextForClientId({
  clientId,
}: {
  clientId: string;
}): Promise<OAuthAuthorizationContext | null> {
  await ensureConnected();
  const value = await withReconnect(() => client.get(`client:${clientId}`));
  return value ? parseAuthorizationContext(value) : null;
}

export async function setAuthorizationContextForJwt({
  jwt,
  authorizationContext,
  ttlSeconds,
}: {
  jwt: string;
  authorizationContext: OAuthAuthorizationContext;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const hashedJwt = hashJwt(jwt);
  const key = `jwt:${hashedJwt}`;
  await withReconnect(() =>
    client.setEx(
      key,
      ttlSeconds,
      serializeAuthorizationContext(authorizationContext),
    ),
  );
}

export { client as redisClient };

// MCP Apps capability markers. Streamable HTTP creates one McpServer per
// request, so initialize capability must survive in Redis. The key combines
// the authenticated subject with the server-signed MCP transport session;
// shared credentials never share capability state.
export async function markMcpAppsClient({
  authSubject,
  transportSessionId,
  ttlSeconds,
}: {
  authSubject: string;
  transportSessionId: string;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const key = mcpAppsMarkerKey(authSubject, transportSessionId);
  await withReconnect(() =>
    client.setEx(key, Math.max(60, Math.floor(ttlSeconds)), "1"),
  );
}

export async function clearMcpAppsClient({
  authSubject,
  transportSessionId,
}: {
  authSubject: string;
  transportSessionId: string;
}): Promise<void> {
  await ensureConnected();
  await withReconnect(() =>
    client.del(mcpAppsMarkerKey(authSubject, transportSessionId)),
  );
}

/**
 * Atomically reads and extends one client's capability marker. GETEX avoids a
 * race where a marker could expire between separate GET and EXPIRE commands.
 */
export async function hasMcpAppsClient({
  authSubject,
  transportSessionId,
  ttlSeconds,
}: {
  authSubject: string;
  transportSessionId: string;
  ttlSeconds: number;
}): Promise<boolean> {
  await ensureConnected();
  const value = await withReconnect(() =>
    client.getEx(mcpAppsMarkerKey(authSubject, transportSessionId), {
      type: "EX",
      value: Math.max(60, Math.floor(ttlSeconds)),
    }),
  );
  return value !== null;
}

export async function setAuthorizationContextForRefreshToken({
  refreshToken,
  authorizationContext,
  ttlSeconds,
}: {
  refreshToken: string;
  authorizationContext: OAuthAuthorizationContext;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const key = `refresh:${hashOpaqueToken(refreshToken)}`;
  await withReconnect(() =>
    client.setEx(
      key,
      ttlSeconds,
      serializeAuthorizationContext(authorizationContext),
    ),
  );
}

export async function getAuthorizationContextForRefreshTokenSliding({
  refreshToken,
  ttlSeconds,
}: {
  refreshToken: string;
  ttlSeconds: number;
}): Promise<OAuthAuthorizationContext | null> {
  await ensureConnected();
  const key = `refresh:${hashOpaqueToken(refreshToken)}`;
  const value = await withReconnect(() =>
    client.getEx(key, { type: "EX", value: ttlSeconds }),
  );
  return value ? parseAuthorizationContext(value) : null;
}

export async function rotateAuthorizationContextForRefreshToken({
  oldRefreshToken,
  newRefreshToken,
  authorizationContext,
  ttlSeconds,
}: {
  oldRefreshToken: string;
  newRefreshToken: string;
  authorizationContext: OAuthAuthorizationContext;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const oldKey = `refresh:${hashOpaqueToken(oldRefreshToken)}`;
  const newKey = `refresh:${hashOpaqueToken(newRefreshToken)}`;
  const value = serializeAuthorizationContext(authorizationContext);

  if (oldKey === newKey) {
    await withReconnect(() => client.setEx(newKey, ttlSeconds, value));
    return;
  }

  await withReconnect(async () => {
    await client.multi().setEx(newKey, ttlSeconds, value).del(oldKey).exec();
  });
}

function isTransientSocketError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return (
    message.includes("Socket closed") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("ENETUNREACH")
  );
}

class RedisCommandTimeoutError extends Error {}

async function withTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const op = operation();
  op.catch(() => {}); // if the timeout wins, the command may still settle later
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RedisCommandTimeoutError(
            `Redis command timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        ),
      COMMAND_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withReconnect<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(operation);
  } catch (err) {
    // A timed-out command leaves a stalled socket that still reports ready, so
    // reset before retrying to force a fresh connection rather than reusing it.
    if (
      isTransientSocketError(err) ||
      err instanceof RedisCommandTimeoutError
    ) {
      resetClient();
      await ensureConnected();
      return await withTimeout(operation);
    }
    throw err;
  }
}
