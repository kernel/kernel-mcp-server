import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PostHog } from "posthog-node";
import {
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "@posthog/mcp";
import {
  captureOAuthTokenExchange,
  enrichMcpAnalyticsEvent,
  instrumentMcpAnalytics,
  OAUTH_TOKEN_EXCHANGE_EVENT,
  sanitizeMcpAnalyticsEvent,
} from "@/lib/mcp/analytics";

const privateContextProperty = "__mcp_connection_analytics_context";

function initializeEvent(
  sessionId: string,
  context: {
    authMethod: "api_key" | "oauth";
    credentialScope: "organization" | "project";
    connectionScope: "organization" | "project";
    scopeSource: "credential" | "server_pin";
    organizationId: string;
    userId: string | null;
  },
): {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
} {
  return {
    event: PostHogMCPAnalyticsEvent.Initialize,
    distinct_id: sessionId,
    properties: {
      [PostHogMCPAnalyticsProperty.SessionId]: sessionId,
      $process_person_profile: false,
      [privateContextProperty]: context,
    },
  };
}

describe("enrichMcpAnalyticsEvent", () => {
  test("keeps API-key connections anonymous and omits credential identity", () => {
    const event = initializeEvent("session_1", {
      authMethod: "api_key",
      credentialScope: "organization",
      connectionScope: "organization",
      scopeSource: "credential",
      organizationId: "org_123",
      userId: null,
    });

    enrichMcpAnalyticsEvent(event);

    expect(event.distinct_id).toBe("session_1");
    expect(event.properties.$process_person_profile).toBe(false);
    expect(event.properties.$groups).toEqual({ organization: "org_123" });
    expect(event.properties.$mcp_auth_method).toBe("api_key");
    expect(event.properties[privateContextProperty]).toBeUndefined();
  });

  test("preserves existing PostHog groups", () => {
    const event = initializeEvent("session_1", {
      authMethod: "api_key",
      credentialScope: "organization",
      connectionScope: "organization",
      scopeSource: "credential",
      organizationId: "org_123",
      userId: null,
    });
    event.properties.$groups = { client: "client_123" };

    enrichMcpAnalyticsEvent(event);

    expect(event.properties.$groups).toEqual({
      client: "client_123",
      organization: "org_123",
    });
  });

  test("uses canonical Kernel user identity only for OAuth", () => {
    const event = initializeEvent("session_1", {
      authMethod: "oauth",
      credentialScope: "organization",
      connectionScope: "project",
      scopeSource: "server_pin",
      organizationId: "org_123",
      userId: "user_kernel_123",
    });

    enrichMcpAnalyticsEvent(event);

    expect(event.distinct_id).toBe("user_kernel_123");
    expect(event.properties.$process_person_profile).toBeUndefined();
    expect(event.properties.$mcp_credential_scope).toBe("organization");
    expect(event.properties.$mcp_connection_scope).toBe("project");
    expect(event.properties.$mcp_scope_source).toBe("server_pin");
  });

  test("deduplicates refreshes within a session and counts reconnects separately", () => {
    const context = {
      authMethod: "oauth" as const,
      credentialScope: "organization" as const,
      connectionScope: "organization" as const,
      scopeSource: "credential" as const,
      organizationId: "org_123",
      userId: "user_kernel_123",
    };
    const beforeRefresh = initializeEvent("session_1", context);
    const afterRefresh = initializeEvent("session_1", context);
    const reconnect = initializeEvent("session_2", context);

    enrichMcpAnalyticsEvent(beforeRefresh);
    enrichMcpAnalyticsEvent(afterRefresh);
    enrichMcpAnalyticsEvent(reconnect);

    expect(beforeRefresh.properties.$insert_id).toBe(
      afterRefresh.properties.$insert_id,
    );
    expect(reconnect.properties.$insert_id).not.toBe(
      beforeRefresh.properties.$insert_id,
    );
  });

  test("passes through events without properties", () => {
    const event = {
      event: PostHogMCPAnalyticsEvent.Initialize,
      distinct_id: "session_1",
    };

    expect(enrichMcpAnalyticsEvent(event)).toBe(event);
  });

  test("does not add connection properties to other MCP events", () => {
    const event: {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    } = {
      event: PostHogMCPAnalyticsEvent.ToolCall,
      distinct_id: "session_1",
      properties: {
        [PostHogMCPAnalyticsProperty.SessionId]: "session_1",
        [privateContextProperty]: {
          authMethod: "oauth",
          credentialScope: "organization",
          connectionScope: "organization",
          scopeSource: "credential",
          organizationId: "org_123",
          userId: "user_kernel_123",
        },
      },
    };

    enrichMcpAnalyticsEvent(event);

    expect(event.distinct_id).toBe("session_1");
    expect(event.properties.$mcp_auth_method).toBeUndefined();
    expect(event.properties[privateContextProperty]).toBeUndefined();
  });
});

type CaptureEvent = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
  type: "capture";
};

