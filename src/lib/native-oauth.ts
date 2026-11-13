import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { kernelDeployment, mcpServerOrigin } from "@/lib/oauth-discovery";
import { getNativeExchange, setNativeExchange } from "@/lib/redis";

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
const CACHE_READ_TIMEOUT_MS = 500;
const CACHE_KEY_INFO = "kernel-mcp native exchange cache v1";

// An exchanged token is reused only while at least this much of its lifetime
// remains, so every request gets a usable window and clock skew is covered.
const DERIVED_TOKEN_MIN_REMAINING_MS = 60_000;

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
  projects: z.array(z.string()).optional(),
});

const cachedExchangeSchema = z.object({
  token: z.string().min(1).max(MAX_TOKEN_BYTES),
  expiresAt: z.number(),
  projects: z.array(z.string()).optional(),
});

export type NativeCredential = {
  // The exchanged API-audience token; the only token sent to the Kernel API.
  token: string;
  subject: string;
  grantId: string;
  scopes: string[];
  // The projects the grant is limited to; absent when it covers every project.
  projects?: string[];
  // When the exchanged token stops being valid, in local time.
  expiresAt: number;
};

export type NativeOAuthResult =
  | { status: "ok"; credential: NativeCredential }
  | { status: "rejected"; statusCode: 401 | 403; description: string }
  | { status: "unavailable" };

type NativeOAuthFailure = Exclude<NativeOAuthResult, { status: "ok" }>;

class NativeOAuthError extends Error {
  constructor(
    readonly failure: NativeOAuthFailure,
    message: string,
    // A fault on this server's or the issuer's side rather than the caller's.
    readonly serverFault = false,
  ) {
    super(message);
  }
}

const rejected = (message: string) =>
  new NativeOAuthError(
    {
      status: "rejected",
      statusCode: 401,
      description: "Invalid or expired access token",
    },
    message,
  );
const unavailable = (message: string) =>
  new NativeOAuthError({ status: "unavailable" }, message);
const serverFault = (message: string) =>
  new NativeOAuthError({ status: "unavailable" }, message, true);

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

export type NativeOAuthConfig = {
  issuer: string;
  audience: string;
  apiAudience: string;
  clientId: string;
  clientSecret: string;
};

function issuerOrigin(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url?.hostname ?? "",
  );
  if (
    !url ||
    url.origin !== value ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("NATIVE_OAUTH_ISSUER must be an HTTPS or loopback origin");
  return value;
}

// The public MCP origin selects the deployment. The two Kernel deployments
// always accept native tokens and need their exchange client and matching
// API; any other origin is either fully configured or has native OAuth off.
// Throws on partial or inconsistent settings.
function resolveNativeOAuthConfig(): NativeOAuthConfig | null {
  const origin = mcpServerOrigin();
  const deployment = kernelDeployment(origin);
  const {
    NATIVE_OAUTH_ISSUER: issuerOverride,
    NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID: clientId,
    NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET: clientSecret,
    API_BASE_URL: apiBaseUrl,
  } = process.env;
  if (deployment && issuerOverride)
    throw new Error(
      `NATIVE_OAUTH_ISSUER must not be set for ${origin}, whose issuer is ${deployment.authorizationServer}`,
    );
  if (!deployment && !issuerOverride && !clientId && !clientSecret) return null;

  const issuer =
    deployment?.authorizationServer ?? issuerOrigin(issuerOverride!);
  if (!clientId || !clientSecret)
    throw new Error(
      `Native OAuth for ${origin} requires NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID and NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET`,
    );
  // Exchanged tokens are only valid at the API they were issued for.
  const apiOrigin =
    apiBaseUrl && URL.canParse(apiBaseUrl) ? new URL(apiBaseUrl).origin : null;
  const apiAudience = deployment?.api ?? apiOrigin;
  if (!apiAudience || apiOrigin !== apiAudience)
    throw new Error(
      `Native OAuth for ${origin} requires API_BASE_URL to be ${apiAudience ?? "an API origin"}`,
    );
  return {
    issuer,
    audience: `${origin}/mcp`,
    apiAudience,
    clientId,
    clientSecret,
  };
}

let resolvedConfig: { value: NativeOAuthConfig | null } | undefined;

// Resolved once. Instrumentation calls this at startup, so an invalid
// configuration stops the server before it serves a request.
export function nativeOAuthConfig(): NativeOAuthConfig | null {
  resolvedConfig ??= { value: resolveNativeOAuthConfig() };
  return resolvedConfig.value;
}

