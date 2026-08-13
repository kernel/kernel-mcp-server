import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpConnectionScopeFailureAnalytics } from "@/lib/mcp/analytics";
import { defaultMcpDependencies } from "@/lib/mcp/dependencies";

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
mock.module("@/lib/mcp/analytics", () => ({
  ...analytics,
  captureMcpConnectionScopeFailure: (
    ...args: Parameters<typeof analytics.captureMcpConnectionScopeFailure>
  ) => {
    captured.push(args[0]);
    return analytics.captureMcpConnectionScopeFailure(...args);
  },
}));

const originalCreateKernelClient = defaultMcpDependencies.createKernelClient;
const { POST, connectionScopeFailureResponse } = await import("./route");

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
});

afterEach(() => {
  defaultMcpDependencies.createKernelClient = originalCreateKernelClient;
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

describe("connectionScopeFailureResponse", () => {
  test("names an inactive project instead of blaming the credential", async () => {
    const response = connectionScopeFailureResponse({
      status: "rejected",
      statusCode: 404,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: "project_not_found",
      error_description:
        "The Kernel project for this connection was not found or is inactive",
    });
  });

  test("challenges a refused credential so clients re-authenticate", () => {
    const response = connectionScopeFailureResponse({
      status: "rejected",
      statusCode: 401,
    });

    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"',
    );
  });
});
