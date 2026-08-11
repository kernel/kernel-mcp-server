import { describe, expect, test } from "bun:test";
import {
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "@posthog/mcp";
import {
  enrichMcpAnalyticsEvent,
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

  test("pins $process_person_profile to false even when an identity is set", async () => {
    // Once the SDK resolves an identity it stops setting the flag; the identity it
    // resolves here is org-pseudonymous, never a person, so the flag must stay false.
    const event = toolCallEvent({
      $groups: { organization: "org_123" },
    });
    delete event.properties.$process_person_profile;
    event.distinct_id = "mcporg_abc123";

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.properties.$process_person_profile).toBe(false);
  });

  test("lets an OAuth initialize keep person processing and the canonical user id", async () => {
    const event = toolCallEvent({
      $process_person_profile: false,
      [privateContextProperty]: {
        authMethod: "oauth",
        credentialScope: "organization",
        connectionScope: "organization",
        scopeSource: "credential",
        organizationId: "org_123",
        userId: "user_kernel_123",
      },
    });
    event.event = PostHogMCPAnalyticsEvent.Initialize;

    const result = await sanitizeMcpAnalyticsEvent(event);

    expect(result?.distinct_id).toBe("user_kernel_123");
    expect(result?.properties.$process_person_profile).toBeUndefined();
    expect(result?.properties.$groups).toEqual({ organization: "org_123" });
    expect(result?.properties[privateContextProperty]).toBeUndefined();
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

  test("drops $identify events", async () => {
    // The SDK publishes one per session once identify resolves; PostHog rejects it in
    // personless mode, and every capture event already carries $groups independently.
    const event = toolCallEvent({ $groups: { organization: "org_123" } });
    event.event = PostHogMCPAnalyticsEvent.Identify;

    expect(await sanitizeMcpAnalyticsEvent(event)).toBeNull();
  });

  test("drops $exception events", async () => {
    const event = toolCallEvent({});
    event.event = PostHogMCPAnalyticsEvent.Exception;

    expect(await sanitizeMcpAnalyticsEvent(event)).toBeNull();
  });
});
