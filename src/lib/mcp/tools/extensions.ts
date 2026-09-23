import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

export function registerExtensionTools(server: McpServer) {
  // manage_extensions -- List and delete browser extensions
  server.registerTool(
    "manage_extensions",
    {
      description:
        'Manage browser extensions uploaded to Kernel. Use "list" to see all extensions available to the current project or "delete" to remove one by ID or name.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z.enum(["list", "delete"]).describe("Operation to perform."),
        id_or_name: z
          .string()
          .describe("(delete) Extension ID or name to delete.")
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "Manage Kernel browser extensions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "list": {
            const page = await client.extensions.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              emptyText: "No extensions found",
            });
          }
          case "delete": {
            if (!params.id_or_name) {
              return errorResponse("Error: id_or_name is required for delete.");
            }
            await client.extensions.delete(params.id_or_name);
            return textResponse("Extension deleted successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_extensions", params.action, error);
      }
    },
  );
}
