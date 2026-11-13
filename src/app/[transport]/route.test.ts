import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { decodeJwt } from "jose";
import { resetNativeOAuthForTests } from "@/lib/native-oauth";
import {
  memoryExchangeStore,
  nativeIssuer,
} from "@/lib/native-oauth.test-fixtures";
import { Kernel } from "@onkernel/sdk";
import type { McpConnectionScopeFailureAnalytics } from "@/lib/mcp/analytics";
import { defaultMcpDependencies } from "@/lib/mcp/dependencies";
import { clearMcpEntitlementsCacheForTests } from "@/lib/mcp/entitlements";
import { MCP_SESSION_HEADER } from "@posthog/mcp";
import { mcpAppsMarkerKey } from "@/lib/mcp-apps-marker";
import { oauthResourceMetadata } from "@/lib/oauth-discovery";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

// after() needs a Next request scope only the server provides. The route uses
// it to flush analytics, which these tests observe directly instead.
const nextServer = await import("next/server");
mock.module("next/server", () => ({ ...nextServer, after: () => {} }));

// Scope resolution runs before the instrumented McpServer exists, so this
// capture is the only record of it. Record the calls and delegate, so the
// module stays intact for anything else exercising it.
const captured: McpConnectionScopeFailureAnalytics[] = [];
const analytics = await import("@/lib/mcp/analytics");
const captureMcpConnectionScopeFailure =
  analytics.captureMcpConnectionScopeFailure;
const instrumentMcpAnalytics = analytics.instrumentMcpAnalytics;
const isMcpAnalyticsEnabled = analytics.isMcpAnalyticsEnabled;
let analyticsClient: unknown = null;
let forceAnalyticsEnabled = false;
mock.module("@/lib/mcp/analytics", () => ({
  ...analytics,
  instrumentMcpAnalytics: (
    ...[server, client]: Parameters<typeof instrumentMcpAnalytics>
  ) =>
    instrumentMcpAnalytics(
      server,
      (analyticsClient as typeof client) ?? client,
    ),
  isMcpAnalyticsEnabled: () => forceAnalyticsEnabled || isMcpAnalyticsEnabled(),
  captureMcpConnectionScopeFailure: (
    ...args: Parameters<typeof analytics.captureMcpConnectionScopeFailure>
  ) => {
    captured.push(args[0]);
    return captureMcpConnectionScopeFailure(...args);
  },
}));

// An in-memory MCP Apps marker store, keyed exactly as Redis keys it. The
// route records markers through mcp-apps-request's store and the App gate
// reads them through redis, so both are redirected while a test sets it.
let appMarkers: Set<string> | null = null;
type Marker = { authSubject: string; transportSessionId: string };
const markerKey = (marker: Marker) =>
  mcpAppsMarkerKey(marker.authSubject, marker.transportSessionId);
const memoryMarkers = {
  mark: async (marker: Marker) => void appMarkers!.add(markerKey(marker)),
  clear: async (marker: Marker) => void appMarkers!.delete(markerKey(marker)),
  has: async (marker: Marker) => appMarkers!.has(markerKey(marker)),
};
const redis = await import("@/lib/redis");
const { hasMcpAppsClient } = redis;
mock.module("@/lib/redis", () => ({
  ...redis,
  hasMcpAppsClient: (marker: Parameters<typeof hasMcpAppsClient>[0]) =>
    appMarkers ? memoryMarkers.has(marker) : hasMcpAppsClient(marker),
}));
const appsRequest = await import("@/lib/mcp-apps-request");
const { requestUsesMcpApps } = appsRequest;
mock.module("@/lib/mcp-apps-request", () => ({
  ...appsRequest,
  requestUsesMcpApps: (
    ...[req, identity, store]: Parameters<typeof requestUsesMcpApps>
  ) =>
    requestUsesMcpApps(
      req,
      identity,
      store ?? (appMarkers ? memoryMarkers : undefined),
    ),
}));

const originalCreateKernelClient = defaultMcpDependencies.createKernelClient;
const { GET, POST, connectionScopeFailureResponse } = await import("./route");