// One line for startup and build logs. Throws when the configuration is invalid.
export function describeNativeOAuthConfig(): string {
  const config = nativeOAuthConfig();
  return config
    ? `native OAuth enabled: issuer ${config.issuer}, resource ${config.audience}`
    : "native OAuth disabled";
}

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
    ({ payload } = await jwtVerify(token, issuerKeys(config.issuer), {
      issuer: config.issuer,
      audience,
      algorithms: ["RS256"],
      typ: ACCESS_TOKEN_TYPE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iat", "exp"],
    }));
  } catch (error) {
    if (REJECTED_TOKEN_ERRORS.some((type) => error instanceof type))
      throw rejected(`native access token rejected: ${reason(error)}`);
    throw unavailable(`native issuer keys unavailable: ${reason(error)}`);
  }
  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success)
    throw rejected("native access token is outside the issuer profile");
  const lifetime = claims.data.exp - claims.data.iat;
  if (lifetime <= 0 || lifetime > maxLifetimeSeconds)
    throw rejected("native access token lifetime is outside the profile");
  return claims.data;
}

// Verifies an exchanged token and its lineage to the incoming token. A
// failure means the issuer and this server disagree, not a bad caller.
async function verifyExchangedToken(
  token: string,
  parent: AccessClaims,
  config: NativeOAuthConfig,
): Promise<AccessClaims> {
  let derived: AccessClaims;
  try {
    derived = await verifyAccessToken(
      token,
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
    throw serverFault(`exchanged token rejected: ${reason(error)}`);
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
    scope: derived.scope
      .split(" ")
      .every((item) => parentScopes.includes(item)),
  };
  const failed = Object.entries(lineage)
    .filter(([, ok]) => !ok)
    .map(([check]) => check);
  if (failed.length > 0)
    throw serverFault(`exchanged token lineage mismatch: ${failed.join(",")}`);
  return derived;
}

// A body that is not the issuer's JSON is an outage when the issuer says so
// (5xx), and otherwise an issuer fault.
async function readExchangeResponse(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw unavailable(`native exchange failed: ${reason(error)}`);
  }
  const malformed = response.status >= 500 ? unavailable : serverFault;
  if (text.length > 16_384)
    throw malformed(
      `native exchange response too large: HTTP ${response.status}`,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw malformed(
      `native exchange returned HTTP ${response.status} without JSON`,
    );
  }
}

// RFC 8693 errors from the issuer: an inactive grant rejects the credential
// and a scope it no longer covers is forbidden. Anything naming this
// server's request or client is a server fault, logged as an error.
function exchangeFailure(status: number, body: unknown): NativeOAuthError {
  const error = z.object({ error: z.string() }).safeParse(body).data?.error;
  if (error === "invalid_grant")
    return rejected("native exchange: grant inactive");
  if (error === "invalid_scope")
    return new NativeOAuthError(
      {
        status: "rejected",
        statusCode: 403,
        description: "This credential's scope does not cover this request",
      },
      "native exchange: scope not granted",
    );
  if (status >= 500 || error === "temporarily_unavailable")
    return unavailable(`native exchange unavailable: HTTP ${status}`);
  return serverFault(
    `native exchange refused this server: HTTP ${status} ${error ?? "without an OAuth error"}`,
  );
}

async function exchange(
  token: string,
  parent: AccessClaims,
  config: NativeOAuthConfig,
): Promise<NativeCredential> {
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
    throw unavailable(`native exchange failed: ${reason(error)}`);
  }
  const body = await readExchangeResponse(response);
  if (!response.ok) throw exchangeFailure(response.status, body);

  const exchanged = exchangeSchema.safeParse(body);
  if (!exchanged.success)
    throw serverFault("native exchange response is not RFC 8693");
  const {
    access_token: derivedToken,
    expires_in,
    scope,
    projects,
  } = exchanged.data;
  const derived = await verifyExchangedToken(derivedToken, parent, config);
  if (derived.scope !== scope)
    throw serverFault("exchanged token lineage mismatch: scope");

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
    projects,
    expiresAt,
  };
}

// Exchanged tokens are cached in Redis so every instance can reuse them. The
// key is an HMAC of the incoming token; the value is encrypted with a key
// derived from the incoming token, so Redis contents alone are useless.
export type NativeExchangeStore = {
  get(cacheIdentity: string): Promise<string | null>;
  set(cacheIdentity: string, value: string, ttlMs: number): Promise<void>;
};

