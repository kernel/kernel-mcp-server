import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { z } from "zod";

// Mirrors the Kernel API issuer profile (packages/api/lib/oauthnative):
// MaxTokenBytes, AccessTokenLifetime, ExchangeTokenLifetime and the
// signature leeway.
const MAX_TOKEN_BYTES = 4096;
const ACCESS_TOKEN_LIFETIME_SECONDS = 600;
const EXCHANGE_TOKEN_LIFETIME_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 30;
const ACCESS_TOKEN_TYPES = ["at+jwt", "application/at+jwt"];
const ACCESS_TOKEN_URN = "urn:ietf:params:oauth:token-type:access_token";

// A native request or stream is authorized for at most one minute, however
// long the exchanged token lives; continuing requires a fresh exchange.
export const NATIVE_STREAM_LEASE_MS = 60_000;

const accessClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.array(z.string()).length(1),
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  client_id: z.string().min(1),
  grant_id: z.string().min(1),
  org_id: z.string().min(1),
  project_id: z.string().optional(),
  scope: z.string().min(1),
  authorization_version: z.literal(1),
  issuer_epoch: z.number().int(),
  act: z.object({ sub: z.string() }).optional(),
  parent_jti: z.string().optional(),
});
type AccessClaims = z.infer<typeof accessClaimsSchema>;

const exchangeSchema = z.object({
  access_token: z.string().min(1).max(MAX_TOKEN_BYTES),
  token_type: z.literal("Bearer"),
  issued_token_type: z.literal(ACCESS_TOKEN_URN),
  expires_in: z.number().int().nonnegative(),
  scope: z.string().min(1),
});

const jwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("RSA"),
        kid: z.string().min(1),
        n: z.string().min(1),
        e: z.string().min(1),
        d: z.undefined(),
      }),
    )
    .min(1),
});

// Matches the API's own selector: a compact JWT whose header typ is at+jwt.
// Clerk session tokens carry typ JWT and keep their existing path.
export function isNativeOAuthCredential(token: string): boolean {
  if (token.split(".").length !== 3) return false;
  try {
    const typ = decodeProtectedHeader(token).typ?.toLowerCase();
    return typ !== undefined && ACCESS_TOKEN_TYPES.includes(typ);
  } catch {
    return false;
  }
}

export class NativeCredentialRejected extends Error {
  constructor() {
    super("native credential rejected");
  }
}

export class NativeScopeRejected extends Error {
  constructor() {
    super("native scope rejected");
  }
}

export type NativeOAuthConfig = {
  issuer: string;
  audience: string;
  apiAudience: string;
  epoch: number;
  clientId: string;
  clientSecret: string;
  keys: JSONWebKeySet;
};

function httpsOrigin(name: string): string {
  const value = process.env[name];
  if (!value || new URL(value).protocol !== "https:")
    throw new Error(`${name} must be an HTTPS origin`);
  if (new URL(value).origin !== value)
    throw new Error(`${name} must be an origin without a trailing slash`);
  return value;
}

