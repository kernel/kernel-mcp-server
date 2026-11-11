import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { kernelDeployment, oauthRequestOrigin } from "@/lib/oauth-discovery";

// The Kernel issuer's access-token profile: at most 4 KiB, MCP-audience
// tokens live ten minutes, exchanged API-audience tokens five.
const MAX_TOKEN_BYTES = 4096;
const ACCESS_TOKEN_LIFETIME_SECONDS = 600;
const EXCHANGE_TOKEN_LIFETIME_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 30;
const ACCESS_TOKEN_TYPE = "at+jwt";
const ACCESS_TOKEN_URN = "urn:ietf:params:oauth:token-type:access_token";
const JWKS_PATH = "/.well-known/jwks.json";
const EXCHANGE_TIMEOUT_MS = 5_000;

// A derived token is reused only while at least this much of its lifetime
// remains, so every request gets a usable window and clock skew is covered.
const DERIVED_TOKEN_MIN_REMAINING_MS = 60_000;
const MAX_DERIVED_TOKENS = 1_000;

const accessClaimsSchema = z.object({
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

export type NativeCredential = {
  // The exchanged API-audience token; the only token sent to the Kernel API.
  token: string;
  subject: string;
  grantId: string;
  scopes: string[];
  // When the exchanged token stops being valid, in local time.
  expiresAt: number;
};

export type NativeOAuthResult =
  | { status: "ok"; credential: NativeCredential }
  | { status: "rejected"; statusCode: 401 | 403 }
  | { status: "unavailable" }
  | { status: "misconfigured" };

type NativeOAuthFailure = Exclude<NativeOAuthResult, { status: "ok" }>;

class NativeOAuthError extends Error {
  constructor(
    readonly failure: NativeOAuthFailure,
    message: string,
  ) {
    super(message);
  }
}

const rejected = (message: string) =>
  new NativeOAuthError({ status: "rejected", statusCode: 401 }, message);
const unavailable = (message: string) =>
  new NativeOAuthError({ status: "unavailable" }, message);
const misconfigured = (message: string) =>
  new NativeOAuthError({ status: "misconfigured" }, message);

// Matches the Kernel API's own selector: a compact JWT whose header typ is
// at+jwt. Clerk session tokens carry typ JWT and keep their existing path.
export function isNativeOAuthCredential(token: string): boolean {
  if (token.split(".").length !== 3) return false;
  try {
    const typ = decodeProtectedHeader(token).typ?.toLowerCase();
    return (
      typ === ACCESS_TOKEN_TYPE || typ === `application/${ACCESS_TOKEN_TYPE}`
    );
  } catch {
    return false;
  }
}

type NativeOAuthConfig = {
  issuer: string;
  audience: string;
  apiAudience: string;
  clientId: string;
  clientSecret: string;
  keys: JWTVerifyGetKey;
};

const keySets = new Map<string, JWTVerifyGetKey>();

// Keys come only from the configured issuer's JWKS, never from a URL in the
// token. jose caches the set, refetches for an unknown kid at most every 30s,
// and bounds each fetch to five seconds.
function issuerKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(JWKS_PATH, issuer), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    keySets.set(issuer, keys);
  }
  return keys;
}

function configuredOrigin(name: string, value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url?.hostname ?? "",
  );
  if (
    !url ||
    url.origin !== value ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw misconfigured(`${name} must be an HTTPS or loopback origin`);
  return value;
}

// Trust is derived from the public MCP origin, the same mapping discovery
// advertises. NATIVE_OAUTH_ISSUER exists only for origins outside that
// mapping, such as local development. Returns null when this origin trusts
// no native issuer.
function nativeOAuthConfig(request: Request): NativeOAuthConfig | null {
  const origin = oauthRequestOrigin(request);
  const deployment = kernelDeployment(origin);
  const issuerOverride = process.env.NATIVE_OAUTH_ISSUER;
  if (!deployment && !issuerOverride) return null;
  const issuer =
    deployment?.authorizationServer ??
    configuredOrigin("NATIVE_OAUTH_ISSUER", issuerOverride!);

  // Exchanged tokens are only valid at the API they were issued for, so the
  // API this server calls must be that audience.
  const apiBaseUrl = process.env.API_BASE_URL;
  const apiOrigin =
    apiBaseUrl && URL.canParse(apiBaseUrl) ? new URL(apiBaseUrl).origin : null;
  const apiAudience = deployment?.api ?? apiOrigin;
  if (!apiAudience || apiOrigin !== apiAudience)
    throw misconfigured(`API_BASE_URL must be ${apiAudience ?? "set"}`);

  const clientId = process.env.NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID;
  const clientSecret = process.env.NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw misconfigured(
      "NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID and NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET are required",
    );

  return {
    issuer,
    audience: `${origin}/mcp`,
    apiAudience,
    clientId,
    clientSecret,
    keys: issuerKeys(issuer),
  };
}