function toolCallEvent(properties: Record<string, unknown> = {}): CaptureEvent {
  return {
    event: PostHogMCPAnalyticsEvent.ToolCall,
    distinct_id: "ses_123",
    properties: {
      [PostHogMCPAnalyticsProperty.SessionId]: "ses_123",
      [PostHogMCPAnalyticsProperty.ToolName]: "manage_browsers",
      ...properties,
    },
    timestamp: new Date(0).toISOString(),
    type: "capture",
  };
}

describe("sanitizeMcpAnalyticsEvent", () => {
  test("keeps $groups so every event carries org attribution", async () => {
    const event = toolCallEvent({ $groups: { organization: "org_123" } });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.properties.$groups).toEqual({ organization: "org_123" });
  });

  test("drops call payloads and error text, keeps call metadata", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Parameters]: { stealth: true },
      [PostHogMCPAnalyticsProperty.Response]: { result: "secret" },
      [PostHogMCPAnalyticsProperty.ErrorMessage]: "upstream said no",
      [PostHogMCPAnalyticsProperty.DurationMs]: 42,
      [PostHogMCPAnalyticsProperty.IsError]: false,
    });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(
      result?.properties[PostHogMCPAnalyticsProperty.Parameters],
    ).toBeUndefined();
    expect(
      result?.properties[PostHogMCPAnalyticsProperty.Response],
    ).toBeUndefined();
    expect(
      result?.properties[PostHogMCPAnalyticsProperty.ErrorMessage],
    ).toBeUndefined();
    expect(result?.properties[PostHogMCPAnalyticsProperty.DurationMs]).toBe(42);
    expect(result?.properties[PostHogMCPAnalyticsProperty.IsError]).toBe(false);
  });

  test("drops $set so no person properties can flow", async () => {
    const event = toolCallEvent({ $set: { email: "agent@example.com" } });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.properties.$set).toBeUndefined();
  });

  test("redacts emails, URLs, and tokens from intent", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Intent]:
        "Checking out on https://shop.example.com/cart for buyer@example.com with key sk_abc123DEF456",
    });

    const result = await sanitizeMcpAnalyticsEvent(event);

    const intent = result?.properties[
      PostHogMCPAnalyticsProperty.Intent
    ] as string;
    expect(intent).toContain("[url]");
    expect(intent).toContain("[email]");
    expect(intent).toContain("[token]");
    expect(intent).not.toContain("buyer@example.com");
    expect(intent).not.toContain("sk_abc123DEF456");
  });

  test("deletes non-string intents", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Intent]: { goal: "payload" },
    });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(
      result?.properties[PostHogMCPAnalyticsProperty.Intent],
    ).toBeUndefined();
  });

  test("drops capability reports that carry no usable context", async () => {
    const event = toolCallEvent({});
    event.event = PostHogMCPAnalyticsEvent.MissingCapability;

    expect(await sanitizeMcpAnalyticsEvent(event)).toBeNull();
  });

  test("keeps capability reports with a sanitized context", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Intent]:
        "Wanted to fan one automation out over many sessions at once.",
    });
    event.event = PostHogMCPAnalyticsEvent.MissingCapability;

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result).not.toBeNull();
    expect(result?.properties[PostHogMCPAnalyticsProperty.Intent]).toBe(
      "Wanted to fan one automation out over many sessions at once.",
    );
  });

  test("drops $exception events", async () => {
    const event = toolCallEvent({});
    event.event = PostHogMCPAnalyticsEvent.Exception;

    expect(await sanitizeMcpAnalyticsEvent(event)).toBeNull();
  });
});