// Returns null unless explicitly enabled. Every trust input is required and
// has no default, so an enabled deployment cannot silently trust another
// environment's issuer.
export function nativeOAuthConfig(): NativeOAuthConfig | null {
  if (process.env.OAUTH_NATIVE_ENABLED !== "true") return null;
  const issuer = httpsOrigin("OAUTH_NATIVE_ISSUER");
  const audience = httpsOrigin("OAUTH_NATIVE_MCP_AUDIENCE");
  const apiAudience = httpsOrigin("OAUTH_NATIVE_API_AUDIENCE");
  if (audience === apiAudience)
    throw new Error("native OAuth MCP and API audiences must differ");
  const epoch = Number(process.env.OAUTH_NATIVE_ISSUER_EPOCH);
  const clientId = process.env.OAUTH_NATIVE_EXCHANGE_CLIENT;
  const clientSecret = process.env.OAUTH_NATIVE_EXCHANGE_SECRET;
  if (!clientId || !clientSecret || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("incomplete native OAuth configuration");
  return {
    issuer,
    audience,
    apiAudience,
    epoch,
    clientId,
    clientSecret,
    keys: jwksSchema.parse(
      JSON.parse(process.env.OAUTH_NATIVE_VERIFICATION_JWKS ?? ""),
    ),
  };
}

async function verifyAccessToken(
  token: string,
  audience: string,
  maxLifetimeSeconds: number,
  config: NativeOAuthConfig,
): Promise<AccessClaims> {
  const { payload, protectedHeader } = await jwtVerify(
    token,
    createLocalJWKSet(config.keys),
    {
      issuer: config.issuer,
      audience,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp"],
    },
  );
  const claims = accessClaimsSchema.parse(payload);
  if (
    !protectedHeader.kid ||
    !ACCESS_TOKEN_TYPES.includes(protectedHeader.typ?.toLowerCase() ?? "") ||
    claims.issuer_epoch !== config.epoch ||
    claims.exp - claims.iat <= 0 ||
    claims.exp - claims.iat > maxLifetimeSeconds
  )
    throw new Error("invalid native access token");
  return claims;
}

// All HTTP destinations and verification keys come from server configuration, never JWT claims.
export async function exchangeNativeOAuth(
  token: string,
  signal: AbortSignal,
  config: NativeOAuthConfig,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  if (token.length > MAX_TOKEN_BYTES) throw new NativeCredentialRejected();
  const parent = await verifyAccessToken(
    token,
    config.audience,
    ACCESS_TOKEN_LIFETIME_SECONDS,
    config,
  ).catch(() => {
    throw new NativeCredentialRejected();
  });
  // Exchanged tokens cannot be exchanged again, and only the issuer's
  // authoritative status check (performed by the exchange) admits a parent.
  if (parent.act || parent.parent_jti) throw new NativeCredentialRejected();

  const startedAt = Date.now();
  const response = await request(`${config.issuer}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: ACCESS_TOKEN_URN,
      requested_token_type: ACCESS_TOKEN_URN,
      scope: parent.scope,
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (response.status >= 500)
    throw new Error("native OAuth authority unavailable");
  const text = await response.text();
  if (text.length > 16384) throw new Error("invalid native OAuth response");
  const body: unknown = JSON.parse(text);
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(body);
    if (response.status === 400 && failure.data?.error === "invalid_grant")
      throw new NativeCredentialRejected();
    if (response.status === 400 && failure.data?.error === "invalid_scope")
      throw new NativeScopeRejected();
    throw new Error("native OAuth exchange failed");
  }

  const exchanged = exchangeSchema.parse(body);
  const derived = await verifyAccessToken(
    exchanged.access_token,
    config.apiAudience,
    EXCHANGE_TOKEN_LIFETIME_SECONDS,
    config,
  );
  const parentScopes = parent.scope.split(" ");
  if (
    derived.sub !== parent.sub ||
    derived.grant_id !== parent.grant_id ||
    derived.org_id !== parent.org_id ||
    (derived.project_id ?? "") !== (parent.project_id ?? "") ||
    derived.client_id !== config.clientId ||
    derived.act?.sub !== `oauth_client:${config.clientId}` ||
    derived.parent_jti !== parent.jti ||
    derived.exp > parent.exp ||
    derived.scope !== exchanged.scope ||
    exchanged.scope.split(" ").some((scope) => !parentScopes.includes(scope))
  )
    throw new Error("invalid native exchange");

  // expires_in and exp - iat are relative, so issuer clock skew cannot
  // extend the lease past the token's real remaining lifetime.
  const lifetimeMs =
    Math.min(exchanged.expires_in, derived.exp - derived.iat) * 1000;
  if (lifetimeMs <= 0) throw new NativeCredentialRejected();
  return {
    token: exchanged.access_token,
    subject: parent.sub,
    scopes: exchanged.scope.split(" "),
    deadline: startedAt + Math.min(lifetimeMs, NATIVE_STREAM_LEASE_MS),
  };
}

// Ends a native response when its authorization lease expires; reconnecting
// requires a fresh exchange.
export function leaseNativeResponse(
  response: Response,
  deadline: number,
  abort: AbortController,
): Response {
  if (!response.body) {
    abort.abort();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(
        () => {
          if (finished) return;
          finished = true;
          abort.abort();
          void reader.cancel().catch(() => {});
          controller.close();
        },
        Math.max(0, deadline - Date.now()),
      );
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          finished = true;
          clearTimeout(timer);
          abort.abort();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        abort.abort();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      clearTimeout(timer);
      abort.abort();
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
