import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

export function registerExtensionTools(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  // manage_extensions -- List and delete browser extensions
  server.registerTool(
    "manage_extensions",
    {
      description:
        'manage browser extensions uploaded to KERNEL. use "list" to discover project extensions, "get" to read metadata without downloading an archive, or "delete" to remove one by id or name. binary archive download and upload are intentionally outside the json mcp tool surface.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum(["list", "get", "delete"])
          .describe("operation to perform."),
        id_or_name: z
          .string()
          .describe("(get, delete) extension id or name.")
          .optional(),
        name: z
          .string()
          .describe("(list) exact-match extension name filter.")
          .optional(),
        query: z
          .string()
          .describe(
            "(list) case-insensitive substring match against extension name; ids match exactly.",
          )
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL browser extensions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = options.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "list": {
            const page = await client.extensions.list({
              ...(params.name !== undefined && { name: params.name }),
              ...(params.query !== undefined && { query: params.query }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              emptyText: "no extensions found",
            });
          }
          case "get": {
            if (!params.id_or_name) {
              return errorResponse("error: id_or_name is required for get.");
            }
            return jsonResponse(await client.extensions.get(params.id_or_name));
          }
          case "delete": {
            if (!params.id_or_name) {
              return errorResponse("error: id_or_name is required for delete.");
            }
            await client.extensions.delete(params.id_or_name);
            return textResponse("extension deleted successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_extensions", params.action, error);
      }
    },
  );
}