function initializeRequest(token = "sk_opaque_key") {
  return new Request("https://mcp.example.test/sse", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "route-test", version: "0" },
      },
    }),
  }) as never;
}

function failingAuthContext(error: unknown) {
  defaultMcpDependencies.createKernelClient = () =>
    ({
      auth: {
        context: {
          retrieve: async () => {
            throw error;
          },
        },
      },
    }) as never;
}

beforeEach(() => {
  captured.length = 0;
  clearMcpEntitlementsCacheForTests();
});

afterEach(() => {
  defaultMcpDependencies.createKernelClient = originalCreateKernelClient;
});

const nativeEnvKeys = Object.keys((await nativeIssuer()).env());

describe("native OAuth credentials", () => {
  const envKeys = nativeEnvKeys;
  const savedEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  let issuer: Awaited<ReturnType<typeof nativeIssuer>>;
  let kernelTokens: string[];
  let kernelPaths: string[];
  let browsersRequested: () => void;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(async () => {
    issuer = await nativeIssuer();
    Object.assign(process.env, issuer.env());
    resetNativeOAuthForTests(memoryExchangeStore().store);
    kernelTokens = [];
    kernelPaths = [];
    browsersRequested = () => {};
    defaultMcpDependencies.createKernelClient = (token) => {
      kernelTokens.push(token);
      return new Kernel({
        apiKey: token,
        baseURL: "https://api.example.test",
        maxRetries: 0,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          kernelPaths.push(path);
          if (path === "/org/entitlements")
            return Response.json({ features: { vaults: { enabled: true } } });
          // A call that outlives the request it belongs to.
          if (path === "/browsers") {
            browsersRequested();
            return new Promise<Response>(() => {});
          }
          if (path !== "/auth/context")
            throw new Error(`Unexpected API request: ${path}`);
          // GET /auth/context as the API answers an exchanged user token.
          return Response.json({
            authentication: {
              method: "jwt",
              source: "oauth",
              credential_id: null,
            },
            principal: { type: "user", id: "user_123" },
            organization: { id: "org_123" },
            authorization: {
              credential_scope: { project_id: "proj_123" },
              effective_scope: { project_id: "proj_123" },
            },
          });
        },
      });
    };
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => issuer.request(String(input), init ?? {})) as typeof fetch);
  });

  afterEach(() => {
    appMarkers = null;
    analyticsClient = null;
    forceAnalyticsEnabled = false;
    fetchSpy.mockRestore();
    for (const key of envKeys)
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    resetNativeOAuthForTests();
  });

  function mcpRequest(
    token: string,
    method = "tools/list",
    params?: object,
    headers: Record<string, string> = {},
  ) {
    return new nextServer.NextRequest("https://mcp.example.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  // Each refresh yields a new MCP token, so every exchanged token differs.
  const refreshed = () => issuer.parent();

  test("keep MCP Apps capability from initialize across rotated tokens", async () => {
    appMarkers = new Set();
    const initialized = await POST(
      mcpRequest(await refreshed(), "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } },
        clientInfo: { name: "apps-host", version: "1" },
      }),
    );
    expect(initialized.status).toBe(200);
    const session = initialized.headers.get(MCP_SESSION_HEADER)!;
    expect(session).toBeTruthy();
    await initialized.text();

    const call = await POST(
      mcpRequest(
        await refreshed(),
        "tools/call",
        {
          name: "begin_auth_login",
          arguments: { mode: "reauth", connection_id: "conn_1" },
        },
        { [MCP_SESSION_HEADER]: session },
      ),
    );
    expect(call.status).toBe(200);
    const text = await call.text();
    expect(text).toContain('"result"');
    expect(text).not.toContain("only available to the secure KERNEL login app");
    expect(issuer.requests).toHaveLength(2);
  });

  test("reuse the entitlements snapshot across rotated tokens", async () => {
    for (let n = 0; n < 2; n++) {
      const response = await POST(mcpRequest(await refreshed()));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("manage_vaults");
    }
    expect(new Set(kernelTokens).size).toBe(2);
    expect(kernelPaths.filter((path) => path === "/org/entitlements")).toEqual([
      "/org/entitlements",
    ]);
  });

  test("keep one analytics session across rotated tokens", async () => {
    const events: { properties: Record<string, unknown> }[] = [];
    analyticsClient = {
      capture: (event: { properties: Record<string, unknown> }) =>
        events.push(event),
    };
    for (let n = 0; n < 2; n++) {
      const response = await POST(mcpRequest(await refreshed()));
      expect(response.status).toBe(200);
      await response.text();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(events.map((event) => event.properties.$session_id)).size,
    ).toBe(1);
  });

  test("report connections as native OAuth in analytics", async () => {
    forceAnalyticsEnabled = true;
    const events: { event: string; properties: Record<string, unknown> }[] = [];
    analyticsClient = {
      capture: (event: {
        event: string;
        properties: Record<string, unknown>;
      }) => events.push(event),
    };
    const response = await POST(
      mcpRequest(await issuer.parent(), "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const initialize = events.find(
      (event) => event.event === "$mcp_initialize",
    );
    expect(initialize?.properties.$mcp_auth_method).toBe("native_oauth");
  });

  test("reuse one exchange per MCP token and re-resolve auth context each request", async () => {
    const parent = await issuer.parent();
    for (let n = 0; n < 3; n++) {
      const response = await POST(mcpRequest(parent, "ping"));
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(issuer.requests).toHaveLength(1);
    expect(kernelPaths.filter((path) => path === "/auth/context")).toHaveLength(
      3,
    );
  });

  test("are rejected like any untrusted token when native OAuth is off", async () => {
    for (const key of envKeys)
      if (key !== "API_BASE_URL") delete process.env[key];
    process.env.MANAGED_AUTH_APP_ORIGIN = "http://localhost:3002";
    resetNativeOAuthForTests(memoryExchangeStore().store);
    const response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("invalid_token");
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kernelTokens).toEqual([]);
  });

  test("reach the API only as the exchanged API-audience token", async () => {
    const parent = await issuer.parent();
    const response = await POST(mcpRequest(parent));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("manage_browsers");
    expect(issuer.requests).toHaveLength(1);
    expect(kernelTokens.length).toBeGreaterThan(0);
    for (const token of kernelTokens) {
      expect(token).not.toBe(parent);
      expect(decodeJwt(token).aud).toEqual([issuer.config.apiAudience]);
      expect(decodeJwt(token).parent_jti).toBe(decodeJwt(parent).jti);
    }
  });

  test("leave API keys on their existing path", async () => {
    const response = await POST(mcpRequest("sk_opaque_key"));
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kernelTokens.length).toBeGreaterThan(0);
    expect(kernelTokens.every((token) => token === "sk_opaque_key")).toBe(true);
  });

  test("revocation is 401 and scope rejection 403, never a fallback", async () => {
    const revokedParent = await issuer.parent();
    issuer.revoked.add(String(decodeJwt(revokedParent).jti));
    let response = await POST(mcpRequest(revokedParent));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: "Invalid or expired access token",
    });
    expect(captured).toEqual([
      {
        stage: "authentication",
        outcome: "rejected",
        credentialType: "native_oauth",
        upstreamStatusCode: undefined,
        responseStatusCode: 401,
      },
    ]);
    captured.length = 0;

    fetchSpy.mockImplementation((async (input: string | URL | Request) =>
      String(input).endsWith("/token")
        ? Response.json({ error: "invalid_scope" }, { status: 400 })
        : issuer.request(String(input), {})) as never);
    response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="OAuth", error="insufficient_scope"',
    );
    expect((await response.json()).error_description).toBe(
      "This credential's scope does not cover this request",
    );
    expect(kernelTokens).toEqual([]);
    expect(captured).toEqual([
      {
        stage: "authentication",
        outcome: "rejected",
        credentialType: "native_oauth",
        upstreamStatusCode: undefined,
        responseStatusCode: 403,
      },
    ]);
  });

  test("issuer outages are retryable 503s", async () => {
    fetchSpy.mockImplementation(
      (async () => new Response(null, { status: 503 })) as never,
    );
    const response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(kernelTokens).toEqual([]);
    expect(captured).toEqual([
      {
        stage: "authentication",
        outcome: "unavailable",
        credentialType: "native_oauth",
        upstreamStatusCode: undefined,
        responseStatusCode: 503,
      },
    ]);
  });

  test("post-authentication bugs propagate as server errors", async () => {
    failingAuthContext(new Error("unaccountable"));
    await expect(POST(mcpRequest(await issuer.parent()))).rejects.toThrow(
      "Unable to resolve Kernel connection scope",
    );
  });

  describe("end with the exchanged token", () => {
    let signedExpiry: number;
    const shortLived = () => {
      const exp = Math.floor(Date.now() / 1000) + 2;
      signedExpiry = exp * 1000;
      return issuer.parent({ exp });
    };

    // The stream stays open until, and not past, the exchanged token's
    // signed expiry (bounded by the incoming token's exp).
    async function closesAt(response: Response, started: number) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "text/event-stream",
      );
      await response.text();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(Date.now()).toBeGreaterThanOrEqual(signedExpiry - 100);
      expect(Date.now()).toBeLessThanOrEqual(signedExpiry + 250);
    }

    test("a legacy response stream", async () => {
      const token = await shortLived();
      const started = Date.now();
      let requested = false;
      browsersRequested = () => (requested = true);
      await closesAt(
        await POST(
          mcpRequest(token, "tools/call", {
            name: "manage_browsers",
            arguments: { action: "list" },
          }),
        ),
        started,
      );
      expect(requested).toBe(true);
    });

    test("a modern subscription stream", async () => {
      const token = await shortLived();
      const started = Date.now();
      await closesAt(
        await POST(
          new nextServer.NextRequest("https://mcp.example.test/mcp", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": "subscriptions/listen",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "subscriptions/listen",
              params: {
                notifications: { toolsListChanged: true },
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientInfo": {
                    name: "modern-client",
                    version: "1",
                  },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              },
            }),
          }),
        ),
        started,
      );
    });
  });
});

