import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import {
  authenticateNativeOAuth,
  isNativeOAuthCredential,
  nativeOAuthConfig,
  resetNativeOAuthForTests,
} from "./native-oauth";
import {
  memoryExchangeStore,
  nativeIssuer,
} from "./native-oauth.test-fixtures";

const ENV_KEYS = [
  "MANAGED_AUTH_APP_ORIGIN",
  "API_BASE_URL",
  "NATIVE_OAUTH_ISSUER",
  "NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID",
  "NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET",
];
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

let issuer: Awaited<ReturnType<typeof nativeIssuer>>;
let cache: ReturnType<typeof memoryExchangeStore>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

// A fresh server instance: configuration, keys and in-flight exchanges are
// per instance, while the exchanged-token cache is shared.
function newInstance() {
  resetNativeOAuthForTests(cache.store);
}

function useEnv(env: Record<string, string>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  newInstance();
}

const authenticate = (token: string) => authenticateNativeOAuth(token);

beforeEach(async () => {
  cache = memoryExchangeStore();
  issuer = await nativeIssuer();
  useEnv(issuer.env());
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => issuer.request(String(input), init ?? {})) as typeof fetch);
});

afterEach(() => {
  setSystemTime();
  fetchSpy.mockRestore();
  for (const key of ENV_KEYS)
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  resetNativeOAuthForTests();
});

