import { describe, expect, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  exchangeNativeOAuth,
  isNativeOAuthCredential,
  leaseNativeResponse,
  NativeScopeRejected,
  type NativeOAuthConfig,
} from "./native-oauth";

async function fixture(clockOffsetSeconds = 0) {
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: "RS256",
    use: "sig",
    kid: "test",
  };
  const config: NativeOAuthConfig = {
    issuer: "https://issuer.example",
    audience: "https://mcp.example",
    apiAudience: "https://api.example/",
    epoch: 1,
    clientId: "exchange-client",
    clientSecret: "test-secret",
    keys: { keys: [jwk] },
  };
  const now = Math.floor(Date.now() / 1000) + clockOffsetSeconds;
  const claims = {
    iss: config.issuer,
    aud: [config.audience],
    sub: "user_test",
    jti: "parent",
    iat: now,
    exp: now + 300,
    client_id: "client",
    issuer_epoch: 1,
    authorization_version: 1,
    scope: "browsers:read",
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "test" })
    .sign(keys.privateKey);
  const derived = await new SignJWT({
    ...claims,
    aud: [config.apiAudience],
    jti: "derived",
    exp: now + 45,
    client_id: config.clientId,
    act: { sub: `oauth-client:${config.clientId}` },
  })
    .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "test" })
    .sign(keys.privateKey);
  const calls: string[] = [];
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    if (String(url).endsWith("/introspect"))
      return Response.json({ ...claims, active: true });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("subject_token")).toBe(token);
    expect(form.get("resource")).toBe(config.apiAudience);
    return Response.json({
      access_token: derived,
      token_type: "Bearer",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      expires_in: 45,
      scope: claims.scope,
    });
  };
  return { config, token, derived, calls, request };
}

describe("native OAuth MCP consumer", () => {
  test("exchanges rather than passing through, rechecking status on every request", async () => {
    const f = await fixture();
    for (let n = 0; n < 2; n++) {
      const result = await exchangeNativeOAuth(
        f.token,
        new AbortController().signal,
        f.config,
        f.request,
      );
      expect(result.token).toBe(f.derived);
      expect(result.token).not.toBe(f.token);
      expect(result.scopes).toEqual(["browsers:read"]);
    }
    expect(f.calls.length).toBe(4);
  });
  test("bounds the lease by relative lifetime despite issuer clock skew", async () => {
    const f = await fixture(20);
    const started = Date.now();
    const result = await exchangeNativeOAuth(
      f.token,
      new AbortController().signal,
      f.config,
      f.request,
    );
    expect(result.deadline).toBeGreaterThan(started + 44000);
    expect(result.deadline).toBeLessThanOrEqual(Date.now() + 45000);
  });
  test("rejects wrong audiences and epochs before network access", async () => {
    const f = await fixture();
    for (const config of [
      { ...f.config, audience: f.config.apiAudience },
      { ...f.config, epoch: 2 },
    ]) {
      await expect(
        exchangeNativeOAuth(
          f.token,
          new AbortController().signal,
          config,
          f.request,
        ),
      ).rejects.toThrow();
    }
    expect(f.calls).toEqual([]);
  });
  test("revocation and authority outages cannot become Clerk fallback", async () => {
    const f = await fixture();
    for (const response of [
      Response.json({ active: false }),
      new Response(null, { status: 503 }),
    ]) {
      let calls = 0;
      const request = async () => {
        calls++;
        return response;
      };
      await expect(
        exchangeNativeOAuth(
          f.token,
          new AbortController().signal,
          f.config,
          request,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
    expect(isNativeOAuthCredential(f.token)).toBe(true);
    expect(isNativeOAuthCredential("krn_rt1_invalid")).toBe(true);
    expect(isNativeOAuthCredential("kernel_api_key")).toBe(false);
  });
  test("treats issuer scope and target rejection as permanent scope failures", async () => {
    for (const error of ["invalid_scope", "invalid_target"]) {
      const f = await fixture();
      const request = async (url: string, init: RequestInit) =>
        url.endsWith("/token")
          ? Response.json({ error }, { status: 400 })
          : f.request(url, init);
      await expect(
        exchangeNativeOAuth(
          f.token,
          new AbortController().signal,
          f.config,
          request,
        ),
      ).rejects.toBeInstanceOf(NativeScopeRejected);
    }
  });
  test("closes a stream when its short authorization lease ends", async () => {
    let cancelled = false;
    const abort = new AbortController();
    const response = leaseNativeResponse(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
      Date.now() + 20,
      abort,
    );
    const result = await response.body!.getReader().read();
    expect(result.done).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
});
