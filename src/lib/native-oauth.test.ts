import { afterEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import {
  exchangeNativeOAuth,
  isNativeOAuthCredential,
  leaseNativeResponse,
  NATIVE_STREAM_LEASE_MS,
  nativeOAuthConfig,
  NativeCredentialRejected,
  NativeScopeRejected,
} from "./native-oauth";
import { nativeIssuer } from "./native-oauth.test-fixtures";

const signal = () => new AbortController().signal;

describe("native credential detection", () => {
  test("selects only at+jwt tokens, as the Kernel API does", async () => {
    const issuer = await nativeIssuer();
    expect(isNativeOAuthCredential(await issuer.parent())).toBe(true);
    expect(
      isNativeOAuthCredential(
        await issuer.sign(issuer.parentClaims(), {
          typ: "Application/AT+JWT",
        }),
      ),
    ).toBe(true);
    // Clerk session tokens, opaque API keys and malformed values keep their path.
    expect(
      isNativeOAuthCredential(
        await issuer.sign(issuer.parentClaims(), { typ: "JWT" }),
      ),
    ).toBe(false);
    expect(isNativeOAuthCredential("sk_opaque_key")).toBe(false);
    expect(isNativeOAuthCredential("krn_rt1_value")).toBe(false);
    expect(isNativeOAuthCredential("a.b.c")).toBe(false);
  });
});

describe("native token exchange", () => {
  test("exchanges every request with the issuer's RFC 8693 contract", async () => {
    const issuer = await nativeIssuer();
    const parent = await issuer.parent();
    for (let n = 0; n < 2; n++) {
      const result = await exchangeNativeOAuth(
        parent,
        signal(),
        issuer.config,
        issuer.request,
      );
      expect(result.token).not.toBe(parent);
      expect(result.subject).toBe("user_123");
      expect(result.scopes).toEqual(["openid", "email"]);
    }
    expect(issuer.requests).toHaveLength(2);
    const { url, init } = issuer.requests[0]!;
    expect(url).toBe("https://auth.example.test/token");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: parent,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "openid email",
    });
  });

  test("accepts five-minute exchanged tokens but leases one minute", async () => {
    const issuer = await nativeIssuer();
    const started = Date.now();
    const result = await exchangeNativeOAuth(
      await issuer.parent(),
      signal(),
      issuer.config,
      issuer.request,
    );
    expect(result.deadline).toBeGreaterThanOrEqual(
      started + NATIVE_STREAM_LEASE_MS,
    );
    expect(result.deadline).toBeLessThanOrEqual(
      Date.now() + NATIVE_STREAM_LEASE_MS,
    );
  });

  test("bounds the lease by a shorter remaining parent lifetime despite issuer skew", async () => {
    const issuer = await nativeIssuer();
    const skew = 20;
    const now = Math.floor(Date.now() / 1000) + skew;
    // The issuer derives the remaining lifetime from its own clock; only the
    // relative lifetime bounds the local lease.
    issuer.deriveWith({ iat: now, exp: now + 15 });
    issuer.respondWith({ expires_in: 15 });
    const started = Date.now();
    const result = await exchangeNativeOAuth(
      await issuer.parent({ exp: now + 15 }),
      signal(),
      issuer.config,
      issuer.request,
    );
    expect(result.deadline).toBeGreaterThanOrEqual(started + 15000);
    expect(result.deadline).toBeLessThanOrEqual(Date.now() + 15000);
  });

  test("a parent at the end of its life is rejected for refresh", async () => {
    const issuer = await nativeIssuer();
    issuer.respondWith({ expires_in: 0 });
    await expect(
      exchangeNativeOAuth(
        await issuer.parent(),
        signal(),
        issuer.config,
        issuer.request,
      ),
    ).rejects.toBeInstanceOf(NativeCredentialRejected);
  });

  test("rejects parents outside the issuer profile before any network call", async () => {
    const issuer = await nativeIssuer();
    const now = Math.floor(Date.now() / 1000);
    const other = await generateKeyPair("RS256");
    const rejected = [
      await issuer.parent({ aud: [issuer.config.apiAudience] }),
      await issuer.parent({ aud: [issuer.config.audience, "https://x.test"] }),
      await issuer.parent({ iss: "https://other.example.test" }),
      await issuer.parent({ issuer_epoch: 2 }),
      await issuer.parent({ authorization_version: 2 }),
      await issuer.parent({ iat: now - 700, exp: now + 1 }),
      await issuer.parent({ iat: now - 120, exp: now - 60 }),
      await issuer.parent({ grant_id: undefined }),
      await issuer.parent({
        act: { sub: "oauth_client:kcl_mcp" },
        parent_jti: "jti_root",
      }),
      await issuer.sign(issuer.parentClaims(), { typ: "JWT" }),
      await issuer.sign(issuer.parentClaims(), { kid: "unknown" }),
      await issuer.sign(issuer.parentClaims(), { kid: undefined }),
      await issuer.parent({ pad: "x".repeat(4096) }),
    ];
    for (const token of rejected)
      await expect(
        exchangeNativeOAuth(token, signal(), issuer.config, issuer.request),
      ).rejects.toBeInstanceOf(NativeCredentialRejected);
    await expect(
      exchangeNativeOAuth(
        await issuer.parent(),
        signal(),
        {
          ...issuer.config,
          keys: {
            keys: [{ ...(await exportJWK(other.publicKey)), kid: "kid-test" }],
          },
        },
        issuer.request,
      ),
    ).rejects.toBeInstanceOf(NativeCredentialRejected);
    expect(issuer.requests).toEqual([]);
  });

  test("revocation is a credential rejection, never a fallback", async () => {
    const issuer = await nativeIssuer();
    issuer.revoked.add("jti_parent");
    await expect(
      exchangeNativeOAuth(
        await issuer.parent(),
        signal(),
        issuer.config,
        issuer.request,
      ),
    ).rejects.toBeInstanceOf(NativeCredentialRejected);
    expect(issuer.requests).toHaveLength(1);
  });

  test("scope rejection is permanent; other issuer failures are retryable", async () => {
    const issuer = await nativeIssuer();
    const parent = await issuer.parent();
    const cases: [Response, unknown][] = [
      [
        Response.json({ error: "invalid_scope" }, { status: 400 }),
        NativeScopeRejected,
      ],
      [
        Response.json({ error: "invalid_grant" }, { status: 400 }),
        NativeCredentialRejected,
      ],
      [Response.json({ error: "unauthorized_client" }, { status: 400 }), Error],
      [Response.json({ error: "invalid_client" }, { status: 401 }), Error],
      [
        Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
        Error,
      ],
      [new Response("<html>", { status: 400 }), Error],
    ];
    for (const [response, kind] of cases) {
      const failure = await exchangeNativeOAuth(
        parent,
        signal(),
        issuer.config,
        async () => response,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(kind as typeof Error);
      if (kind === Error) {
        expect(failure).not.toBeInstanceOf(NativeCredentialRejected);
        expect(failure).not.toBeInstanceOf(NativeScopeRejected);
      }
    }
  });

  test("a derived token outside the exchange lineage fails closed", async () => {
    const issuer = await nativeIssuer();
    const parent = await issuer.parent();
    const now = Math.floor(Date.now() / 1000);
    const broken: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ aud: [issuer.config.audience] }, {}],
      [{ iat: now, exp: now + 301 }, {}],
      [{ exp: now + 601, iat: now + 400 }, {}],
      [{ sub: "user_other" }, {}],
      [{ grant_id: "grant_other" }, {}],
      [{ org_id: "org_other" }, {}],
      [{ project_id: undefined }, {}],
      [{ client_id: "kcl_other" }, {}],
      [{ act: { sub: "oauth_client:kcl_other" } }, {}],
      [{ act: undefined }, {}],
      [{ parent_jti: "jti_other" }, {}],
      [{ issuer_epoch: 2 }, {}],
      [{ scope: "openid email admin" }, { scope: "openid email admin" }],
      [{}, { scope: "openid" }],
      [{}, { issued_token_type: "urn:ietf:params:oauth:token-type:jwt" }],
    ];
    for (const [derived, response] of broken) {
      issuer.deriveWith(derived);
      issuer.respondWith(response);
      const failure = await exchangeNativeOAuth(
        parent,
        signal(),
        issuer.config,
        issuer.request,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(NativeCredentialRejected);
    }
  });

  test("the exchange request ends with the client request", async () => {
    const issuer = await nativeIssuer();
    const abort = new AbortController();
    abort.abort();
    let seen: AbortSignal | undefined;
    await expect(
      exchangeNativeOAuth(
        await issuer.parent(),
        abort.signal,
        issuer.config,
        async (_url, init) => {
          seen = init.signal ?? undefined;
          throw new Error("aborted");
        },
      ),
    ).rejects.toThrow("aborted");
    expect(seen?.aborted).toBe(true);
  });
});

