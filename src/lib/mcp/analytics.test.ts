import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PostHog } from "posthog-node";
import {
  encodeSessionId,
  MCP_SESSION_HEADER,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
  type McpAnalytics,
} from "@posthog/mcp";
import {
  captureMcpConnectionScopeFailure,
  captureMcpFeedback,
  captureOAuthTokenExchange,
  clientCapabilityAnalyticsFromInitialize,
  enrichMcpAnalyticsEvent,
  instrumentMcpAnalytics,
  MCP_CLIENT_ELICITATION_MODE_PROPERTY,
  MCP_CLIENT_SUPPORTS_APPS_PROPERTY,
  MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY,
  MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY,
  MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY,
  MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY,
  MCP_CLIENT_SUPPORTS_TASKS_PROPERTY,
  MCP_CONNECTION_SCOPE_FAILURE_EVENT,
  MCP_FEEDBACK_SUBMITTED_EVENT,
  MCP_USED_PROJECT_ID_PROPERTY,
  MCP_USED_PROJECT_PROPERTY,
  OAUTH_TOKEN_EXCHANGE_EVENT,
  sanitizeMcpAnalyticsEvent,
} from "@/lib/mcp/analytics";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { KERNEL_FEEDBACK_TOOL_NAME } from "@/lib/mcp/tools/feedback";

const privateContextProperty = "__mcp_connection_analytics_context";

function initialize(capabilities: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities,
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
}

