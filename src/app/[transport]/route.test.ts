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
import { nativeIssuer } from "@/lib/native-oauth.test-fixtures";
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
let analyticsClient: unknown = null;
mock.module("@/lib/mcp/analytics", () => ({
  ...analytics,
  instrumentMcpAnalytics: (
    ...[server, client]: Parameters<typeof instrumentMcpAnalytics>
  ) =>
    instrumentMcpAnalytics(server, (analyticsClient as typeof client) ?? client),
  captureMcpConnectionScopeFailure: (
    ...args: Parameters<typeof analytics.captureMcpConnectionScopeFailure>
  ) => {
    captured.push(args[0]);
    return captureMcpConnectionScopeFailure(...args);
  },
}));

// An in-memory MCP Apps marker store, keyed exactly as Redis keys it.
let appMarkers: Set<string> | null = null;
const redis = await import("@/lib/redis");
const { markMcpAppsClient, clearMcpAppsClient, hasMcpAppsClient } = redis;
const markerKey = (marker: {
  authSubject: string;
  transportSessionId: string;
}) => mcpAppsMarkerKey(marker.authSubject, marker.transportSessionId);
mock.module("@/lib/redis", () => ({
  ...redis,
  markMcpAppsClient: async (marker: Parameters<typeof markMcpAppsClient>[0]) =>
    appMarkers
      ? void appMarkers.add(markerKey(marker))
      : markMcpAppsClient(marker),
  clearMcpAppsClient: async (
    marker: Parameters<typeof clearMcpAppsClient>[0],
  ) =>
    appMarkers
      ? void appMarkers.delete(markerKey(marker))
      : clearMcpAppsClient(marker),
  hasMcpAppsClient: async (marker: Parameters<typeof hasMcpAppsClient>[0]) =>
    appMarkers ? appMarkers.has(markerKey(marker)) : hasMcpAppsClient(marker),
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

describe("native OAuth credentials", () => {
  const nativeEnv = Object.keys(process.env).filter((key) =>
    key.startsWith("OAUTH_NATIVE_"),
  );
  let issuer: Awaited<ReturnType<typeof nativeIssuer>>;
  let kernelTokens: string[];
  let kernelPaths: string[];
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(async () => {
    issuer = await nativeIssuer();
    kernelTokens = [];
    kernelPaths = [];
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
    fetchSpy.mockRestore();
    for (const key of Object.keys(process.env))
      if (key.startsWith("OAUTH_NATIVE_") && !nativeEnv.includes(key))
        delete process.env[key];
  });

  function enable() {
    Object.assign(process.env, {
      OAUTH_NATIVE_ENABLED: "true",
      OAUTH_NATIVE_ISSUER: issuer.config.issuer,
      OAUTH_NATIVE_MCP_AUDIENCE: issuer.config.audience,
      OAUTH_NATIVE_API_AUDIENCE: issuer.config.apiAudience,
      OAUTH_NATIVE_ISSUER_EPOCH: String(issuer.config.epoch),
      OAUTH_NATIVE_VERIFICATION_JWKS: JSON.stringify(issuer.config.keys),
      OAUTH_NATIVE_EXCHANGE_CLIENT: issuer.config.clientId,
      OAUTH_NATIVE_EXCHANGE_SECRET: issuer.config.clientSecret,
    });
  }

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

  // A refreshed MCP token carries a new jti, so every derived token differs.
  const refreshed = () => issuer.parent({ jti: crypto.randomUUID() });

  test("keep MCP Apps capability from initialize across rotated tokens", async () => {
    enable();
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
  });

  test("reuse the entitlements snapshot across rotated tokens", async () => {
    enable();
    for (let n = 0; n < 2; n++) {
      const response = await POST(mcpRequest(await refreshed()));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("manage_vaults");
    }
    expect(new Set(kernelTokens).size).toBe(2);
    expect(kernelPaths.filter((path) => path === "/org/entitlements")).toEqual(
      ["/org/entitlements"],
    );
  });

  test("keep one analytics session across rotated tokens", async () => {
    enable();
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

  test("are rejected without contacting the issuer or API while disabled", async () => {
    delete process.env.OAUTH_NATIVE_ENABLED;
    const response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kernelTokens).toEqual([]);
  });

  test("reach the API only as the exchanged API-audience token", async () => {
    enable();
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
      expect(decodeJwt(token).parent_jti).toBe("jti_parent");
    }
  });

  test("leave API keys on their existing path when enabled", async () => {
    enable();
    const response = await POST(mcpRequest("sk_opaque_key"));
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kernelTokens.length).toBeGreaterThan(0);
    expect(kernelTokens.every((token) => token === "sk_opaque_key")).toBe(true);
  });

  test("revocation is 401 and scope rejection 403, never a fallback", async () => {
    enable();
    issuer.revoked.add("jti_parent");
    let response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("invalid_token");

    fetchSpy.mockImplementation((async () =>
      Response.json({ error: "invalid_scope" }, { status: 400 })) as never);
    response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "insufficient_scope",
    );
    expect(kernelTokens).toEqual([]);
  });

  test("issuer outages and misconfiguration are retryable 503s", async () => {
    enable();
    fetchSpy.mockImplementation(
      (async () => new Response(null, { status: 503 })) as never,
    );
    let response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");

    process.env.OAUTH_NATIVE_API_AUDIENCE = `${issuer.config.apiAudience}/`;
    response = await POST(mcpRequest(await issuer.parent()));
    expect(response.status).toBe(503);
    expect(kernelTokens).toEqual([]);
  });

  test("post-authentication bugs propagate as server errors", async () => {
    enable();
    failingAuthContext(new Error("unaccountable"));
    await expect(POST(mcpRequest(await issuer.parent()))).rejects.toThrow(
      "Unable to resolve Kernel connection scope",
    );
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
        outcome: "rejected",
        credentialType: "api_key",
        upstreamStatusCode: 401,
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
        outcome: "unavailable",
        credentialType: "api_key",
        upstreamStatusCode: 502,
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
        outcome: "invalid",
        credentialType: "api_key",
        upstreamStatusCode: undefined,
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
