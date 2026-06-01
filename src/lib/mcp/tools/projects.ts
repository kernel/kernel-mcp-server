import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorMessage,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
} from "@/lib/mcp/responses";

export function registerProjectCapabilities(server: McpServer) {
  // manage_projects -- Create, list, get, update, delete, and manage organization project limits
  server.tool(
    "manage_projects",
    'Manage Kernel projects for resource isolation within an organization. Use "create" to create a project, "list" to discover projects, "get" to retrieve one, "update" to rename or archive one, "delete" to remove an empty project, "get_limits" to inspect project caps, or "update_limits" to change project caps.',
    {
      action: z
        .enum([
          "create",
          "list",
          "get",
          "update",
          "delete",
          "get_limits",
          "update_limits",
        ])
        .describe("Operation to perform."),
      project_id: z
        .string()
        .describe(
          "Project ID. Required for get, update, delete, get_limits, and update_limits.",
        )
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
      limit: z.number().describe("(list) Max results per page.").optional(),
      offset: z.number().describe("(list) Pagination offset.").optional(),
      max_concurrent_invocations: z
        .number()
        .nullable()
        .describe(
          "(update_limits) Maximum concurrent app invocations for this project. Set 0 to remove the cap.",
        )
        .optional(),
      max_concurrent_sessions: z
        .number()
        .nullable()
        .describe(
          "(update_limits) Maximum concurrent browser sessions for this project. Set 0 to remove the cap.",
        )
        .optional(),
      max_pooled_sessions: z
        .number()
        .nullable()
        .describe(
          "(update_limits) Maximum pooled sessions capacity for this project. Set 0 to remove the cap.",
        )
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
            if (!params.name) {
              return textResponse("Error: name is required for create.");
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
              return textResponse("Error: project_id is required for get.");
            }
            const project = await client.projects.retrieve(params.project_id);
            return jsonResponse(project);
          }
          case "update": {
            if (!params.project_id) {
              return textResponse("Error: project_id is required for update.");
            }
            if (!params.name && !params.status) {
              return textResponse(
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
              return textResponse("Error: project_id is required for delete.");
            }
            await client.projects.delete(params.project_id);
            return textResponse("Project deleted successfully");
          }
          case "get_limits": {
            if (!params.project_id) {
              return textResponse(
                "Error: project_id is required for get_limits.",
              );
            }
            const limits = await client.projects.limits.retrieve(
              params.project_id,
            );
            return jsonResponse(limits);
          }
          case "update_limits": {
            if (!params.project_id) {
              return textResponse(
                "Error: project_id is required for update_limits.",
              );
            }
            const updateParams: Parameters<
              typeof client.projects.limits.update
            >[1] = {};
            if (params.max_concurrent_invocations !== undefined) {
              updateParams.max_concurrent_invocations =
                params.max_concurrent_invocations;
            }
            if (params.max_concurrent_sessions !== undefined) {
              updateParams.max_concurrent_sessions =
                params.max_concurrent_sessions;
            }
            if (params.max_pooled_sessions !== undefined) {
              updateParams.max_pooled_sessions = params.max_pooled_sessions;
            }
            if (Object.keys(updateParams).length === 0) {
              return textResponse(
                "Error: at least one limit field is required for update_limits.",
              );
            }
            const limits = await client.projects.limits.update(
              params.project_id,
              updateParams,
            );
            return jsonResponse(limits);
          }
        }
      } catch (error) {
        return textResponse(
          `Error in manage_projects (${params.action}): ${errorMessage(error)}`,
        );
      }
    },
  );
}
