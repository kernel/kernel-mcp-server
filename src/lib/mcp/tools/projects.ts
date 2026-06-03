import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

export function registerProjectCapabilities(server: McpServer) {
  // manage_projects -- Create, list, get, update, and delete organization projects
  server.tool(
    "manage_projects",
    'Manage Kernel projects for resource isolation within an organization. Use "create" to create a project, "list" to discover projects, "get" to retrieve one, "update" to rename or archive one, or "delete" to remove an empty project.',
    {
      action: z
        .enum(["create", "list", "get", "update", "delete"])
        .describe("Operation to perform."),
      project_id: z
        .string()
        .describe("Project ID. Required for get, update, and delete.")
        .optional(),
      name: z.string().describe("(create, update) Project name.").optional(),
      status: z
        .enum(["active", "archived"])
        .describe('(update) Project status. Use "archived" to archive.')
        .optional(),
      query: z
        .string()
        .describe(
          "(list) Case-insensitive substring match against project name.",
        )
        .optional(),
      ...paginationParams,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
            if (!params.name) {
              return errorResponse("Error: name is required for create.");
            }
            const project = await client.projects.create({ name: params.name });
            return jsonResponse(project);
          }
          case "list": {
            const page = await client.projects.list({
              ...(params.query && { query: params.query }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.project_id) {
              return errorResponse("Error: project_id is required for get.");
            }
            const project = await client.projects.retrieve(params.project_id);
            return jsonResponse(project);
          }
          case "update": {
            if (!params.project_id) {
              return errorResponse("Error: project_id is required for update.");
            }
            if (!params.name && !params.status) {
              return errorResponse(
                "Error: name or status is required for update.",
              );
            }
            const updateParams: Parameters<typeof client.projects.update>[1] =
              {};
            if (params.name) updateParams.name = params.name;
            if (params.status) updateParams.status = params.status;
            const project = await client.projects.update(
              params.project_id,
              updateParams,
            );
            return jsonResponse(project);
          }
          case "delete": {
            if (!params.project_id) {
              return errorResponse("Error: project_id is required for delete.");
            }
            await client.projects.delete(params.project_id);
            return textResponse("Project deleted successfully");
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_projects", params.action, error);
      }
    },
  );
}
