import { createClient } from "redis";
import { createHmac } from "crypto";
import { mcpAppsMarkerKey } from "@/lib/mcp-apps-marker";
import {
  type OAuthAuthorizationContext,
  parseAuthorizationContext,
  serializeAuthorizationContext,
} from "@/lib/oauth-context";
import {
  openOAuthProviderToken,
  sealOAuthProviderToken,
} from "@/lib/oauth-tokens";

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

function authorizationRequestResourceKey(
  clientId: string,
  codeChallenge: string,
): string {
  return `oauth-request-resource:${hashOpaqueToken(`${clientId}:${codeChallenge}`)}`;
}

function oauthClientRegistrationKey(clientId: string): string {
  return `oauth-client:${hashOpaqueToken(clientId)}`;
}

function oauthAccessTokenKey(accessToken: string): string {
  return `oauth-access:${hashOpaqueToken(accessToken)}`;
}

function oauthProviderRefreshTokenKey(refreshToken: string): string {
  return `oauth-provider-refresh:${hashOpaqueToken(refreshToken)}`;
}

export async function setOAuthClientRedirectUris({
  clientId,
  redirectUris,
}: {
  clientId: string;
  redirectUris: string[];
}): Promise<void> {
  await ensureConnected();
  await withReconnect(() =>
    client.set(
      oauthClientRegistrationKey(clientId),
      JSON.stringify({ redirect_uris: redirectUris }),
    ),
  );
}

export async function getOAuthClientRedirectUris(
  clientId: string,
): Promise<string[] | null> {
  await ensureConnected();
  const value = await withReconnect(() =>
    client.get(oauthClientRegistrationKey(clientId)),
  );
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as { redirect_uris?: unknown };
    if (
      !Array.isArray(parsed.redirect_uris) ||
      !parsed.redirect_uris.every((uri) => typeof uri === "string")
    ) {
      throw new Error("Invalid OAuth client registration");
    }
    return parsed.redirect_uris;
  } catch (error) {
    console.error("Invalid OAuth client registration in Redis", { error });
    throw error;
  }
}

export async function setAuthorizationContextForRequest({
  clientId,
  codeChallenge,
  authorizationContext,
  resource,
  ttlSeconds,
}: {
  clientId: string;
  codeChallenge: string;
  authorizationContext: OAuthAuthorizationContext;
  resource: string;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  await withReconnect(() =>
    client
      .multi()
      .setEx(
        authorizationRequestKey(clientId, codeChallenge),
        ttlSeconds,
        serializeAuthorizationContext(authorizationContext),
      )
      .setEx(
        authorizationRequestResourceKey(clientId, codeChallenge),
        ttlSeconds,
        resource,
      )
      .exec(),
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

export async function getAuthorizationResourceForRequest({
  clientId,
  codeChallenge,
}: {
  clientId: string;
  codeChallenge: string;
}): Promise<string | null> {
  await ensureConnected();
  return await withReconnect(() =>
    client.get(authorizationRequestResourceKey(clientId, codeChallenge)),
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

export interface OAuthAccessTokenSession {
  providerJwt: string;
  resource: string;
}

export async function getOAuthAccessTokenSession(
  accessToken: string,
): Promise<OAuthAccessTokenSession | null> {
  await ensureConnected();
  const value = await withReconnect(() =>
    client.get(oauthAccessTokenKey(accessToken)),
  );
  if (!value) return null;
  const parsed = JSON.parse(
    openOAuthProviderToken(value),
  ) as Partial<OAuthAccessTokenSession>;
  if (!parsed.providerJwt || !parsed.resource) {
    throw new Error("Invalid OAuth access token session");
  }
  return { providerJwt: parsed.providerJwt, resource: parsed.resource };
}

export async function getOAuthProviderRefreshToken(
  refreshToken: string,
): Promise<string | null> {
  await ensureConnected();
  const value = await withReconnect(() =>
    client.get(oauthProviderRefreshTokenKey(refreshToken)),
  );
  return value ? openOAuthProviderToken(value) : null;
}

export async function persistOAuthTokenContexts({
  providerJwt,
  publicAccessToken,
  providerRefreshToken,
  publicRefreshToken,
  oldPublicRefreshToken,
  authorizationContext,
  resource,
  accessTokenTtlSeconds,
  refreshTtlSeconds,
  consumedRequest,
}: {
  providerJwt: string;
  publicAccessToken: string;
  providerRefreshToken: string;
  publicRefreshToken: string;
  oldPublicRefreshToken?: string;
  authorizationContext: OAuthAuthorizationContext;
  resource: string;
  accessTokenTtlSeconds: number;
  refreshTtlSeconds: number;
  consumedRequest?: { clientId: string; codeChallenge: string };
}): Promise<void> {
  await ensureConnected();
  const jwtKey = `jwt:${hashJwt(providerJwt)}`;
  const accessKey = oauthAccessTokenKey(publicAccessToken);
  const newRefreshKey = `refresh:${hashOpaqueToken(publicRefreshToken)}`;
  const providerRefreshKey = oauthProviderRefreshTokenKey(publicRefreshToken);
  const oldRefreshKey = oldPublicRefreshToken
    ? `refresh:${hashOpaqueToken(oldPublicRefreshToken)}`
    : undefined;
  const oldProviderRefreshKey = oldPublicRefreshToken
    ? oauthProviderRefreshTokenKey(oldPublicRefreshToken)
    : undefined;
  const value = serializeAuthorizationContext(authorizationContext);

  await withReconnect(async () => {
    const transaction = client
      .multi()
      .setEx(jwtKey, accessTokenTtlSeconds, value)
      .setEx(
        accessKey,
        accessTokenTtlSeconds,
        sealOAuthProviderToken(JSON.stringify({ providerJwt, resource })),
      )
      .setEx(newRefreshKey, refreshTtlSeconds, value)
      .setEx(
        providerRefreshKey,
        refreshTtlSeconds,
        sealOAuthProviderToken(providerRefreshToken),
      );

    if (oldRefreshKey && oldRefreshKey !== newRefreshKey) {
      transaction.del(oldRefreshKey);
    }
    if (oldProviderRefreshKey && oldProviderRefreshKey !== providerRefreshKey) {
      transaction.del(oldProviderRefreshKey);
    }
    if (consumedRequest) {
      transaction.del([
        authorizationRequestKey(
          consumedRequest.clientId,
          consumedRequest.codeChallenge,
        ),
        authorizationRequestResourceKey(
          consumedRequest.clientId,
          consumedRequest.codeChallenge,
        ),
      ]);
    }

    await transaction.exec();
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
