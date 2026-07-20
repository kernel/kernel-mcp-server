import { createClient } from "redis";
import { createHmac } from "crypto";

const redisUrl = process.env.REDIS_URL;
const redisTlsServerName = process.env.REDIS_TLS_SERVER_NAME;
const parsedRedisUrl = redisUrl ? new URL(redisUrl) : null;

if (redisTlsServerName && parsedRedisUrl?.protocol !== "rediss:") {
  throw new Error("REDIS_TLS_SERVER_NAME requires REDIS_URL to use rediss://");
}

// Upper bound on connecting and on any single command, so an unreachable Redis
// surfaces as an error instead of blocking the caller (e.g. OAuth token exchange).
const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

// Modest backoff to smooth over first-hit cold connections, but give up after a
// bounded number of attempts rather than retrying forever while Redis is down.
const MAX_RECONNECT_ATTEMPTS = 10;
const reconnectStrategy = (retries: number) => {
  if (retries >= MAX_RECONNECT_ATTEMPTS) {
    return new Error(
      `Redis unavailable after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
    );
  }
  return Math.min(500 + retries * 100, 2000);
};

// Connect on first use
let isConnected = false;
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
  // Reset connection state so the next command will re-connect
  isConnected = false;
  console.error("Redis Client Error", err);
});
client.on("end", () => {
  isConnected = false;
});
client.on("ready", () => {
  isConnected = true;
});

async function ensureConnected(): Promise<void> {
  // Prefer the client's readiness state when available
  // @ts-ignore node-redis exposes isReady at runtime
  if ((client as any).isReady) return;
  if (client.isOpen && isConnected) return;
  if (connectPromise) return await connectPromise;
  connectPromise = connectWithTimeout().finally(() => {
    connectPromise = null;
  });
  return await connectPromise;
}

// connect() drives the reconnect loop, so against an unreachable Redis it blocks
// for the whole reconnect budget. Cap the wait so callers fail within the same
// ceiling as a command instead of after every reconnect attempt.
async function connectWithTimeout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = client.connect();
  connect.catch(() => {}); // swallow a late rejection if the deadline wins
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`Redis connect timed out after ${CONNECT_TIMEOUT_MS}ms`),
        ),
      CONNECT_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([connect, deadline]);
  } catch (err) {
    isConnected = false;
    // Stop the in-flight reconnect loop so the next call starts from a clean socket
    try {
      client.destroy();
    } catch {}
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
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

export async function setOrgIdForClientId({
  clientId,
  orgId,
  ttlSeconds,
}: {
  clientId: string;
  orgId: string;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const key = `client:${clientId}`;
  await withReconnect(() => client.setEx(key, ttlSeconds, orgId));
}

export async function getOrgIdForClientId({
  clientId,
}: {
  clientId: string;
}): Promise<string | null> {
  await ensureConnected();
  const key = `client:${clientId}`;
  return await withReconnect(() => client.get(key));
}

export async function setOrgIdForJwt({
  jwt,
  orgId,
  ttlSeconds,
}: {
  jwt: string;
  orgId: string;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const hashedJwt = hashJwt(jwt);
  const key = `jwt:${hashedJwt}`;
  await withReconnect(() => client.setEx(key, ttlSeconds, orgId));
}

export { client as redisClient };

export async function setOrgIdForRefreshToken({
  refreshToken,
  orgId,
  ttlSeconds,
}: {
  refreshToken: string;
  orgId: string;
  ttlSeconds: number;
}): Promise<void> {
  await ensureConnected();
  const hashed = hashOpaqueToken(refreshToken);
  const key = `refresh:${hashed}`;
  await withReconnect(() => client.setEx(key, ttlSeconds, orgId));
}

export async function getOrgIdForRefreshTokenSliding({
  refreshToken,
  ttlSeconds,
}: {
  refreshToken: string;
  ttlSeconds: number;
}): Promise<string | null> {
  await ensureConnected();
  const hashed = hashOpaqueToken(refreshToken);
  const key = `refresh:${hashed}`;
  const orgId = await withReconnect(() => client.get(key));
  if (orgId) {
    // Refresh TTL to implement sliding expiration on active tokens
    await withReconnect(() => client.expire(key, ttlSeconds));
  }
  return orgId;
}

export async function deleteOrgIdForRefreshToken({
  refreshToken,
}: {
  refreshToken: string;
}): Promise<void> {
  await ensureConnected();
  const hashed = hashOpaqueToken(refreshToken);
  const key = `refresh:${hashed}`;
  await withReconnect(() => client.del(key));
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

async function withTimeout<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const op = operation();
  op.catch(() => {}); // if the timeout wins, the command may still settle later
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`Redis command timed out after ${COMMAND_TIMEOUT_MS}ms`),
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
    if (isTransientSocketError(err)) {
      isConnected = false;
      await ensureConnected();
      return await withTimeout(operation);
    }
    throw err;
  }
}
