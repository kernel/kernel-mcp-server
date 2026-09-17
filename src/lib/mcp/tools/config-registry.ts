import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  errorResponse,
  jsonResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    { message: "URL must use http or https." },
  );

export function registerConfigRegistryTool(
  server: McpServer,
  options: McpDependencies = defaultMcpDependencies,
) {
  server.tool(
    "resolve_browser_config",
    'Look up or resolve the Config Registry browser and proxy recommendation for a target before creating a browser. Call "lookup" first; it returns cached global knowledge immediately without starting work. If it returns null or type "no_recommendation", call "resolve" once with the intended workload, then poll "get_analysis" with the returned analysis_id at bounded intervals until terminal. Apply the returned browser settings unchanged. For a managed proxy recipe, create that proxy once with manage_proxies and reuse its ID when creating the browser.',
    {
      ...projectSelectionInputSchema(),
      action: z
        .enum(["lookup", "resolve", "get_analysis"])
        .describe("Operation to perform."),
      url: httpUrlSchema
        .describe("(lookup, resolve) Public target URL.")
        .optional(),
      allowed_proxy_countries: z
        .array(z.string().regex(/^[A-Za-z]{2}$/))
        .min(1)
        .max(10)
        .describe(
          "(lookup, resolve) ISO 3166 country codes allowed for a returned managed proxy.",
        )
        .optional(),
      intent: z
        .string()
        .max(300)
        .describe(
          "(resolve) Plain-language workload to exercise while analyzing the target.",
        )
        .optional(),
      analysis_id: z
        .string()
        .min(1)
        .describe("(get_analysis) Analysis ID returned by resolve.")
        .optional(),
    },
    {
      title: "Resolve a Kernel browser configuration",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = options.createKernelClient(
        extra.authInfo.token,
        projectForOperation(extra.authInfo, params),
      );

      try {
        switch (params.action) {
          case "lookup": {
            if (!params.url) {
              return errorResponse("Error: url is required for lookup.");
            }
            const result = await client.configRegistry.lookup({
              url: params.url,
              ...(params.allowed_proxy_countries && {
                allowed_proxy_countries: params.allowed_proxy_countries,
              }),
            });
            return jsonResponse(result);
          }
          case "resolve": {
            if (!params.url) {
              return errorResponse("Error: url is required for resolve.");
            }
            const result = await client.configRegistry.resolve({
              url: params.url,
              ...(params.allowed_proxy_countries && {
                allowed_proxy_countries: params.allowed_proxy_countries,
              }),
              ...(params.intent && { intent: params.intent }),
            });
            return jsonResponse(result);
          }
          case "get_analysis": {
            if (!params.analysis_id) {
              return errorResponse(
                "Error: analysis_id is required for get_analysis.",
              );
            }
            const result = await client.configRegistry.analyses.retrieve(
              params.analysis_id,
            );
            return jsonResponse(result);
          }
        }
      } catch (error) {
        throwToolError("resolve_browser_config", params.action, error);
      }
    },
  );
}
