import { describe, expect, test } from "bun:test";
import {
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "@posthog/mcp";
import { enrichMcpAnalyticsEvent } from "@/lib/mcp/analytics";

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
