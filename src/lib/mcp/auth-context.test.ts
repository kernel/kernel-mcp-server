import { describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  resolveMcpAuthContext,
  resolveMcpConnectionAnalyticsContext,
} from "@/lib/mcp/auth-context";

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

function dependencies(body: unknown, calls?: string[]) {
  return {
    createKernelClient: (token: string) => {
      calls?.push(token);
      return {
        auth: {
          context: { retrieve: async () => body },
        },
      } as unknown as KernelClient;
    },
  };
}

describe("resolveMcpConnectionAnalyticsContext", () => {
  test("classifies an organization-wide API key without identifying its owner", async () => {
    const context = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      dependencies: dependencies(response()),
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
      dependencies: dependencies(
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
      dependencies: dependencies(
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
    const calls: string[] = [];
    const context = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      dependencies: dependencies(
        response({ effectiveProjectId: "project_pinned" }),
        calls,
      ),
      serverProjectId: "project_pinned",
    });

    expect(calls).toEqual(["sk_secret"]);
    expect(context?.credentialScope).toBe("organization");
    expect(context?.connectionScope).toBe("project");
    expect(context?.scopeSource).toBe("server_pin");
  });

  test("fails closed for unavailable, malformed, unsupported, or inconsistent context", async () => {
    const unavailable = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      dependencies: {
        createKernelClient: () => {
          throw new Error("API unavailable");
        },
      },
    });
    const malformed = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      dependencies: dependencies({ authentication: {} }),
    });
    const dashboard = await resolveMcpConnectionAnalyticsContext({
      token: "jwt.secret.value",
      dependencies: dependencies(
        response({
          method: "jwt",
          source: "dashboard",
          principalType: "user",
          principalId: "user_kernel_123",
        }),
      ),
    });
    const inconsistent = await resolveMcpConnectionAnalyticsContext({
      token: "sk_secret",
      dependencies: dependencies(
        response({
          credentialProjectId: "project_1",
          effectiveProjectId: "project_2",
        }),
      ),
    });

    expect(unavailable).toBeNull();
    expect(malformed).toBeNull();
    expect(dashboard).toBeNull();
    expect(inconsistent).toBeNull();
  });

  test("can reuse an already resolved auth context", async () => {
    const calls: string[] = [];
    const authContext = resolveMcpAuthContext({
      token: "oauth-token",
      dependencies: dependencies(
        response({
          method: "jwt",
          source: "oauth",
          principalType: "user",
          principalId: "user_kernel_123",
        }),
        calls,
      ),
    });

    const context = await resolveMcpConnectionAnalyticsContext({
      token: "oauth-token",
      authContext,
    });

    expect(context?.authMethod).toBe("oauth");
    expect(calls).toEqual(["oauth-token"]);
  });
});
