import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, test } from "bun:test";
import type {
  ConnectionScope,
  McpConnectionContext,
} from "@/lib/mcp/auth-context";
import {
  connectionContextFromAuthInfo,
  projectForOperation,
  projectIDForOperation,
  projectSelectionInputSchema,
  requestedProject,
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
  test("advertises project plus deprecated project_id", () => {
    const schema = projectSelectionInputSchema();
    expect(schema).toHaveProperty("project");
    expect(schema).toHaveProperty("project_id");
    expect(schema.project.safeParse(undefined).success).toBe(true);
    expect(schema.project.safeParse("my-project").success).toBe(true);
    expect(schema.project.safeParse("").success).toBe(false);
    expect(schema.project_id.safeParse(undefined).success).toBe(true);
    expect(schema.project_id.safeParse("proj_123").success).toBe(true);
    expect(schema.project_id.safeParse("").success).toBe(false);
  });

  test("keeps non-empty validation when descriptions are overridden", () => {
    const schema = projectSelectionInputSchema({
      project: "Project name or ID.",
      project_id: "Deprecated.",
    });
    expect(schema.project.safeParse("").success).toBe(false);
    expect(schema.project_id.safeParse("").success).toBe(false);
    expect(schema.project.safeParse("billing").success).toBe(true);
  });
});

describe("requestedProject", () => {
  test("prefers project over project_id", () => {
    expect(requestedProject({ project: "by-name" })).toBe("by-name");
    expect(requestedProject({ project_id: "proj_123" })).toBe("proj_123");
    expect(
      requestedProject({ project: "by-name", project_id: "proj_123" }),
    ).toBe("by-name");
    expect(requestedProject({})).toBeUndefined();
    expect(requestedProject({ project: "", project_id: "proj_123" })).toBe(
      "proj_123",
    );
  });
});

describe("projectForOperation", () => {
  test("preserves unscoped access for organization-wide connections", () => {
    const info = authInfo(organizationScope);
    expect(projectForOperation(info)).toBeUndefined();
    expect(projectForOperation(info, { project: "my-project" })).toBe(
      "my-project",
    );
    expect(projectForOperation(info, { project_id: "proj_123" })).toBe(
      "proj_123",
    );
    expect(
      projectForOperation(info, {
        project: "my-project",
        project_id: "proj_123",
      }),
    ).toBe("my-project");
  });

  test("uses the fixed project for project-scoped connections", () => {
    const info = authInfo(projectScope);
    expect(projectForOperation(info)).toBe("proj_fixed");
    expect(projectForOperation(info, { project_id: "proj_fixed" })).toBe(
      "proj_fixed",
    );
    expect(projectForOperation(info, { project: "proj_fixed" })).toBe(
      "proj_fixed",
    );
  });

  test("rejects a selector override on project-scoped connections", () => {
    expect(() =>
      projectForOperation(authInfo(projectScope), { project_id: "proj_other" }),
    ).toThrow("project must match");
    expect(() =>
      projectForOperation(authInfo(projectScope), { project: "fixed-name" }),
    ).toThrow("project must match");
    expect(() =>
      projectForOperation(authInfo(projectScope), {
        project: "fixed-name",
        project_id: "proj_other",
      }),
    ).toThrow("project must match");
  });
});

describe("projectIDForOperation", () => {
  test("preserves unscoped access for organization-wide connections", () => {
    const info = authInfo(organizationScope);
    expect(projectIDForOperation(info)).toBeUndefined();
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
    ).toThrow("project must match");
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
