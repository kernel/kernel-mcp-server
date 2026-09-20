import {
  decodeProtectedHeader,
  decodeJwt,
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { z } from "zod";

const claimsSchema = z.object({
  active: z.literal(true),
  iss: z.string(),
  aud: z.array(z.string()).length(1),
  sub: z.string().min(1),
  jti: z.string().min(1),
  client_id: z.string().min(1),
  issuer_epoch: z.number().int().positive(),
  scope: z.string().min(1),
  exp: z.number(),
});
const exchangeSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.literal("Bearer"),
  issued_token_type: z.literal("urn:ietf:params:oauth:token-type:access_token"),
  expires_in: z.number().positive().max(60),
  scope: z.string(),
});

export function isNativeOAuthCredential(token: string): boolean {
  if (token.startsWith("krn_")) return true;
  if (token.length > 16384) return false;
  try {
    const header = decodeProtectedHeader(token);
    const claims = decodeJwt(token);
    return (
      header.typ === "at+jwt" ||
      header.typ === "application/at+jwt" ||
      "issuer_epoch" in claims ||
      "authorization_version" in claims
    );
  } catch {
    return false;
  }
}

export class NativeCredentialRejected extends Error {
  constructor() {
    super("native credential rejected");
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

export function nativeOAuthConfig(): NativeOAuthConfig | null {
  if (process.env.OAUTH_NATIVE_ENABLED !== "true") return null;
  const issuer = process.env.OAUTH_NATIVE_ISSUER ?? "https://auth.onkernel.com";
  const parsed = new URL(issuer);
  if (parsed.protocol !== "https:" || parsed.origin !== issuer)
    throw new Error("invalid native OAuth issuer");
  const clientId = process.env.OAUTH_NATIVE_EXCHANGE_CLIENT;
  const clientSecret = process.env.OAUTH_NATIVE_EXCHANGE_SECRET;
  const epoch = Number(process.env.OAUTH_NATIVE_ISSUER_EPOCH);
  if (!clientId || !clientSecret || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error("incomplete native OAuth configuration");
  return {
    issuer,
    audience:
      process.env.OAUTH_NATIVE_MCP_AUDIENCE ?? "https://mcp.onkernel.com",
    apiAudience:
      process.env.OAUTH_NATIVE_API_AUDIENCE ?? "https://api.onkernel.com/",
    epoch,
    clientId,
    clientSecret,
    keys: JSON.parse(process.env.OAUTH_NATIVE_VERIFICATION_JWKS ?? "{}"),
  };
}

// All HTTP destinations and verification keys come from server configuration, never JWT claims.
export async function exchangeNativeOAuth(
  token: string,
  signal: AbortSignal,
  config: NativeOAuthConfig,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  if (token.length > 4096) throw new NativeCredentialRejected();
  const verified = await jwtVerify(token, createLocalJWKSet(config.keys), {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ["RS256"],
    clockTolerance: 30,
    requiredClaims: [
      "sub",
      "jti",
      "iat",
      "exp",
      "client_id",
      "issuer_epoch",
      "scope",
    ],
  }).catch(() => {
    throw new NativeCredentialRejected();
  });
  if (
    !["at+jwt", "application/at+jwt"].includes(
      verified.protectedHeader.typ ?? "",
    ) ||
    verified.payload.issuer_epoch !== config.epoch ||
    !Array.isArray(verified.payload.aud) ||
    verified.payload.aud.length !== 1 ||
    typeof verified.payload.iat !== "number" ||
    typeof verified.payload.exp !== "number" ||
    verified.payload.exp - verified.payload.iat > 600 ||
    verified.payload.act
  )
    throw new NativeCredentialRejected();
  const authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`;
  const post = async (path: string, form: URLSearchParams) => {
    const response = await request(`${config.issuer}${path}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
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
      if (
        response.status === 400 &&
        failure.success &&
        failure.data.error === "invalid_grant"
      )
        throw new NativeCredentialRejected();
      throw new Error("native OAuth authority request failed");
    }
    return body;
  };
  const introspection = await post(
    "/oauth/native/introspect",
    new URLSearchParams({ token }),
  );
  if (z.object({ active: z.literal(false) }).safeParse(introspection).success)
    throw new NativeCredentialRejected();
  const status = claimsSchema.parse(introspection);
  if (
    status.iss !== config.issuer ||
    status.aud[0] !== config.audience ||
    status.issuer_epoch !== config.epoch ||
    status.sub !== verified.payload.sub ||
    status.jti !== verified.payload.jti ||
    status.client_id !== verified.payload.client_id ||
    status.scope !== verified.payload.scope ||
    status.exp !== verified.payload.exp ||
    status.exp * 1000 + 30000 <= Date.now()
  )
    throw new NativeCredentialRejected();
  const exchangeStartedAt = Date.now();
  const exchanged = exchangeSchema.parse(
    await post(
      "/token",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: token,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        resource: config.apiAudience,
        scope: status.scope,
      }),
    ),
  );
  const derived = await jwtVerify(
    exchanged.access_token,
    createLocalJWKSet(config.keys),
    {
      issuer: config.issuer,
      audience: config.apiAudience,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: [
        "iat",
        "exp",
        "sub",
        "client_id",
        "scope",
        "issuer_epoch",
      ],
    },
  );
  if (
    derived.payload.sub !== status.sub ||
    derived.payload.client_id !== config.clientId ||
    derived.payload.issuer_epoch !== config.epoch ||
    derived.payload.scope !== exchanged.scope ||
    !["at+jwt", "application/at+jwt"].includes(
      derived.protectedHeader.typ ?? "",
    ) ||
    !Array.isArray(derived.payload.aud) ||
    derived.payload.aud.length !== 1 ||
    typeof derived.payload.exp !== "number" ||
    derived.payload.exp > status.exp ||
    typeof derived.payload.iat !== "number" ||
    derived.payload.exp - derived.payload.iat > 60 ||
    derived.payload.exp <= derived.payload.iat ||
    exchanged.scope
      .split(" ")
      .some((scope) => !status.scope.split(" ").includes(scope))
  )
    throw new Error("invalid native exchange");
  return {
    token: exchanged.access_token,
    subject: status.sub,
    scopes: exchanged.scope.split(" "),
    deadline:
      exchangeStartedAt +
      Math.min(
        exchanged.expires_in,
        derived.payload.exp - derived.payload.iat,
      ) *
        1000,
  };
}

// Native streams have a one-minute maximum lease; reconnect requires fresh authorization.
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
