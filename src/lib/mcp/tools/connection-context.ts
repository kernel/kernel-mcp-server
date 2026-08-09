import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import { jsonResponse, throwToolError } from "@/lib/mcp/responses";

export function registerConnectionContextTool(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.tool(
    "get_connection_context",
    "Inspect the authenticated Kernel connection before deciding whether to create or select a project. A non-null authorization.effective_scope.project_id means the connection is already fixed to that project; reuse it and omit project_id. A null effective project means the connection is organization-wide; select or create a project and pass its project_id to project-scoped resource tools.",
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

      try {
        const context = await dependencies
          .createKernelClient(extra.authInfo.token)
          .auth.context.retrieve();
        return jsonResponse(context);
      } catch (error) {
        throwToolError("get_connection_context", "get", error);
      }
    },
  );
}
