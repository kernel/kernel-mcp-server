import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  itemsJsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

export function registerExtensionTools(server: McpServer) {
  // manage_extensions -- List and delete browser extensions
  server.tool(
    "manage_extensions",
    'Manage browser extensions uploaded to Kernel. Use "list" to see all extensions available to the current project or "delete" to remove one by ID or name.',
    {
      action: z.enum(["list", "delete"]).describe("Operation to perform."),
      id_or_name: z
        .string()
        .describe("(delete) Extension ID or name to delete.")
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel browser extensions",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const page = await client.extensions.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return itemsJsonResponse(page?.items ?? [], {
              has_more: page?.has_more ?? false,
              next_offset: page?.next_offset ?? null,
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
        return toolErrorResponse("manage_extensions", params.action, error);
      }
    },
  );
}