describe("native credential detection", () => {
  test("selects only at+jwt tokens, as the Kernel API does", async () => {
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
  test("exchanges for the API audience with the RFC 8693 contract", async () => {
    const parent = await issuer.parent();
    const result = await authenticate(parent);
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.credential.subject).toBe("user_123");
    expect(result.credential.grantId).toBe("grant_123");
    expect(result.credential.scopes).toEqual(["openid", "email"]);
    const derived = decodeJwt(result.credential.token);
    expect(derived.aud).toEqual([issuer.config.apiAudience]);
    expect(derived.parent_jti).toBe(decodeJwt(parent).jti);

    expect(issuer.jwksRequests).toEqual([
      "https://auth.example.test/.well-known/jwks.json",
    ]);
    expect(issuer.requests).toHaveLength(1);
    const { url, init } = issuer.requests[0]!;
    expect(url).toBe("https://auth.example.test/token");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("kcl_mcp:secret%2B%2F%3D").toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: parent,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: "https://api.example.test",
      scope: "openid email",
    });
  });

  test("reuses an exchange across instances until a minute before expiry", async () => {
    const now = Date.now();
    setSystemTime(now);
    const parent = await issuer.parent();
    const first = await authenticate(parent);
    expect(first.status).toBe("ok");
    newInstance();
    expect(await authenticate(parent)).toEqual(first);
    expect(issuer.requests).toHaveLength(1);

    // A refreshed incoming token is a different cache entry.
    await authenticate(await issuer.parent());
    expect(issuer.requests).toHaveLength(2);

    // The 300s exchanged token is reused for 240s, then replaced.
    setSystemTime(now + 239_000);
    newInstance();
    expect(await authenticate(parent)).toEqual(first);
    setSystemTime(now + 241_000);
    const renewed = await authenticate(parent);
    if (renewed.status !== "ok" || first.status !== "ok")
      throw new Error("not ok");
    expect(renewed.credential.token).not.toBe(first.credential.token);
    expect(issuer.requests).toHaveLength(3);
  });

  test("stores only ciphertext that the incoming token alone can open", async () => {
    const parent = await issuer.parent();
    const result = await authenticate(parent);
    if (result.status !== "ok") throw new Error(result.status);
    const [[identity, { value }]] = [...cache.entries];
    expect(value).not.toContain(result.credential.token);
    expect(value).not.toContain(result.credential.token.split(".")[1]);
    expect(value).not.toContain(parent.split(".")[2]);

    // Another token's identity cannot reuse this ciphertext, and a corrupted
    // entry is discarded: both fall back to a fresh exchange.
    const other = await issuer.parent();
    const otherIdentity = identity!.replace(parent, other);
    cache.entries.set(otherIdentity, { value, expiresAt: Date.now() + 60_000 });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fresh = await authenticate(other);
      if (fresh.status !== "ok") throw new Error(fresh.status);
      expect(fresh.credential.token).not.toBe(result.credential.token);
      const corrupted = `${value.slice(0, -4)}AAAA`;
      cache.entries.set(identity!, {
        value: corrupted,
        expiresAt: Date.now() + 60_000,
      });
      newInstance();
      expect((await authenticate(parent)).status).toBe("ok");
      expect(issuer.requests).toHaveLength(3);
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain("discarded");
    } finally {
      warn.mockRestore();
    }
  });

  test("falls back to a fresh exchange when the cache fails or stalls", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parent = await issuer.parent();
      cache.state.fail = true;
      expect((await authenticate(parent)).status).toBe("ok");
      expect((await authenticate(parent)).status).toBe("ok");
      expect(issuer.requests).toHaveLength(2);

      cache.state.fail = false;
      cache.store.get = () => new Promise<string | null>(() => {});
      const started = Date.now();
      expect((await authenticate(parent)).status).toBe("ok");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(issuer.requests).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("coalesces concurrent exchanges of the same token on one instance", async () => {
    const parent = await issuer.parent();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => authenticate(parent)),
    );
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(
      1,
    );
    expect(issuer.requests).toHaveLength(1);
  });

  test("does not cache a token with under a minute left, and bounds its lifetime", async () => {
    const parent = await issuer.parent({
      exp: Math.floor(Date.now() / 1000) + 20,
    });
    const started = Date.now();
    const first = await authenticate(parent);
    if (first.status !== "ok") throw new Error(first.status);
    expect(first.credential.expiresAt).toBeGreaterThanOrEqual(started + 19_000);
    expect(first.credential.expiresAt).toBeLessThanOrEqual(Date.now() + 20_000);
    expect(cache.entries.size).toBe(0);
    await authenticate(parent);
    expect(issuer.requests).toHaveLength(2);
  });

  test("bounds the lifetime by the issuer's relative expiry despite clock skew", async () => {
    const skewed = Math.floor(Date.now() / 1000) + 20;
    issuer.deriveWith({ iat: skewed, exp: skewed + 15 });
    issuer.respondWith({ expires_in: 15 });
    const started = Date.now();
    const result = await authenticate(
      await issuer.parent({ exp: skewed + 15 }),
    );
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.credential.expiresAt).toBeGreaterThanOrEqual(
      started + 15_000,
    );
    expect(result.credential.expiresAt).toBeLessThanOrEqual(
      Date.now() + 15_000,
    );
  });

  test("caps the lifetime at the signed expiry when the issuer clock is behind", async () => {
    const behind = Math.floor(Date.now() / 1000) - 20;
    issuer.deriveWith({ iat: behind, exp: behind + 300 });
    const result = await authenticate(await issuer.parent());
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.credential.expiresAt).toBe((behind + 300) * 1000);
  });

  test("rejects tokens outside the issuer profile before any exchange", async () => {
    const now = Math.floor(Date.now() / 1000);
    const other = await generateKeyPair("RS256");
    const rejected = [
      await issuer.parent({ aud: [issuer.config.apiAudience] }),
      // The resource is the path-bearing MCP endpoint, not the bare origin.
      await issuer.parent({ aud: [issuer.config.origin] }),
      await issuer.parent({ aud: [issuer.config.audience, "https://x.test"] }),
      await issuer.parent({ iss: "https://other.example.test" }),
      await issuer.parent({ authorization_version: 2 }),
      await issuer.parent({ iat: now - 700, exp: now + 1 }),
      await issuer.parent({ iat: now - 120, exp: now - 60 }),
      await issuer.parent({ grant_id: undefined }),
      await issuer.parent({
        act: { sub: "oauth_client:kcl_mcp" },
        parent_jti: "jti_root",
      }),
      await issuer.sign(issuer.parentClaims(), { typ: "JWT" }),
      await new SignJWT(issuer.parentClaims())
        .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "kid-test" })
        .sign(other.privateKey),
      await issuer.parent({ pad: "x".repeat(4096) }),
    ];
    for (const token of rejected)
      expect(await authenticate(token)).toEqual({
        status: "rejected",
        statusCode: 401,
      });
    expect(issuer.requests).toEqual([]);
  });

  test("never fetches keys from a location named by the token", async () => {
    const token = await issuer.sign(issuer.parentClaims(), {
      jku: "https://evil.example.test/jwks.json",
    });
    expect((await authenticate(token)).status).toBe("ok");
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).not.toContain(
      "https://evil.example.test/jwks.json",
    );
  });

  test("an unreachable JWKS is unavailable, not a rejected credential", async () => {
    fetchSpy.mockImplementation((async () => {
      throw new TypeError("fetch failed");
    }) as never);
    expect(await authenticate(await issuer.parent())).toEqual({
      status: "unavailable",
    });
  });

  test("maps the issuer's OAuth errors", async () => {
    const cases: [() => Promise<Response>, unknown][] = [
      [
        async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
        { status: "rejected", statusCode: 401 },
      ],
      [
        async () => Response.json({ error: "invalid_scope" }, { status: 400 }),
        { status: "rejected", statusCode: 403 },
      ],
      [
        async () => Response.json({ error: "invalid_target" }, { status: 400 }),
        { status: "unavailable" },
      ],
      [
        async () =>
          Response.json({ error: "unauthorized_client" }, { status: 400 }),
        { status: "unavailable" },
      ],
      [
        async () => Response.json({ error: "invalid_client" }, { status: 401 }),
        { status: "unavailable" },
      ],
      [
        async () =>
          Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
        { status: "unavailable" },
      ],
      [
        async () => new Response("<html>", { status: 502 }),
        { status: "unavailable" },
      ],
      [
        async () => {
          throw new TypeError("fetch failed");
        },
        { status: "unavailable" },
      ],
    ];
    // Prime the JWKS so only the exchange fails.
    await authenticate(await issuer.parent());
    for (const [respond, expected] of cases) {
      const parent = await issuer.parent();
      fetchSpy.mockImplementation((async (input: string | URL | Request) =>
        String(input).endsWith("/token")
          ? respond()
          : issuer.request(String(input), {})) as never);
      expect(await authenticate(parent)).toEqual(expected as never);
    }
  });

  test("a revoked grant is rejected and never retried elsewhere", async () => {
    const parent = await issuer.parent();
    issuer.revoked.add(String(decodeJwt(parent).jti));
    expect(await authenticate(parent)).toEqual({
      status: "rejected",
      statusCode: 401,
    });
    expect(issuer.requests).toHaveLength(1);
  });

  test("an API audience the issuer does not serve is invalid_target", async () => {
    useEnv({ ...issuer.env(), API_BASE_URL: "https://api.other.test" });
    expect(await authenticate(await issuer.parent())).toEqual({
      status: "unavailable",
    });
    expect(
      new URLSearchParams(String(issuer.requests[0]!.init.body)).get(
        "resource",
      ),
    ).toBe("https://api.other.test");
  });

  test("an exchanged token outside the lineage fails closed and names the check", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const now = Math.floor(Date.now() / 1000);
      const broken: [
        Record<string, unknown>,
        Record<string, unknown>,
        string,
      ][] = [
        [{ aud: [issuer.config.audience] }, {}, "aud"],
        [{ iat: now, exp: now + 301 }, {}, "lifetime"],
        [{ sub: "user_other" }, {}, "sub"],
        [{ grant_id: "grant_other" }, {}, "grant_id"],
        [{ org_id: "org_other" }, {}, "org_id"],
        [{ project_id: undefined }, {}, "project_id"],
        [{ client_id: "kcl_other" }, {}, "client_id"],
        [{ act: { sub: "oauth_client:kcl_other" } }, {}, "act"],
        [{ act: undefined }, {}, "act"],
        [{ parent_jti: "jti_other" }, {}, "parent_jti"],
        [{ exp: now + 601, iat: now + 400 }, {}, "exp"],
        [
          { scope: "openid email admin" },
          { scope: "openid email admin" },
          "scope",
        ],
        [{}, { scope: "openid" }, "scope"],
        [
          {},
          { issued_token_type: "urn:ietf:params:oauth:token-type:jwt" },
          "RFC 8693",
        ],
      ];
      for (const [derived, response, check] of broken) {
        issuer.deriveWith(derived);
        issuer.respondWith(response);
        errors.mockClear();
        expect(await authenticate(await issuer.parent())).toEqual({
          status: "unavailable",
        });
        expect(String(errors.mock.calls[0]?.[0])).toContain(check);
      }
    } finally {
      errors.mockRestore();
    }
  });
});