describe("native configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith("OAUTH_NATIVE_")) delete process.env[key];
    Object.assign(process.env, saved);
  });

  async function enable(overrides: Record<string, string | undefined> = {}) {
    const { publicKey } = await generateKeyPair("RS256");
    Object.assign(process.env, {
      OAUTH_NATIVE_ENABLED: "true",
      OAUTH_NATIVE_ISSUER: "https://auth.dev.example.test",
      OAUTH_NATIVE_MCP_AUDIENCE: "https://mcp.dev.example.test",
      OAUTH_NATIVE_API_AUDIENCE: "https://api.dev.example.test",
      OAUTH_NATIVE_ISSUER_EPOCH: "1",
      OAUTH_NATIVE_VERIFICATION_JWKS: JSON.stringify({
        keys: [
          {
            ...(await exportJWK(publicKey)),
            kid: "k1",
            alg: "RS256",
            use: "sig",
          },
        ],
      }),
      OAUTH_NATIVE_EXCHANGE_CLIENT: "kcl_mcp",
      OAUTH_NATIVE_EXCHANGE_SECRET: "secret",
    });
    for (const [key, value] of Object.entries(overrides))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }

  test("is off without any native settings", () => {
    delete process.env.OAUTH_NATIVE_ENABLED;
    expect(nativeOAuthConfig()).toBeNull();
    process.env.OAUTH_NATIVE_ENABLED = "false";
    expect(nativeOAuthConfig()).toBeNull();
  });

  test("pins every trust input when enabled", async () => {
    await enable();
    const config = nativeOAuthConfig()!;
    expect(config.issuer).toBe("https://auth.dev.example.test");
    expect(config.audience).toBe("https://mcp.dev.example.test");
    expect(config.apiAudience).toBe("https://api.dev.example.test");
    expect(Object.keys(config.keys.keys[0]!).sort()).toEqual([
      "e",
      "kid",
      "kty",
      "n",
    ]);
  });

  test.each([
    ["OAUTH_NATIVE_ISSUER", undefined],
    ["OAUTH_NATIVE_ISSUER", "http://auth.dev.example.test"],
    ["OAUTH_NATIVE_MCP_AUDIENCE", "https://mcp.dev.example.test/mcp"],
    ["OAUTH_NATIVE_API_AUDIENCE", "https://api.dev.example.test/"],
    ["OAUTH_NATIVE_API_AUDIENCE", "https://mcp.dev.example.test"],
    ["OAUTH_NATIVE_ISSUER_EPOCH", "0"],
    ["OAUTH_NATIVE_VERIFICATION_JWKS", undefined],
    ["OAUTH_NATIVE_VERIFICATION_JWKS", '{"keys":[]}'],
    ["OAUTH_NATIVE_EXCHANGE_SECRET", undefined],
  ])("rejects %s=%s", async (key, value) => {
    await enable({ [key]: value });
    expect(() => nativeOAuthConfig()).toThrow();
  });

  test("refuses private key material in the verification set", async () => {
    const { privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    await enable({
      OAUTH_NATIVE_VERIFICATION_JWKS: JSON.stringify({
        keys: [{ ...(await exportJWK(privateKey)), kid: "k1" }],
      }),
    });
    expect(() => nativeOAuthConfig()).toThrow();
  });
});

describe("native stream lease", () => {
  test("closes a stream when its authorization lease ends", async () => {
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
