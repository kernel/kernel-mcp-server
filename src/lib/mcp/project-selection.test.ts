import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, test } from "bun:test";
import type {
  ConnectionScope,
  McpConnectionContext,
} from "@/lib/mcp/auth-context";
import {
  connectionContextFromAuthInfo,
  projectIDForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

function authInfo(scope: ConnectionScope): AuthInfo {
  const connectionContext = {
    scope,
    authContext: {},
  } as McpConnectionContext;
  return {
    token: "test-token",
    clientId: "test-client",
    scopes: [],
    extra: { connectionContext },
  };
}

const organizationScope: ConnectionScope = {
  kind: "organization",
  organizationId: "org_123",
  projectId: null,
  source: "credential",
};

const projectScope: ConnectionScope = {
  kind: "project",
  organizationId: "org_123",
  projectId: "proj_fixed",
  source: "credential",
};

describe("project selection schema", () => {
  test("always advertises an optional project_id", () => {
    const schema = projectSelectionInputSchema();
    expect(schema).toHaveProperty("project_id");
    expect(schema.project_id.safeParse(undefined).success).toBe(true);
    expect(schema.project_id.safeParse("proj_123").success).toBe(true);
    expect(schema.project_id.safeParse("").success).toBe(false);
  });
});

describe("projectIDForOperation", () => {
  test("requires a target for organization-wide connections", () => {
    const info = authInfo(organizationScope);
    expect(() => projectIDForOperation(info)).toThrow("project_id is required");
    expect(projectIDForOperation(info, "proj_123")).toBe("proj_123");
  });

  test("uses the fixed project for project-scoped connections", () => {
    const info = authInfo(projectScope);
    expect(projectIDForOperation(info)).toBe("proj_fixed");
    expect(projectIDForOperation(info, "proj_fixed")).toBe("proj_fixed");
  });

  test("rejects an override on project-scoped connections", () => {
    expect(() =>
      projectIDForOperation(authInfo(projectScope), "proj_other"),
    ).toThrow("project_id must match");
  });

  test("fails when canonical connection context is absent", () => {
    const info: AuthInfo = {
      token: "test-token",
      clientId: "test-client",
      scopes: [],
    };
    expect(() => connectionContextFromAuthInfo(info)).toThrow(
      "Kernel connection scope is unavailable",
    );
  });
});
