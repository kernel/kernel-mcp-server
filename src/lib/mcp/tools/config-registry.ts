import type { McpServer } from "@modelcontextprotocol/server";
import { APIError } from "@onkernel/sdk";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  throwToolError,
  throwToolErrorWithApiBody,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use http or https." },
  );

export function registerConfigRegistryTools(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.registerTool(
    "manage_config_registry",
    {
      description:
        'Find browser and proxy configurations for bot-protected sites. Use "lookup" for a side-effect-free read of current knowledge, "resolve" to start or retry a background analysis, "get_analysis" to poll one analysis, "cancel_analysis" to request cancellation, "list_configs" to list targets and their latest recommendations, or "list_analyses" to list analysis history.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum([
            "lookup",
            "resolve",
            "get_analysis",
            "cancel_analysis",
            "list_configs",
            "list_analyses",
          ])
          .describe("Operation to perform."),
        url: httpUrlSchema
          .describe("(lookup, resolve) Public HTTP(S) target URL.")
          .optional(),
        allowed_proxy_countries: z
          .array(z.string().length(2))
          .describe(
            "(lookup, resolve) ISO 3166 country codes Kernel may use for proxy configurations.",
          )
          .optional(),
        intent: z
          .string()
          .min(1)
          .describe(
            "(resolve) Plain-language workload to exercise during analysis. HTTPS targets only.",
          )
          .optional(),
        analysis_id: z
          .string()
          .min(1)
          .describe(
            "(get_analysis, cancel_analysis) Analysis ID returned by resolve or list actions.",
          )
          .optional(),
        search: z
          .string()
          .describe(
            "(list_configs, list_analyses) Case-insensitive target URL search.",
          )
          .optional(),
        sort_by: z
          .enum([
            "target",
            "analysis_status",
            "recommended_config",
            "last_requested_at",
            "success_rate",
          ])
          .describe("(list_configs) Field used to sort results.")
          .optional(),
        sort_order: z
          .enum(["asc", "desc"])
          .describe("(list_configs) Sort direction.")
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "Manage Kernel config registry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "lookup": {
            if (!params.url) {
              return errorResponse("Error: url is required for lookup.");
            }
            const result = await client.configRegistry.lookup({
              url: params.url,
              ...(params.allowed_proxy_countries !== undefined && {
                allowed_proxy_countries: params.allowed_proxy_countries,
              }),
            });
            return jsonResponse(result);
          }
          case "resolve": {
            if (!params.url) {
              return errorResponse("Error: url is required for resolve.");
            }
            const result = await client.configRegistry.resolve(
              {
                url: params.url,
                ...(params.allowed_proxy_countries !== undefined && {
                  allowed_proxy_countries: params.allowed_proxy_countries,
                }),
                ...(params.intent !== undefined && { intent: params.intent }),
              },
              { maxRetries: 0, signal: ctx.mcpReq.signal },
            );
            return jsonResponse(result);
          }
          case "get_analysis": {
            if (!params.analysis_id) {
              return errorResponse(
                "Error: analysis_id is required for get_analysis.",
              );
            }
            return jsonResponse(
              await client.configRegistry.analyses.retrieve(params.analysis_id),
            );
          }
          case "cancel_analysis": {
            if (!params.analysis_id) {
              return errorResponse(
                "Error: analysis_id is required for cancel_analysis.",
              );
            }
            return jsonResponse(
              await client.configRegistry.analyses.cancel(params.analysis_id),
            );
          }
          case "list_configs": {
            const page = await client.configRegistry.list({
              ...(params.search !== undefined && { search: params.search }),
              ...(params.sort_by !== undefined && {
                sort_by: params.sort_by,
              }),
              ...(params.sort_order !== undefined && {
                sort_order: params.sort_order,
              }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "list_analyses": {
            const page = await client.configRegistry.analyses.list({
              ...(params.search !== undefined && { search: params.search }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
        }
      } catch (error) {
        if (
          params.action === "resolve" &&
          error instanceof APIError &&
          error.status === 409
        ) {
          throwToolErrorWithApiBody(
            "manage_config_registry",
            params.action,
            error,
          );
        }
        throwToolError("manage_config_registry", params.action, error);
      }
    },
  );
}
