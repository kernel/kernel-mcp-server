import { afterEach, describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  clearMcpConnectionContextCacheForTests,
  connectionAnalyticsFromContext,
  connectionScopeFromAuthContext,
  expireMcpConnectionContextCacheForTests,
  resolveMcpConnectionContext,
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
        auth: { context: { retrieve: async () => body } },
      } as unknown as KernelClient;
    },
  };
}

afterEach(clearMcpConnectionContextCacheForTests);

describe("resolveMcpConnectionContext", () => {
  test("normalizes organization-wide API-key scope", async () => {
    const context = await resolveMcpConnectionContext({
      token: "sk_secret",
      dependencies: dependencies(response()),
    });

    expect(context?.scope).toEqual({
      kind: "organization",
      organizationId: "org_123",
      projectId: null,
      source: "credential",
    });
    const analytics = connectionAnalyticsFromContext(context!);
    expect(analytics).toEqual({
      authMethod: "api_key",
      credentialScope: "organization",
      connectionScope: "organization",
      scopeSource: "credential",
      organizationId: "org_123",
      userId: null,
    });
    expect(JSON.stringify(analytics)).not.toContain("key_sensitive");
  });

  test("normalizes project-scoped API-key scope", async () => {
    const context = await resolveMcpConnectionContext({
      token: "sk_secret",
      dependencies: dependencies(
        response({
          credentialProjectId: "project_123",
          effectiveProjectId: "project_123",
        }),
      ),
    });

    expect(context?.scope).toEqual({
      kind: "project",
      organizationId: "org_123",
      projectId: "project_123",
      source: "credential",
    });
    expect(connectionAnalyticsFromContext(context!)?.credentialScope).toBe(
      "project",
    );
  });

  test("uses the canonical OAuth user principal for analytics", async () => {
    const context = await resolveMcpConnectionContext({
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

    expect(connectionAnalyticsFromContext(context!)?.authMethod).toBe("oauth");
    expect(connectionAnalyticsFromContext(context!)?.userId).toBe(
      "user_kernel_123",
    );
  });

  test("normalizes KERNEL_PROJECT as a server pin", () => {
    const scope = connectionScopeFromAuthContext(
      response({ effectiveProjectId: "project_pinned" }),
      "project_pinned",
    );

    expect(scope).toEqual({
      kind: "project",
      organizationId: "org_123",
      projectId: "project_pinned",
      source: "server_pin",
    });
  });

  test("rejects inconsistent credential, effective, and server scope", () => {
    expect(
      connectionScopeFromAuthContext(
        response({
          credentialProjectId: "project_1",
          effectiveProjectId: "project_2",
        }),
      ),
    ).toBeNull();
    expect(
      connectionScopeFromAuthContext(
        response({ effectiveProjectId: "project_1" }),
      ),
    ).toBeNull();
    expect(
      connectionScopeFromAuthContext(
        response({ effectiveProjectId: "project_1" }),
        "project_2",
      ),
    ).toBeNull();
  });

  test("reuses normalized scope across token refreshes in one session", async () => {
    const calls: string[] = [];
    const first = await resolveMcpConnectionContext({
      token: "old-token",
      cacheIdentity: "user_123\0session_123",
      dependencies: dependencies(response(), calls),
    });
    const refreshed = await resolveMcpConnectionContext({
      token: "new-token",
      cacheIdentity: "user_123\0session_123",
      dependencies: dependencies(response(), calls),
    });

    expect(refreshed).toBe(first);
    expect(calls).toEqual(["old-token"]);
  });

  test("does not cache requests without a session identity", async () => {
    const calls: string[] = [];
    await resolveMcpConnectionContext({
      token: "api-key",
      dependencies: dependencies(response(), calls),
    });
    await resolveMcpConnectionContext({
      token: "api-key",
      dependencies: dependencies(response(), calls),
    });

    expect(calls).toEqual(["api-key", "api-key"]);
  });

  test("retains resolved scope during a transient refresh failure", async () => {
    const cacheIdentity = "user_123\0session_123";
    const first = await resolveMcpConnectionContext({
      token: "old-token",
      cacheIdentity,
      dependencies: dependencies(response()),
    });
    expireMcpConnectionContextCacheForTests();
    const refreshed = await resolveMcpConnectionContext({
      token: "new-token",
      cacheIdentity,
      dependencies: {
        createKernelClient: () => {
          throw new Error("temporary outage");
        },
      },
    });

    expect(refreshed).toBe(first);
  });

  test("invalidates cached scope after credential rejection", async () => {
    const cacheIdentity = "user_123\0session_123";
    await resolveMcpConnectionContext({
      token: "old-token",
      cacheIdentity,
      dependencies: dependencies(response()),
    });
    expireMcpConnectionContextCacheForTests();
    const rejected = await resolveMcpConnectionContext({
      token: "revoked-token",
      cacheIdentity,
      dependencies: {
        createKernelClient: () => {
          throw Object.assign(new Error("revoked"), { status: 401 });
        },
      },
    });

    expect(rejected).toBeNull();
  });

  test("invalidates cached scope after an inconsistent response", async () => {
    const cacheIdentity = "user_123\0session_123";
    await resolveMcpConnectionContext({
      token: "old-token",
      cacheIdentity,
      dependencies: dependencies(response()),
    });
    expireMcpConnectionContextCacheForTests();
    const inconsistent = await resolveMcpConnectionContext({
      token: "new-token",
      cacheIdentity,
      dependencies: dependencies(
        response({
          credentialProjectId: "project_1",
          effectiveProjectId: "project_2",
        }),
      ),
    });
    const transient = await resolveMcpConnectionContext({
      token: "newer-token",
      cacheIdentity,
      dependencies: {
        createKernelClient: () => {
          throw new Error("temporary outage");
        },
      },
    });

    expect(inconsistent).toBeNull();
    expect(transient).toBeNull();
  });

  test("fails closed when auth context is unavailable or malformed", async () => {
    const unavailable = await resolveMcpConnectionContext({
      token: "sk_secret",
      dependencies: {
        createKernelClient: () => {
          throw new Error("API unavailable");
        },
      },
    });
    const malformed = await resolveMcpConnectionContext({
      token: "sk_secret",
      dependencies: dependencies({ authentication: {} }),
    });

    expect(unavailable).toBeNull();
    expect(malformed).toBeNull();
  });
});
