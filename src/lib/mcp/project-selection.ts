import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { McpConnectionContext } from "@/lib/mcp/auth-context";

const projectSchema = z
  .string()
  .min(1)
  .describe(
    "Optional project name or ID used to scope this operation. On organization-wide connections, omit it to use the API's organization-wide or default-project behavior. On project-scoped connections, omit it or pass the fixed project returned by get_connection_context.",
  )
  .optional();

const projectIDSchema = z
  .string()
  .min(1)
  .describe(
    "Deprecated: use `project` instead. Optional project ID used to scope this operation. On organization-wide connections, omit it to use the API's organization-wide or default-project behavior. On project-scoped connections, omit it or pass the fixed project ID returned by get_connection_context.",
  )
  .optional();

export type ProjectSelection = {
  project?: string;
  project_id?: string;
};

export function projectSelectionInputSchema(): {
  project: typeof projectSchema;
  project_id: typeof projectIDSchema;
} {
  return { project: projectSchema, project_id: projectIDSchema };
}

export function requestedProject(
  selection: ProjectSelection,
): string | undefined {
  return selection.project ?? selection.project_id;
}

export function connectionContextFromAuthInfo(
  authInfo: AuthInfo,
): McpConnectionContext {
  const context = authInfo.extra?.connectionContext;
  if (!context || typeof context !== "object" || !("scope" in context)) {
    throw new Error("Kernel connection scope is unavailable");
  }
  return context as McpConnectionContext;
}

export function projectForOperation(
  authInfo: AuthInfo,
  selection: ProjectSelection = {},
): string | undefined {
  const { scope } = connectionContextFromAuthInfo(authInfo);
  if (scope.kind === "organization") {
    return requestedProject(selection);
  }

  if (
    selection.project_id &&
    !selection.project &&
    selection.project_id !== scope.projectId
  ) {
    throw new Error(
      `project_id must match this connection's fixed project (${scope.projectId})`,
    );
  }
  return selection.project ?? scope.projectId;
}

export function projectIDForOperation(
  authInfo: AuthInfo,
  requestedProjectId?: string,
): string | undefined {
  return projectForOperation(authInfo, { project_id: requestedProjectId });
}