describe("unauthenticated discovery", () => {
  for (const method of ["GET", "POST"]) {
    test.each([
      [
        "https://mcp.onkernel.com",
        "mcp.onkernel.com",
        "https://mcp.onkernel.com",
      ],
      ["http://localhost:3002", "mcp.onkernel.com", "https://mcp.onkernel.com"],
      ["http://localhost:3002", "localhost:3002", "http://localhost:3002"],
      [
        "https://localhost:3000",
        "mcp-staging.onkernel.com",
        "https://mcp-staging.onkernel.com",
      ],
    ])(
      `${method} challenges point to path-specific discovery at %s (Host: %s)`,
      async (origin, host, publicOrigin) => {
        const req = new nextServer.NextRequest(`${origin}/mcp`, {
          method,
          headers: { Host: host, "X-Forwarded-Host": "ignored.example" },
        });
        const response = await (method === "GET" ? GET : POST)(req);
        expect(response.status).toBe(401);
        const challenge = response.headers.get("WWW-Authenticate");
        expect(challenge).toContain('Bearer realm="OAuth"');
        expect(challenge).toContain('error="invalid_token"');
        const metadataUrl = challenge?.match(
          /resource_metadata="([^"]+)"/,
        )?.[1];
        expect(metadataUrl).toBe(
          `${publicOrigin}/.well-known/oauth-protected-resource/mcp`,
        );
        const metadata = oauthResourceMetadata(new Request(metadataUrl!));
        expect(metadata.resource).toBe(`${publicOrigin}/mcp`);
      },
    );
  }
});

