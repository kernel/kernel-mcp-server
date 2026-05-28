import { createClient } from "redis";
import { createHmac } from "crypto";

const redisUrl = process.env.REDIS_URL;
const redisTlsServerName = process.env.REDIS_TLS_SERVER_NAME;
const parsedRedisUrl = redisUrl ? new URL(redisUrl) : null;

if (redisTlsServerName && parsedRedisUrl?.protocol !== "rediss:") {
  throw new Error("REDIS_TLS_SERVER_NAME requires REDIS_URL to use rediss://");
}

// Modest backoff to smooth over first-hit cold connections
const reconnectStrategy = (retries: number) =>
  Math.min(500 + retries * 100, 2000);

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
        reconnectStrategy,
      }
    : {
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
  connectPromise = client
    .connect()
    .then(() => {
      // 'ready' event will flip isConnected when the client can process commands
    })
    .catch((err) => {
      isConnected = false;
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });
  return await connectPromise;
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

async function withReconnect<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isTransientSocketError(err)) {
      isConnected = false;
      await ensureConnected();
      return await operation();
    }
    throw err;
  }
}