describe("native configuration", () => {
  const dev = {
    MANAGED_AUTH_APP_ORIGIN: "https://mcp.dev.onkernel.com",
    API_BASE_URL: "https://api.dev.onkernel.com",
    NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID: "kcl_mcp",
    NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET: "secret+/=",
  };

  test("derives issuer, audiences and API from this server's public origin", async () => {
    issuer = await nativeIssuer({
      issuer: "https://auth.dev.onkernel.com",
      origin: "https://mcp.dev.onkernel.com",
      apiAudience: "https://api.dev.onkernel.com",
    });
    useEnv(dev);
    expect(nativeOAuthConfig()).toEqual({
      issuer: "https://auth.dev.onkernel.com",
      audience: "https://mcp.dev.onkernel.com/mcp",
      apiAudience: "https://api.dev.onkernel.com",
      clientId: "kcl_mcp",
      clientSecret: "secret+/=",
    });
    expect((await authenticate(await issuer.parent())).status).toBe("ok");
    expect(issuer.jwksRequests).toEqual([
      "https://auth.dev.onkernel.com/.well-known/jwks.json",
    ]);
    expect(issuer.requests[0]!.url).toBe("https://auth.dev.onkernel.com/token");
  });

  test("treats an unset public origin as production, like the managed-auth app", () => {
    useEnv({
      API_BASE_URL: "https://api.onkernel.com",
      NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID: "kcl_mcp",
      NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET: "secret",
    });
    expect(nativeOAuthConfig()).toMatchObject({
      issuer: "https://auth.onkernel.com",
      audience: "https://mcp.onkernel.com/mcp",
    });
  });

  test.each([
    ["NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID", undefined],
    ["NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET", undefined],
    ["NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET", ""],
    ["API_BASE_URL", undefined],
    ["API_BASE_URL", "https://api.onkernel.com"],
    ["NATIVE_OAUTH_ISSUER", "https://auth.dev.onkernel.com"],
  ])("a Kernel deployment refuses to start with %s=%s", (key, value) => {
    const env: Record<string, string> = { ...dev };
    if (value === undefined) delete env[key];
    else env[key] = value;
    useEnv(env);
    expect(() => nativeOAuthConfig()).toThrow();
  });

  test("other origins without native settings reject native tokens like any untrusted token", async () => {
    useEnv({
      MANAGED_AUTH_APP_ORIGIN: "http://localhost:3002",
      API_BASE_URL: "https://api.dev.onkernel.com",
    });
    expect(nativeOAuthConfig()).toBeNull();
    expect(await authenticate(await issuer.parent())).toEqual({
      status: "rejected",
      statusCode: 401,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("accepts a loopback issuer for local development", () => {
    useEnv({
      ...issuer.env(),
      MANAGED_AUTH_APP_ORIGIN: "http://localhost:3002",
      NATIVE_OAUTH_ISSUER: "http://localhost:3001",
      API_BASE_URL: "http://localhost:3001",
    });
    expect(nativeOAuthConfig()).toMatchObject({
      issuer: "http://localhost:3001",
      audience: "http://localhost:3002/mcp",
      apiAudience: "http://localhost:3001",
    });
  });

  test.each([
    ["NATIVE_OAUTH_ISSUER", undefined],
    ["NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID", undefined],
    ["NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET", undefined],
    ["API_BASE_URL", undefined],
    ["NATIVE_OAUTH_ISSUER", "http://auth.example.test"],
    ["NATIVE_OAUTH_ISSUER", "https://auth.example.test/"],
  ])("other origins refuse partial settings: %s=%s", (key, value) => {
    const env: Record<string, string> = issuer.env();
    if (value === undefined) delete env[key];
    else env[key] = value;
    useEnv(env);
    expect(() => nativeOAuthConfig()).toThrow();
  });

  test("startup fails on invalid settings and reports the native state", async () => {
    const { register } = await import("@/instrumentation");
    const info = spyOn(console, "info").mockImplementation(() => {});
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      await register();
      expect(String(info.mock.calls[0]?.[0])).toContain(
        "native OAuth enabled: issuer https://auth.example.test",
      );
      useEnv({ ...dev, NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET: "" });
      await expect(register()).rejects.toThrow(
        "NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET",
      );
    } finally {
      delete process.env.NEXT_RUNTIME;
      info.mockRestore();
    }
  });
});
