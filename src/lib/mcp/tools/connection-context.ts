import type { McpServer } from "@modelcontextprotocol/server";
import { connectionContextFromAuthInfo } from "@/lib/mcp/project-selection";
import { jsonResponse } from "@/lib/mcp/responses";
import { z } from "zod";

export function registerConnectionContextTool(server: McpServer) {
  server.registerTool(
    "get_connection_context",
    {
      description:
        "Inspect the authenticated Kernel connection before a project-scoped operation. connection_scope.kind=organization may omit project for organization-wide reads and default-project creates, or pass a project name or ID to select a project. connection_scope.kind=project is fixed to connection_scope.project_id; omit project or pass that project.",
      inputSchema: z.object({}),
      annotations: {
        title: "Get Kernel connection context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
      const { authContext, scope } = connectionContextFromAuthInfo(
        ctx.http.authInfo,
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