const redisExchangeStore: NativeExchangeStore = {
  get: (cacheIdentity) => getNativeExchange(cacheIdentity),
  set: (cacheIdentity, value, ttlMs) =>
    setNativeExchange(cacheIdentity, value, ttlMs),
};
let exchangeStore = redisExchangeStore;

function cacheKey(token: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", token, Buffer.alloc(0), CACHE_KEY_INFO, 32),
  );
}

function sealExchange(
  token: string,
  cacheIdentity: string,
  credential: NativeCredential,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cacheKey(token), iv);
  cipher.setAAD(Buffer.from(cacheIdentity));
  const plaintext = JSON.stringify({
    token: credential.token,
    expiresAt: credential.expiresAt,
    projects: credential.projects,
  });
  const sealed = Buffer.concat([
    iv,
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return sealed.toString("base64url");
}

function openExchange(token: string, cacheIdentity: string, value: string) {
  const sealed = Buffer.from(value, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    cacheKey(token),
    sealed.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(cacheIdentity));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]).toString("utf8");
  return cachedExchangeSchema.parse(JSON.parse(plaintext));
}

// A cached exchange is used only if it decrypts, still has the minimum
// remaining lifetime, and verifies again against the incoming token. Any
// miss, store error or failed check means a fresh exchange.
async function cachedExchange(
  token: string,
  cacheIdentity: string,
  parent: AccessClaims,
  config: NativeOAuthConfig,
): Promise<NativeCredential | null> {
  let value: string | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    value = await Promise.race([
      exchangeStore.get(cacheIdentity),
      new Promise<null>((resolve) => {
        timer = setTimeout(resolve, CACHE_READ_TIMEOUT_MS, null);
      }),
    ]);
  } catch (error) {
    console.warn(`native exchange cache unavailable: ${reason(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!value) return null;
  try {
    const cached = openExchange(token, cacheIdentity, value);
    if (cached.expiresAt - DERIVED_TOKEN_MIN_REMAINING_MS <= Date.now())
      return null;
    const derived = await verifyExchangedToken(cached.token, parent, config);
    return {
      token: cached.token,
      subject: parent.sub,
      grantId: parent.grant_id,
      scopes: derived.scope.split(" "),
      projects: cached.projects,
      expiresAt: Math.min(cached.expiresAt, derived.exp * 1000),
    };
  } catch (error) {
    console.warn(`native exchange cache entry discarded: ${reason(error)}`);
    return null;
  }
}

// Concurrent requests on one instance share an exchange for the same token.
const pendingExchanges = new Map<string, Promise<NativeCredential>>();

async function exchangedCredential(
  token: string,
  parent: AccessClaims,
  config: NativeOAuthConfig,
): Promise<NativeCredential> {
  const cacheIdentity = [config.issuer, config.audience, token].join("\0");
  const cached = await cachedExchange(token, cacheIdentity, parent, config);
  if (cached) return cached;

  let pending = pendingExchanges.get(cacheIdentity);
  if (!pending) {
    pending = exchange(token, parent, config).finally(() =>
      pendingExchanges.delete(cacheIdentity),
    );
    pendingExchanges.set(cacheIdentity, pending);
    void pending.then(
      (credential) => {
        const ttlMs =
          credential.expiresAt - DERIVED_TOKEN_MIN_REMAINING_MS - Date.now();
        if (ttlMs <= 0) return;
        return exchangeStore
          .set(
            cacheIdentity,
            sealExchange(token, cacheIdentity, credential),
            ttlMs,
          )
          .catch((error) =>
            console.warn(
              `native exchange cache write failed: ${reason(error)}`,
            ),
          );
      },
      () => {},
    );
  }
  return pending;
}

// Authenticates a native bearer on every request: the incoming token is
// verified locally before any cached exchange is used, and its exchanged
// API-audience token is what the request carries onward. Without native
// configuration every native token is rejected like any untrusted token.
export async function authenticateNativeOAuth(
  token: string,
): Promise<NativeOAuthResult> {
  try {
    const config = nativeOAuthConfig();
    if (!config) throw rejected("native OAuth is not configured");
    if (token.length > MAX_TOKEN_BYTES)
      throw rejected("native access token too large");
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
      credential: await exchangedCredential(token, parent, config),
    };
  } catch (error) {
    if (!(error instanceof NativeOAuthError)) throw error;
    if (error.serverFault) console.error(error.message);
    else console.warn(error.message);
    return error.failure;
  }
}

export function resetNativeOAuthForTests(store?: NativeExchangeStore) {
  resolvedConfig = undefined;
  keySets.clear();
  pendingExchanges.clear();
  exchangeStore = store ?? redisExchangeStore;
}
