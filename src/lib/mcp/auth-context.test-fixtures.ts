import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export function projectScopedAuthInfo(
  projectId = "proj_test",
  organizationId = "org_test",
  token = "test-token",
): AuthInfo {
  return {
    token,
    clientId: "test-client",
    scopes: [],
    extra: {
      connectionContext: {
        authContext: {},
        scope: {
          kind: "project",
          organizationId,
          projectId,
          source: "credential",
        },
      },
    },
  };
}

export function organizationWideAuthInfo(
  organizationId = "org_test",
): AuthInfo {
  return {
    token: "test-token",
    clientId: "test-client",
    scopes: [],
    extra: {
      connectionContext: {
        authContext: {},
        scope: {
          kind: "organization",
          organizationId,
          projectId: null,
          source: "credential",
        },
      },
    },
  };
}

export function projectScopedExtra(
  projectId = "proj_test",
  token = "test-token",
) {
  return { authInfo: projectScopedAuthInfo(projectId, "org_test", token) };
}