describe("clientCapabilityAnalyticsFromInitialize", () => {
  test("records unsupported capabilities as explicit false values", () => {
    expect(clientCapabilityAnalyticsFromInitialize(initialize({}))).toEqual({
      [MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY]: false,
      [MCP_CLIENT_ELICITATION_MODE_PROPERTY]: "none",
      [MCP_CLIENT_SUPPORTS_APPS_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY]: false,
    });
  });

  test("reduces standard capabilities and allowlisted extensions", () => {
    const result = clientCapabilityAnalyticsFromInitialize(
      initialize({
        sampling: { tools: {} },
        elicitation: {},
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] },
          "io.modelcontextprotocol/tasks": {},
          "io.modelcontextprotocol/oauth-client-credentials": {},
          "io.modelcontextprotocol/enterprise-managed-authorization": {},
          "com.example/private-extension": { secret: "do-not-capture" },
        },
      }),
    );

    expect(result).toEqual({
      [MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY]: true,
      [MCP_CLIENT_ELICITATION_MODE_PROPERTY]: "form",
      [MCP_CLIENT_SUPPORTS_APPS_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY]: true,
    });
    expect(JSON.stringify(result)).not.toContain("private-extension");
    expect(JSON.stringify(result)).not.toContain("do-not-capture");
  });

  test("rejects malformed capability and extension declarations", () => {
    const result = clientCapabilityAnalyticsFromInitialize(
      initialize({
        sampling: { tools: null },
        elicitation: { url: null },
        tasks: false,
        extensions: {
          "io.modelcontextprotocol/ui": null,
          "io.modelcontextprotocol/tasks": false,
          "io.modelcontextprotocol/oauth-client-credentials": "enabled",
          "io.modelcontextprotocol/enterprise-managed-authorization": [],
        },
      }),
    );

    expect(result).toEqual({
      [MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY]: false,
      [MCP_CLIENT_ELICITATION_MODE_PROPERTY]: "none",
      [MCP_CLIENT_SUPPORTS_APPS_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY]: false,
      [MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY]: false,
    });
  });

  test("distinguishes URL-only, form-and-URL, and legacy task support", () => {
    const urlOnly = clientCapabilityAnalyticsFromInitialize(
      initialize({ elicitation: { url: {} } }),
    );
    const formAndUrl = clientCapabilityAnalyticsFromInitialize(
      initialize({ elicitation: { form: {}, url: {} }, tasks: {} }),
    );

    expect(urlOnly?.[MCP_CLIENT_ELICITATION_MODE_PROPERTY]).toBe("url");
    expect(formAndUrl?.[MCP_CLIENT_ELICITATION_MODE_PROPERTY]).toBe(
      "form_and_url",
    );
    expect(formAndUrl?.[MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]).toBe(true);
  });

  test("ignores non-initialize payloads", () => {
    expect(
      clientCapabilityAnalyticsFromInitialize({
        method: "tools/list",
        params: { capabilities: { sampling: {} } },
      }),
    ).toBeNull();
  });
});

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

  test("records which project selector was passed without the value", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Parameters]: {
        request: {
          params: {
            arguments: {
              action: "list",
              project_id: "proj_secret",
              project: "billing",
            },
          },
        },
      },
    });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.properties[MCP_USED_PROJECT_ID_PROPERTY]).toBe(true);
    expect(result?.properties[MCP_USED_PROJECT_PROPERTY]).toBe(true);
    expect(
      result?.properties[PostHogMCPAnalyticsProperty.Parameters],
    ).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("proj_secret");
    expect(JSON.stringify(result)).not.toContain("billing");
  });

  test("marks deprecated project_id usage when only that param is set", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Parameters]: {
        request: {
          params: { arguments: { project_id: "proj_123" } },
        },
      },
    });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.properties[MCP_USED_PROJECT_ID_PROPERTY]).toBe(true);
    expect(result?.properties[MCP_USED_PROJECT_PROPERTY]).toBe(false);
  });

  test("marks project usage when only the new param is set", async () => {
    const event = toolCallEvent({
      [PostHogMCPAnalyticsProperty.Parameters]: {
        request: {
          params: { arguments: { project: "my-project" } },
        },
      },
    });

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.properties[MCP_USED_PROJECT_ID_PROPERTY]).toBe(false);
    expect(result?.properties[MCP_USED_PROJECT_PROPERTY]).toBe(true);
  });

  test("records false/false when a tool call omits both project selectors", async () => {
    const result = await sanitizeMcpAnalyticsEvent(toolCallEvent());

    expect(result?.properties[MCP_USED_PROJECT_ID_PROPERTY]).toBe(false);
    expect(result?.properties[MCP_USED_PROJECT_PROPERTY]).toBe(false);
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

describe("captureMcpConnectionScopeFailure", () => {
  test("records the outcome without the credential it was resolving", () => {
    const captured: unknown[] = [];
    const fakePosthog = {
      capture: (event: unknown) => captured.push(event),
    } as unknown as PostHog;

    captureMcpConnectionScopeFailure(
      {
        outcome: "rejected",
        credentialType: "api_key",
        upstreamStatusCode: 403,
      },
      fakePosthog,
    );

    expect(captured).toEqual([
      {
        distinctId: "mcp-connection-scope",
        event: MCP_CONNECTION_SCOPE_FAILURE_EVENT,
        properties: {
          $process_person_profile: false,
          connection_scope_outcome: "rejected",
          connection_credential_type: "api_key",
          upstream_status_code: 403,
        },
      },
    ]);
  });

  test("is a no-op without a configured client", () => {
    expect(() =>
      captureMcpConnectionScopeFailure(
        { outcome: "unavailable", credentialType: "oauth" },
        null,
      ),
    ).not.toThrow();
  });
});

describe("captureMcpFeedback", () => {
  test("routes redacted feedback through contextual MCP analytics", async () => {
    const captured: unknown[] = [];
    const analytics = {
      capture: async (event: unknown) => {
        captured.push(event);
      },
    } as McpAnalytics;

    await captureMcpFeedback(
      {
        summary: "Browser timeout guidance was unclear",
        feedback_type: "product",
        sentiment: "mixed",
        product_area: "browsers",
        task_completed: true,
        tools_used: ["manage_browsers"],
        friction_points: "- The response did not say when to retry.",
        suggested_improvement: "Include a retry interval in the response.",
        details:
          "The error linked to https://example.com/support for user@example.com.",
      },
      {
        authInfo: {
          extra: {
            connectionContext: {
              scope: { organizationId: "org_analytics" },
            },
          },
        },
      },
      analytics,
    );

    expect(captured).toEqual([
      {
        event: MCP_FEEDBACK_SUBMITTED_EVENT,
        properties: {
          $groups: { organization: "org_analytics" },
          feedback_summary: "Browser timeout guidance was unclear",
          feedback_type: "product",
          feedback_sentiment: "mixed",
          feedback_product_area: "browsers",
          feedback_category: undefined,
          feedback_task_completed: true,
          feedback_tools_used: ["manage_browsers"],
          feedback_friction_points: "- The response did not say when to retry.",
          feedback_suggested_improvement:
            "Include a retry interval in the response.",
          feedback_user_request: undefined,
          feedback_details: "The error linked to [url] for [email]",
        },
      },
    ]);
  });
});

describe("instrumentMcpAnalytics (SDK integration)", () => {
  const ORG = "org_integration";

  test("keeps the feedback tool schema stable when analytics is disabled", async () => {
    const disabled = await connectTestMcp(
      (server) => instrumentMcpAnalytics(server, null),
      {},
    );
    const enabled = await connectTestMcp(
      (server) =>
        instrumentMcpAnalytics(server, {
          capture: () => undefined,
        } as unknown as PostHog),
      {},
    );

    try {
      const disabledTool = (await disabled.client.listTools()).tools.find(
        ({ name }) => name === KERNEL_FEEDBACK_TOOL_NAME,
      );
      const enabledTool = (await enabled.client.listTools()).tools.find(
        ({ name }) => name === KERNEL_FEEDBACK_TOOL_NAME,
      );
      expect(disabledTool).toBeDefined();
      expect(disabledTool?.inputSchema).toEqual(enabledTool?.inputSchema);
      expect(disabledTool?.inputSchema.required).toContain("context");
    } finally {
      await disabled.close();
      await enabled.close();
    }
  });

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
    const request = { jsonrpc: "2.0", id: 1, method, params };
    const extra = {
      authInfo: {
        token: "sk_test",
        clientId: "mcp-server",
        scopes: ["apikey"],
        extra: { connectionContext: { scope: { organizationId: ORG } } },
      },
      signal: new AbortController().signal,
      requestInfo: {
        headers: {
          [MCP_SESSION_HEADER]: encodeSessionId({
            sessionId: "ses_integration",
            clientName: "test-client",
            clientVersion: "0.0.0",
            protocolVersion: "2025-03-26",
          }),
        },
      },
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
    await handler(request, extra);
    // The SDK's event sink captures fire-and-forget; give it a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  test("attributes initialize, tools/list, and tools/call to the organization", async () => {
    const captured: { event?: string }[] = [];

    await simulateRequest(captured, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        sampling: { tools: {} },
        elicitation: { url: {} },
        extensions: { "io.modelcontextprotocol/ui": {} },
      },
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

    expect(initialize.properties).toMatchObject({
      [MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY]: true,
      [MCP_CLIENT_ELICITATION_MODE_PROPERTY]: "url",
      [MCP_CLIENT_SUPPORTS_APPS_PROPERTY]: true,
      [MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]: false,
    });

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

  test("captures feedback with the surrounding MCP session metadata", async () => {
    const captured: { event?: string }[] = [];

    await simulateRequest(captured, "tools/call", {
      name: KERNEL_FEEDBACK_TOOL_NAME,
      arguments: {
        context:
          "Reporting that browser timeout guidance did not explain when the caller should retry.",
        summary: "Browser timeout guidance was unclear",
        feedback_type: "product",
        sentiment: "mixed",
        product_area: "browsers",
      },
    });

    const feedback = captured.find(
      ({ event }) => event === MCP_FEEDBACK_SUBMITTED_EVENT,
    ) as { distinctId: string; properties: Record<string, unknown> };
    const toolCall = captured.find(
      ({ event }) => event === "$mcp_tool_call",
    ) as {
      distinctId: string;
      properties: Record<string, unknown>;
    };

    expect(feedback.distinctId).toBe("ses_integration");
    expect(feedback.distinctId).toBe(toolCall.distinctId);
    expect(feedback.properties).toMatchObject({
      $groups: { organization: ORG },
      [PostHogMCPAnalyticsProperty.SessionId]: "ses_integration",
      [PostHogMCPAnalyticsProperty.ClientName]: "test-client",
      [PostHogMCPAnalyticsProperty.ClientVersion]: "0.0.0",
      [PostHogMCPAnalyticsProperty.ProtocolVersion]: "2025-03-26",
      [PostHogMCPAnalyticsProperty.ServerName]: "test",
      [PostHogMCPAnalyticsProperty.ServerVersion]: "0.0.0",
      feedback_summary: "Browser timeout guidance was unclear",
      feedback_type: "product",
      feedback_sentiment: "mixed",
      feedback_product_area: "browsers",
    });
    expect(toolCall.properties[PostHogMCPAnalyticsProperty.Intent]).toBe(
      "Reporting that browser timeout guidance did not explain when the caller should retry.",
    );
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