describe("captureOAuthTokenExchange", () => {
  test("captures only bounded outcome metadata", () => {
    const captured: unknown[] = [];
    const fakePosthog = {
      capture: (event: unknown) => captured.push(event),
    } as unknown as PostHog;

    captureOAuthTokenExchange(
      {
        grantType: "refresh_token",
        clientType: "kernel_cli",
        accessScope: "project",
        stage: "complete",
        outcome: "success",
        statusCode: 200,
        durationMs: 42,
      },
      fakePosthog,
    );

    expect(captured).toEqual([
      {
        distinctId: "oauth-token-exchange",
        event: OAUTH_TOKEN_EXCHANGE_EVENT,
        properties: {
          $process_person_profile: false,
          oauth_grant_type: "refresh_token",
          oauth_client_type: "kernel_cli",
          oauth_access_scope: "project",
          oauth_stage: "complete",
          oauth_outcome: "success",
          oauth_error_code: undefined,
          http_status_code: 200,
          duration_ms: 42,
        },
      },
    ]);
    expect(JSON.stringify(captured)).not.toContain("access_token");
    expect(JSON.stringify(captured)).not.toContain("refresh_token_hash");
    expect(JSON.stringify(captured)).not.toContain("code_verifier");
  });
});

describe("instrumentMcpAnalytics (SDK integration)", () => {
  const ORG = "org_integration";

  // mcp-handler builds a fresh McpServer per HTTP request, so each simulated request
  // gets its own instrumented server and the SDK's per-session identity cache starts
  // cold — this is exactly the deployed topology.
  function makeServer(captured: { event?: string }[]) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const fakePosthog = {
      capture: (event: unknown) => captured.push(event as { event?: string }),
    } as unknown as PostHog;
    instrumentMcpAnalytics(server, fakePosthog);
    server.tool("ping", {}, async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));
    return server;
  }

  async function simulateRequest(
    captured: { event?: string }[],
    method: string,
    params: Record<string, unknown>,
  ) {
    const server = makeServer(captured);
    const extra = {
      authInfo: {
        token: "sk_test",
        clientId: "mcp-server",
        scopes: ["apikey"],
        extra: { connectionContext: { scope: { organizationId: ORG } } },
      },
      signal: new AbortController().signal,
      requestInfo: { headers: {} },
    };
    const handlers = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (req: unknown, extra: unknown) => Promise<unknown>
        >;
      }
    )._requestHandlers;
    const handler = handlers.get(method);
    if (!handler) throw new Error(`no handler registered for ${method}`);
    await handler({ jsonrpc: "2.0", id: 1, method, params }, extra);
    // The SDK's event sink captures fire-and-forget; give it a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  test("attributes initialize, tools/list, and tools/call to the organization", async () => {
    const captured: { event?: string }[] = [];

    await simulateRequest(captured, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    await simulateRequest(captured, "tools/list", {});
    await simulateRequest(captured, "tools/call", {
      name: "ping",
      arguments: {
        context: "Verifying org attribution on an integration path.",
      },
    });

    const byEvent = new Map(captured.map((e) => [e.event, e]));
    const initialize = byEvent.get("$mcp_initialize") as {
      properties: Record<string, unknown>;
    };
    const toolsList = byEvent.get("$mcp_tools_list") as {
      distinctId: string;
      properties: Record<string, unknown>;
    };
    const toolCall = byEvent.get("$mcp_tool_call") as {
      distinctId: string;
      properties: Record<string, unknown>;
    };

    // Every captured event carries org attribution...
    for (const event of [initialize, toolsList, toolCall]) {
      expect(event).toBeDefined();
      expect(event.properties.$groups).toEqual({ organization: ORG });
      expect(event.properties.$process_person_profile).toBe(false);
    }

    // ...including tools/list: $groups arrives via eventProperties, which runs on
    // every captured event, so the per-request server topology (fresh McpServer per
    // HTTP request, cold SDK identity cache) can't leave it anonymous. Distinct ids
    // stay session-scoped everywhere.
    expect(toolsList.distinctId).toStartWith("ses_");
    expect(toolCall.distinctId).toStartWith("ses_");

    // identify stays unwired, so no $identify event is ever published.
    expect(byEvent.has("$identify")).toBe(false);
  });

  test("stays anonymous when no connection context is attached", async () => {
    const captured: { event?: string }[] = [];
    const server = makeServer(captured);
    const extra = {
      authInfo: {
        token: "sk_test",
        clientId: "mcp-server",
        scopes: ["apikey"],
      },
      signal: new AbortController().signal,
      requestInfo: { headers: {} },
    };
    const handlers = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (req: unknown, extra: unknown) => Promise<unknown>
        >;
      }
    )._requestHandlers;
    await handlers.get("tools/list")!(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      extra,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const toolsList = captured.find((e) => e.event === "$mcp_tools_list") as {
      distinctId: string;
      properties: Record<string, unknown>;
    };
    expect(toolsList).toBeDefined();
    expect(toolsList.properties.$groups).toBeUndefined();
    expect(toolsList.properties.$process_person_profile).toBe(false);
    expect(toolsList.distinctId).toStartWith("ses_");
  });
});
