import { describe, expect, test } from "bun:test";
import { resolveMcpConnectionAnalyticsContext } from "@/lib/mcp/auth-context";

function response({
  method = "api_key",
  source = "api_key",
  principalType = "api_key",
  principalId = "key_sensitive",
  credentialProjectId = null,
  effectiveProjectId = null,
}: {
  method?: "api_key" | "jwt";
  source?: "api_key" | "oauth" | "dashboard";
  principalType?: "api_key" | "user";
  principalId?: string;
  credentialProjectId?: string | null;
  effectiveProjectId?: string | null;
} = {}) {
  return {
    authentication: {
      method,
      source,
      credential_id: method === "api_key" ? "key_sensitive" : null,
    },
    principal: { type: principalType, id: principalId },
    organization: { id: "org_123" },
    authorization: {
      credential_scope: { project_id: credentialProjectId },
      effective_scope: { project_id: effectiveProjectId },
    },
  };
}

function fetchResponse(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("resolveMcpConnectionAnalyticsContext", () => {
  test("classifies an organization-wide API key without identifying its owner", async () => {
    const context = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      enabled: true,
      fetchImpl: fetchResponse(response()),
    });

    expect(context).toEqual({
      authMethod: "api_key",
      credentialScope: "organization",
      connectionScope: "organization",
      scopeSource: "credential",
      organizationId: "org_123",
      userId: null,
    });
    expect(JSON.stringify(context)).not.toContain("key_sensitive");
  });

  test("classifies a project-scoped API key", async () => {
    const context = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      enabled: true,
      fetchImpl: fetchResponse(
        response({
          credentialProjectId: "project_123",
          effectiveProjectId: "project_123",
        }),
      ),
    });

    expect(context?.credentialScope).toBe("project");
    expect(context?.connectionScope).toBe("project");
    expect(context?.scopeSource).toBe("credential");
  });

  test("identifies OAuth with the canonical user principal", async () => {
    const context = await resolveMcpConnectionAnalyticsContext({
      token: "jwt.secret.value",
      enabled: true,
      fetchImpl: fetchResponse(
        response({
          method: "jwt",
          source: "oauth",
          principalType: "user",
          principalId: "user_kernel_123",
        }),
      ),
    });

    expect(context?.authMethod).toBe("oauth");
    expect(context?.userId).toBe("user_kernel_123");
  });

  test("classifies KERNEL_PROJECT as a server pin", async () => {
    let request: Request | undefined;
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify(response({ effectiveProjectId: "project_pinned" })),
      );
    };

    const context = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      enabled: true,
      fetchImpl,
      serverProjectId: "project_pinned",
    });

    expect(request?.headers.get("X-Kernel-Project-Id")).toBe("project_pinned");
    expect(context?.credentialScope).toBe("organization");
    expect(context?.connectionScope).toBe("project");
    expect(context?.scopeSource).toBe("server_pin");
  });

  test("does not fetch when analytics is disabled", async () => {
    let calls = 0;
    const context = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      enabled: false,
      fetchImpl: async () => {
        calls += 1;
        return new Response();
      },
    });

    expect(context).toBeNull();
    expect(calls).toBe(0);
  });

  test("fails closed for unavailable, malformed, or unsupported context", async () => {
    const unavailable = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      enabled: true,
      fetchImpl: fetchResponse({}, 503),
    });
    const malformed = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      enabled: true,
      fetchImpl: fetchResponse({ authentication: {} }),
    });
    const dashboard = await resolveMcpConnectionAnalyticsContext({
      token: "jwt.secret.value",
      enabled: true,
      fetchImpl: fetchResponse(
        response({
          method: "jwt",
          source: "dashboard",
          principalType: "user",
          principalId: "user_kernel_123",
        }),
      ),
    });

    expect(unavailable).toBeNull();
    expect(malformed).toBeNull();
    expect(dashboard).toBeNull();
  });
});