const REJECTED_TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

// Throws NativeOAuthError: a token outside the profile is rejected, while a
// failure to fetch the issuer's keys is unavailable.
async function verifyAccessToken(
  token: string,
  audience: string,
  maxLifetimeSeconds: number,
  config: NativeOAuthConfig,
): Promise<AccessClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, config.keys, {
      issuer: config.issuer,
      audience,
      algorithms: ["RS256"],
      typ: ACCESS_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp"],
    }));
  } catch (error) {
    if (REJECTED_TOKEN_ERRORS.some((type) => error instanceof type))
      throw rejected(
        `native access token rejected: ${(error as Error).message}`,
      );
    throw unavailable(
      `native issuer keys unavailable: ${error instanceof Error ? error.message : error}`,
    );
  }
  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success)
    throw rejected("native access token is outside the issuer profile");
  const lifetime = claims.data.exp - claims.data.iat;
  if (lifetime <= 0 || lifetime > maxLifetimeSeconds)
    throw rejected("native access token lifetime is outside the profile");
  return claims.data;
}

async function readExchangeResponse(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw unavailable(
      `native exchange failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (text.length > 16_384)
    throw unavailable("native exchange response too large");
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable(`native exchange returned HTTP ${response.status}`);
  }
}

// RFC 8693 errors from the issuer: an inactive grant rejects the credential,
// a scope it no longer covers is forbidden, and anything that names this
// server's request or client is a deployment fault no retry will fix.
function exchangeFailure(status: number, body: unknown): NativeOAuthError {
  const error = z.object({ error: z.string() }).safeParse(body).data?.error;
  if (error === "invalid_grant")
    return rejected("native exchange: grant inactive");
  if (error === "invalid_scope")
    return new NativeOAuthError(
      { status: "rejected", statusCode: 403 },
      "native exchange: scope not granted",
    );
  if (status >= 500 || error === "temporarily_unavailable")
    return unavailable(`native exchange unavailable: HTTP ${status}`);
  return misconfigured(
    `native exchange refused this server: HTTP ${status} ${error ?? "without an OAuth error"}`,
  );
}

type CachedCredential = NativeCredential & { reuseUntil: number };

async function exchange(
  token: string,
  parent: AccessClaims,
  config: NativeOAuthConfig,
): Promise<CachedCredential> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${config.issuer}/token`, {
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
        resource: config.apiAudience,
        scope: parent.scope,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable(
      `native exchange failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  const body = await readExchangeResponse(response);
  if (!response.ok) throw exchangeFailure(response.status, body);

  const exchanged = exchangeSchema.safeParse(body);
  if (!exchanged.success)
    throw misconfigured("native exchange response is not RFC 8693");
  const { access_token: derivedToken, expires_in, scope } = exchanged.data;
  let derived: AccessClaims;
  try {
    derived = await verifyAccessToken(
      derivedToken,
      config.apiAudience,
      EXCHANGE_TOKEN_LIFETIME_SECONDS,
      config,
    );
  } catch (error) {
    if (
      error instanceof NativeOAuthError &&
      error.failure.status === "unavailable"
    )
      throw error;
    throw misconfigured(
      `exchanged token rejected: ${error instanceof Error ? error.message : error}`,
    );
  }
  const parentScopes = parent.scope.split(" ");
  const lineage = {
    sub: derived.sub === parent.sub,
    grant_id: derived.grant_id === parent.grant_id,
    org_id: derived.org_id === parent.org_id,
    project_id: (derived.project_id ?? "") === (parent.project_id ?? ""),
    client_id: derived.client_id === config.clientId,
    act: derived.act?.sub === `oauth_client:${config.clientId}`,
    parent_jti: derived.parent_jti === parent.jti,
    exp: derived.exp <= parent.exp,
    scope:
      derived.scope === scope &&
      scope.split(" ").every((item) => parentScopes.includes(item)),
  };
  const failed = Object.entries(lineage)
    .filter(([, ok]) => !ok)
    .map(([check]) => check);
  if (failed.length > 0)
    throw misconfigured(
      `exchanged token lineage mismatch: ${failed.join(",")}`,
    );

  // The relative lifetime covers an issuer clock running ahead, the signed
  // exp one running behind; lineage already bounds exp by the parent's.
  const expiresAt = Math.min(
    startedAt + Math.min(expires_in, derived.exp - derived.iat) * 1000,
    derived.exp * 1000,
  );
  if (expiresAt <= Date.now())
    throw rejected("native exchange issued an expired token");
  return {
    token: derivedToken,
    subject: parent.sub,
    grantId: parent.grant_id,
    scopes: scope.split(" "),
    expiresAt,
    reuseUntil: expiresAt - DERIVED_TOKEN_MIN_REMAINING_MS,
  };
}

// Exchanged tokens keyed by a SHA-256 fingerprint of the incoming token, so
// neither bearer ever becomes a key. Losing an entry only costs an exchange;
// the API still checks the exchanged token's status on every request.
const derivedTokens = new Map<string, CachedCredential>();
const pendingExchanges = new Map<string, Promise<CachedCredential>>();

function rememberDerivedToken(key: string, credential: CachedCredential) {
  const now = Date.now();
  if (credential.reuseUntil <= now) return;
  for (const [entryKey, entry] of derivedTokens)
    if (entry.reuseUntil <= now) derivedTokens.delete(entryKey);
  if (derivedTokens.size >= MAX_DERIVED_TOKENS) {
    const oldest = derivedTokens.keys().next().value;
    if (oldest) derivedTokens.delete(oldest);
  }
  derivedTokens.set(key, credential);
}

async function derivedCredential(
  token: string,
  parent: AccessClaims,
  config: NativeOAuthConfig,
): Promise<CachedCredential> {
  const key = createHash("sha256")
    .update([config.issuer, config.audience, token].join("\0"))
    .digest("hex");
  const cached = derivedTokens.get(key);
  if (cached && cached.reuseUntil > Date.now()) return cached;
  if (cached) derivedTokens.delete(key);

  let pending = pendingExchanges.get(key);
  if (!pending) {
    pending = exchange(token, parent, config)
      .then((credential) => {
        rememberDerivedToken(key, credential);
        return credential;
      })
      .finally(() => pendingExchanges.delete(key));
    pendingExchanges.set(key, pending);
  }
  return pending;
}

// Authenticates a native bearer on every request: the incoming token is
// verified locally before any cached exchange is used, and its exchanged
// API-audience token is what the request carries onward.
export async function authenticateNativeOAuth(
  token: string,
  request: Request,
): Promise<NativeOAuthResult> {
  try {
    if (token.length > MAX_TOKEN_BYTES)
      throw rejected("native access token too large");
    const config = nativeOAuthConfig(request);
    if (!config) throw rejected("no native issuer is trusted for this origin");
    const parent = await verifyAccessToken(
      token,
      config.audience,
      ACCESS_TOKEN_LIFETIME_SECONDS,
      config,
    );
    // Exchanged tokens cannot be exchanged again.
    if (parent.act || parent.parent_jti)
      throw rejected("native access token is already exchanged");
    return {
      status: "ok",
      credential: await derivedCredential(token, parent, config),
    };
  } catch (error) {
    if (!(error instanceof NativeOAuthError)) throw error;
    if (error.failure.status === "misconfigured") console.error(error.message);
    else console.warn(error.message);
    return error.failure;
  }
}

export function clearNativeOAuthCachesForTests() {
  keySets.clear();
  derivedTokens.clear();
  pendingExchanges.clear();
}
