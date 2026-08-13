import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import {
  projectSelectionInputSchema,
  requestedProject,
} from "@/lib/mcp/project-selection";
import { paginationParams } from "@/lib/mcp/schemas";

export function registerProjectCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
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
      ...projectSelectionInputSchema({
        project:
          "Project name or ID. Required for get, update, delete, get_limits, and update_limits.",
        project_id:
          "Deprecated: use `project` instead. Project ID. Required for get, update, delete, get_limits, and update_limits.",
      }),
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
      max_concurrent_invocations: z
        .number()
        .int()
        .min(0)
        .describe(
          "(update_limits) Maximum concurrent app invocations for this project. Set 0 to remove the cap.",
        )
        .optional(),
      max_concurrent_sessions: z
        .number()
        .int()
        .min(0)
        .describe(
          "(update_limits) Maximum concurrent browser sessions for this project. Set 0 to remove the cap.",
        )
        .optional(),
      max_pooled_sessions: z
        .number()
        .int()
        .min(0)
        .describe(
          "(update_limits) Maximum pooled sessions capacity for this project. Set 0 to remove the cap.",
        )
        .optional(),
    },
    {
      title: "Manage Kernel projects",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = dependencies.createKernelClient(extra.authInfo.token);

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
            const idOrName = requestedProject(params);
            if (!idOrName) {
              return errorResponse(
                "Error: project or project_id is required for get.",
              );
            }
            const project = await client.projects.retrieve(idOrName);
            return jsonResponse(project);
          }
          case "update": {
            const idOrName = requestedProject(params);
            if (!idOrName) {
              return errorResponse(
                "Error: project or project_id is required for update.",
              );
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
              idOrName,
              updateParams,
            );
            return jsonResponse(project);
          }
          case "delete": {
            const idOrName = requestedProject(params);
            if (!idOrName) {
              return errorResponse(
                "Error: project or project_id is required for delete.",
              );
            }
            await client.projects.delete(idOrName);
            return textResponse("Project deleted successfully");
          }
          case "get_limits": {
            const idOrName = requestedProject(params);
            if (!idOrName) {
              return errorResponse(
                "Error: project or project_id is required for get_limits.",
              );
            }
            const limits = await client.projects.limits.retrieve(idOrName);
            return jsonResponse(limits);
          }
          case "update_limits": {
            const idOrName = requestedProject(params);
            if (!idOrName) {
              return errorResponse(
                "Error: project or project_id is required for update_limits.",
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
              return errorResponse(
                "Error: at least one limit field is required for update_limits.",
              );
            }
            const limits = await client.projects.limits.update(
              idOrName,
              updateParams,
            );
            return jsonResponse(limits);
          }
        }
      } catch (error) {
        throwToolError("manage_projects", params.action, error);
      }
    },
  );
}
