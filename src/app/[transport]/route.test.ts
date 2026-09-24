import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import type { McpConnectionScopeFailureAnalytics } from "@/lib/mcp/analytics";
import { defaultMcpDependencies } from "@/lib/mcp/dependencies";
import { clearMcpSearchEntitlementCacheForTests } from "@/lib/mcp/entitlements";
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
mock.module("@/lib/mcp/analytics", () => ({
  ...analytics,
  captureMcpConnectionScopeFailure: (
    ...args: Parameters<typeof analytics.captureMcpConnectionScopeFailure>
  ) => {
    captured.push(args[0]);
    return captureMcpConnectionScopeFailure(...args);
  },
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
  clearMcpSearchEntitlementCacheForTests();
});

afterEach(() => {
  defaultMcpDependencies.createKernelClient = originalCreateKernelClient;
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

  test("selects tools per credential and rechecks access after revocation", async () => {
    let enabled = true;
    const paths = installKernelResponses((token) =>
      Response.json({
        features: {
          vaults: { enabled: token === "sk_allowed" && enabled },
          search: { enabled: false },
        },
      }),
    );
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
    const revoked = await call("tools/call", "sk_allowed", {
      name: "manage_vaults",
      arguments: { action: "list" },
    });
    expect(JSON.stringify(revoked)).toContain("not found");
    expect(paths).toEqual([
      "/auth/context",
      "/org/entitlements",
      "/auth/context",
      "/org/entitlements",
      "/auth/context",
      "/org/entitlements",
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
      5,
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
