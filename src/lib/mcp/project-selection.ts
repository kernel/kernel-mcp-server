import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { McpConnectionContext } from "@/lib/mcp/auth-context";

const projectIDSchema = z
  .string()
  .min(1)
  .describe(
    "Optional project ID used to scope this operation. On organization-wide connections, omit it to use the API's organization-wide or default-project behavior. On project-scoped connections, omit it or pass the fixed project ID returned by get_connection_context.",
  )
  .optional();

export function projectSelectionInputSchema(): {
  project_id: typeof projectIDSchema;
} {
  return { project_id: projectIDSchema };
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

export function projectIDForOperation(
  authInfo: AuthInfo,
  requestedProjectId?: string,
): string | undefined {
  const { scope } = connectionContextFromAuthInfo(authInfo);
  if (scope.kind === "organization") {
    return requestedProjectId;
  }

  if (requestedProjectId && requestedProjectId !== scope.projectId) {
    throw new Error(
      `project_id must match this connection's fixed project (${scope.projectId})`,
    );
  }
  return scope.projectId;
}
