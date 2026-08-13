import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { McpConnectionContext } from "@/lib/mcp/auth-context";

const DEFAULT_PROJECT_DESCRIPTION =
  "Optional project name or ID used to scope this operation. On organization-wide connections, omit it to use the API's organization-wide or default-project behavior. On project-scoped connections, omit it or pass the fixed project returned by get_connection_context.";

const DEFAULT_PROJECT_ID_DESCRIPTION =
  "Deprecated: use `project` instead. Optional project ID used to scope this operation. On organization-wide connections, omit it to use the API's organization-wide or default-project behavior. On project-scoped connections, omit it or pass the fixed project ID returned by get_connection_context.";

export type ProjectSelection = {
  project?: string;
  project_id?: string;
};

export type ProjectSelectionDescriptions = {
  project?: string;
  project_id?: string;
};

export function projectSelectionInputSchema(
  descriptions: ProjectSelectionDescriptions = {},
) {
  return {
    project: z
      .string()
      .min(1)
      .describe(descriptions.project ?? DEFAULT_PROJECT_DESCRIPTION)
      .optional(),
    project_id: z
      .string()
      .min(1)
      .describe(descriptions.project_id ?? DEFAULT_PROJECT_ID_DESCRIPTION)
      .optional(),
  };
}

export function requestedProject(
  selection: ProjectSelection,
): string | undefined {
  return selection.project || selection.project_id || undefined;
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

  const selector = requestedProject(selection);
  if (selector && selector !== scope.projectId) {
    throw new Error(
      `project must match this connection's fixed project (${scope.projectId})`,
    );
  }
  return scope.projectId;
}

export function projectIDForOperation(
  authInfo: AuthInfo,
  requestedProjectId?: string,
): string | undefined {
  return projectForOperation(authInfo, { project_id: requestedProjectId });
}
