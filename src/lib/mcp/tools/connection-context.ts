import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectionContextFromAuthInfo } from "@/lib/mcp/project-selection";
import { jsonResponse } from "@/lib/mcp/responses";

export function registerConnectionContextTool(server: McpServer) {
  server.tool(
    "get_connection_context",
    "Inspect the authenticated Kernel connection before a project-scoped operation. connection_scope.kind=organization may omit project for organization-wide reads and default-project creates, or pass a project name or ID to select a project. connection_scope.kind=project is fixed to connection_scope.project_id; omit project or pass that project.",
    {},
    {
      title: "Get Kernel connection context",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (_params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const { authContext, scope } = connectionContextFromAuthInfo(
        extra.authInfo,
      );
      return jsonResponse({
        ...authContext,
        connection_scope: {
          kind: scope.kind,
          organization_id: scope.organizationId,
          project_id: scope.projectId,
          source: scope.source,
          project_id_required: false,
        },
      });
    },
  );
}
