import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import type { NativeOAuthConfig } from "./native-oauth";

const ACCESS_TOKEN_URN = "urn:ietf:params:oauth:token-type:access_token";

// Shapes follow the deployed Kernel API issuer (packages/api/lib/oauthnative):
// AccessClaims, Service.Exchange and the RFC 8693 handler in lib/oauthas.
export async function nativeIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const kid = "kid-test";
  const config: NativeOAuthConfig = {
    issuer: "https://auth.example.test",
    audience: "https://mcp.example.test",
    apiAudience: "https://api.example.test",
    epoch: 1,
    clientId: "kcl_mcp",
    clientSecret: "secret+/=",
    keys: { keys: [{ ...(await exportJWK(publicKey)), kid }] },
  };

  async function sign(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid, ...header })
      .sign(privateKey);
  }

  function parentClaims(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: config.issuer,
      sub: "user_123",
      aud: [config.audience],
      exp: now + 600,
      iat: now,
      jti: "jti_parent",
      client_id: "kcl_desktop",
      grant_id: "grant_123",
      sub_kind: "user",
      org_id: "org_123",
      project_id: "proj_123",
      scope: "openid email",
      authorization_version: 1,
      issuer_epoch: config.epoch,
      grant_authorization_epoch: 1,
      registration_security_version: 1,
      ...overrides,
    };
  }

  const revoked = new Set<string>();
  const requests: { url: string; init: RequestInit }[] = [];
  let derivedOverrides: Record<string, unknown> = {};
  let responseOverrides: Record<string, unknown> = {};

  // Mirrors Service.Exchange: verify the MCP-audience parent, reject
  // exchanged parents and inactive grants, narrow scopes, then sign an
  // API-audience token living min(5m, parent remaining lifetime).
  async function request(url: string, init: RequestInit): Promise<Response> {
    requests.push({ url, init });
    const error = (code: string, status = 400) =>
      Response.json({ error: code }, { status });
    if (url !== `${config.issuer}/token`) return error("not_found", 404);
    const basic = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`;
    if (new Headers(init.headers).get("Authorization") !== basic)
      return error("invalid_client", 401);
    const form = new URLSearchParams(String(init.body));
    if (
      form.get("grant_type") !==
        "urn:ietf:params:oauth:grant-type:token-exchange" ||
      !form.get("subject_token") ||
      form.get("subject_token_type") !== ACCESS_TOKEN_URN ||
      (form.get("requested_token_type") ?? ACCESS_TOKEN_URN) !==
        ACCESS_TOKEN_URN ||
      form.has("actor_token") ||
      form.has("audience")
    )
      return error("invalid_request");
    const verified = await jwtVerify(
      form.get("subject_token")!,
      async () => publicKey,
      { issuer: config.issuer, audience: config.audience },
    ).catch(() => null);
    const parent = verified?.payload as Record<string, unknown> | undefined;
    if (!parent || parent.act || parent.parent_jti)
      return error("invalid_grant");
    if (revoked.has(String(parent.jti))) return error("invalid_grant");
    const granted = String(parent.scope).split(" ");
    const requested = (form.get("scope") ?? "").split(" ").filter(Boolean);
    if (requested.some((scope) => !granted.includes(scope)))
      return error("invalid_scope");
    const now = Math.floor(Date.now() / 1000);
    const lifetime = Math.min(300, Number(parent.exp) - now);
    if (lifetime <= 0) return error("invalid_grant");
    const scope = (requested.length ? requested : granted).join(" ");
    const derived = await sign({
      ...parent,
      aud: [config.apiAudience],
      iat: now,
      exp: now + lifetime,
      jti: crypto.randomUUID(),
      client_id: config.clientId,
      scope,
      act: { sub: `oauth_client:${config.clientId}` },
      parent_jti: parent.jti,
      actor_registration_security_version: 1,
      ...derivedOverrides,
    });
    return Response.json({
      access_token: derived,
      token_type: "Bearer",
      expires_in: lifetime,
      scope,
      org_id: parent.org_id,
      access_scope: parent.project_id ? "project" : "organization",
      project_id: parent.project_id,
      issued_token_type: ACCESS_TOKEN_URN,
      ...responseOverrides,
    });
  }

  return {
    config,
    sign,
    parentClaims,
    parent: (overrides: Record<string, unknown> = {}) =>
      sign(parentClaims(overrides)),
    request,
    requests,
    revoked,
    deriveWith(overrides: Record<string, unknown>) {
      derivedOverrides = overrides;
    },
    respondWith(overrides: Record<string, unknown>) {
      responseOverrides = overrides;
    },
  };
}
