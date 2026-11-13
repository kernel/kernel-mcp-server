import type { McpServer } from "@modelcontextprotocol/server";
import { connectionContextFromAuthInfo } from "@/lib/mcp/project-selection";
import { jsonResponse } from "@/lib/mcp/responses";
import { z } from "zod";

export function registerConnectionContextTool(server: McpServer) {
  server.registerTool(
    "get_connection_context",
    {
      description:
        "inspect the authenticated KERNEL connection before a project-scoped operation. connection_scope.kind=organization may omit project for organization-wide reads and default-project creates, or pass a project name or id to select a project. connection_scope.kind=project is fixed to connection_scope.project_id; omit project or pass that project. when the person who connected chose what this connection may do, granted.permissions lists the allowed actions and granted.projects the only projects it may use (absent means every project); with one granted project, omit project to use it.",
      inputSchema: z.object({}),
      annotations: {
        title: "get KERNEL connection context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const { authContext, scope } = connectionContextFromAuthInfo(
        ctx.http.authInfo,
      );
      const { permissions, projects } = ctx.http.authInfo.extra ?? {};
      return jsonResponse({
        ...authContext,
        ...(permissions !== undefined && {
          granted: { permissions, projects },
        }),
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