describe("credentials in the query string", () => {
  for (const method of ["GET", "POST"]) {
    for (const param of ["api_key", "token"]) {
      test(`${method} rejects a credential passed as ?${param}=`, async () => {
        const req = new nextServer.NextRequest(
          `https://mcp.example.test/mcp?${param}=sk_leaked_key`,
          { method, headers: { Authorization: "Bearer sk_leaked_key" } },
        );
        const response = await (method === "GET" ? GET : POST)(req);
        expect(response.status).toBe(400);
        const body = (await response.json()) as {
          error: string;
          error_description: string;
        };
        expect(body.error).toBe("credentials_in_query_string");
        expect(body.error_description).toContain("Authorization header");
        expect(body.error_description).not.toContain("sk_leaked_key");
      });
    }
  }

  test("ignores non-credential query params", async () => {
    const req = new nextServer.NextRequest(
      "https://mcp.example.test/mcp?foo=bar",
      { method: "GET" },
    );
    const response = await GET(req);
    expect(response.status).toBe(401);
  });
});

describe("connection scope failures through the handler", () => {
  test("answers a refused credential with 401 rather than a server error", async () => {
    failingAuthContext(Object.assign(new Error("revoked"), { status: 401 }));

    const response = await POST(initializeRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: "The Kernel API rejected this credential",
    });
    expect(captured).toEqual([
      {
        stage: "scope",
        outcome: "rejected",
        credentialType: "api_key",
        upstreamStatusCode: 401,
        responseStatusCode: 401,
      },
    ]);
  });

  test("keeps a credential scoped to another project usable", async () => {
    failingAuthContext(
      Object.assign(new Error("other project"), { status: 403 }),
    );

    const response = await POST(initializeRequest());

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("insufficient_scope");
    expect(captured[0]?.upstreamStatusCode).toBe(403);
    expect(captured[0]?.responseStatusCode).toBe(403);
  });

  test("answers an upstream outage with a retryable 503", async () => {
    failingAuthContext(
      Object.assign(new Error("unavailable"), { status: 502 }),
    );

    const response = await POST(initializeRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(captured).toEqual([
      {
        stage: "scope",
        outcome: "unavailable",
        credentialType: "api_key",
        upstreamStatusCode: 502,
        responseStatusCode: 503,
      },
    ]);
  });

  test("still surfaces an unaccountable failure as a server error", async () => {
    failingAuthContext(new TypeError("cannot read properties of undefined"));

    await expect(POST(initializeRequest())).rejects.toThrow(
      "Unable to resolve Kernel connection scope",
    );
    expect(captured).toEqual([
      {
        stage: "scope",
        outcome: "invalid",
        credentialType: "api_key",
      },
    ]);
  });
});

describe("capability routing", () => {
  function installKernelResponses(entitlements: (token: string) => Response) {
    const paths: string[] = [];
    defaultMcpDependencies.createKernelClient = (token) =>
      new Kernel({
        apiKey: token,
        baseURL: "https://api.example.test",
        maxRetries: 0,
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          if (path === "/auth/context")
            return Response.json({
              authentication: {
                method: "api_key",
                source: "api_key",
                credential_id: "key_test",
              },
              principal: { type: "api_key", id: "key_test" },
              organization: { id: token === "sk_allowed" ? "org_a" : "org_b" },
              authorization: {
                credential_scope: { project_id: null },
                effective_scope: { project_id: null },
              },
            });
          if (path === "/org/entitlements") return entitlements(token);
          if (path === "/search/providers") return Response.json([]);
          if (path === "/vaults")
            return Response.json([], {
              headers: { "x-has-more": "false", "x-next-offset": "0" },
            });
          throw new Error(`Unexpected API request: ${path}`);
        },
      });
    return paths;
  }

  async function call(method: string, token = "sk_allowed", params?: object) {
    const response = await POST(
      new nextServer.NextRequest("https://mcp.example.test/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const event = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(event ? event.slice(6) : text);
  }

  test("caches entitlement-gated tools per credential and MCP connection", async () => {
    let enabled = true;
    const paths = installKernelResponses((token) =>
      Response.json({
        features: {
          vaults: { enabled: token === "sk_allowed" && enabled },
          search: { enabled: false },
        },
      }),
    );
    const unrelated = await call("tools/call", "sk_allowed", {
      name: "get_connection_context",
      arguments: {},
    });
    expect(unrelated.result.isError).not.toBe(true);
    expect(paths).toEqual(["/auth/context"]);

    const allowed = await call("tools/list");
    expect(
      allowed.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("manage_vaults");
    const denied = await call("tools/list", "sk_denied");
    expect(
      denied.result.tools.filter((tool: { name: string }) =>
        tool.name.startsWith("manage_vault"),
      ),
    ).toHaveLength(0);
    expect(
      denied.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("manage_browsers");
    enabled = false;
    const stillExposed = await call("tools/call", "sk_allowed", {
      name: "manage_vaults",
      arguments: { action: "list" },
    });
    expect(stillExposed.result.isError).not.toBe(true);
    expect(paths).toEqual([
      "/auth/context",
      "/auth/context",
      "/org/entitlements",
      "/auth/context",
      "/org/entitlements",
      "/auth/context",
      "/vaults",
    ]);
  });

  test("gates Search per connection and keeps other callers isolated", async () => {
    let enabled = true;
    const paths = installKernelResponses((token) =>
      Response.json({
        features: {
          vaults: { enabled: true },
          search: { enabled: token === "sk_allowed" && enabled },
        },
      }),
    );
    const allowed = await call("tools/list");
    expect(
      allowed.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("web_search");
    const permittedCall = await call("tools/call", "sk_allowed", {
      name: "web_search",
      arguments: { action: "providers" },
    });
    expect(permittedCall.result.isError).not.toBe(true);
    expect(JSON.parse(permittedCall.result.content[0].text)).toEqual([]);
    const denied = await call("tools/list", "sk_denied");
    expect(
      denied.result.tools.map((tool: { name: string }) => tool.name),
    ).not.toContain("web_search");
    expect(
      denied.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("manage_vaults");
    const deniedCall = await call("tools/call", "sk_denied", {
      name: "web_search",
      arguments: { action: "create", request: { query: "test" } },
    });
    expect(JSON.stringify(deniedCall)).toContain("not found");
    enabled = false;
    const sameConnection = await call("tools/list", "sk_allowed");
    expect(
      sameConnection.result.tools.map((tool: { name: string }) => tool.name),
    ).toContain("web_search");
    expect(paths.filter((path) => path === "/org/entitlements")).toHaveLength(
      2,
    );
    expect(paths.filter((path) => path === "/search/providers")).toHaveLength(
      1,
    );
    expect(paths).not.toContain("/search");
  });

  test.each([200, 401, 403, 404, 429, 500, 503])(
    "search fails closed without hiding unrelated tools (HTTP %s)",
    async (status) => {
      installKernelResponses(() =>
        status === 200
          ? Response.json({ features: {} })
          : Response.json({}, { status }),
      );
      const result = await call("tools/list");
      const names = result.result.tools.map(
        (tool: { name: string }) => tool.name,
      );
      expect(names).not.toContain("web_search");
      expect(names).toContain("manage_browsers");
    },
  );

  test.each([200, 404, 503])(
    "keeps other tools available when entitlements are absent or fail (HTTP %s)",
    async (status) => {
      installKernelResponses(() =>
        Response.json({ features: { search: { enabled: true } } }, { status }),
      );
      const result = await call("tools/list");
      expect(
        result.result.tools.filter((tool: { name: string }) =>
          tool.name.startsWith("manage_vault"),
        ),
      ).toHaveLength(0);
      expect(
        result.result.tools.map((tool: { name: string }) => tool.name),
      ).toContain("manage_browsers");
    },
  );
});

describe("connectionScopeFailureResponse", () => {
  test("names an inactive project instead of blaming the credential", async () => {
    const response = connectionScopeFailureResponse(
      new Request("https://mcp.example.test/mcp"),
      {
        status: "rejected",
        statusCode: 404,
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: "project_not_found",
      error_description:
        "The Kernel project for this connection was not found or is inactive",
    });
  });

  test("challenges a refused credential so clients re-authenticate", () => {
    const response = connectionScopeFailureResponse(
      new Request("https://mcp.example.test/mcp"),
      {
        status: "rejected",
        statusCode: 401,
      },
    );
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );

    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"',
    );
  });
});
