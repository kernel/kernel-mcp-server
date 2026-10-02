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
    { message: "url must use http or https." },
  );

export function registerProxyTools(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  // manage_proxies -- Create, list, get, rename, check, and delete proxy configurations
  server.registerTool(
    "manage_proxies",
    {
      description:
        'manage proxy configurations for routing browser traffic. use "create" to add a proxy, "list" to see all proxies, "get" to retrieve one, "rename" to change its name, "check" to test connectivity (optionally against a target url), or "delete" to remove one. choose a proxy type that fits the workload and the terms of the target site.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum(["create", "list", "get", "rename", "check", "delete"])
          .describe("operation to perform."),
        proxy_id: z
          .string()
          .describe("(get, rename, check, delete) proxy id.")
          .optional(),
        check_url: httpUrlSchema
          .describe(
            "(check) optional http(s) url to test through the proxy instead of KERNEL's default check target.",
          )
          .optional(),
        type: z
          .enum(["datacenter", "isp", "residential", "mobile", "custom"])
          .describe("(create) proxy type.")
          .optional(),
        name: z
          .string()
          .describe("(create, rename) readable name for the proxy.")
          .optional(),
        country: z
          .string()
          .describe('(create) iso 3166 country code (e.g., "US").')
          .optional(),
        city: z
          .string()
          .describe(
            "(create) city name without spaces (e.g., 'sanfrancisco'). requires country.",
          )
          .optional(),
        state: z
          .string()
          .describe("(create) two-letter state code.")
          .optional(),
        custom_host: z
          .string()
          .describe("(create, custom type) proxy host address.")
          .optional(),
        custom_port: z
          .number()
          .describe("(create, custom type) proxy port.")
          .optional(),
        custom_username: z
          .string()
          .describe("(create, custom type) auth username.")
          .optional(),
        custom_password: z
          .string()
          .describe("(create, custom type) auth password.")
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL proxy configurations",
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
          case "create": {
            if (!params.type)
              return errorResponse("error: type is required for create.");
            if (
              params.type === "custom" &&
              (!params.custom_host || !params.custom_port)
            ) {
              return errorResponse(
                "error: custom_host and custom_port are required for custom proxy type.",
              );
            }
            const createParams: Parameters<typeof client.proxies.create>[0] =
              params.type === "custom"
                ? {
                    type: params.type,
                    ...(params.name && { name: params.name }),
                    config: {
                      host: params.custom_host!,
                      port: params.custom_port!,
                      ...(params.custom_username && {
                        username: params.custom_username,
                      }),
                      ...(params.custom_password && {
                        password: params.custom_password,
                      }),
                    },
                  }
                : {
                    type: params.type,
                    ...(params.name && { name: params.name }),
                    ...((params.country || params.city || params.state) && {
                      config: {
                        ...(params.country && { country: params.country }),
                        ...(params.city && { city: params.city }),
                        ...(params.state && { state: params.state }),
                      },
                    }),
                  };
            const proxy = await client.proxies.create(createParams);
            if (!proxy) return errorResponse("failed to create proxy");
            return jsonResponse(proxy);
          }
          case "list": {
            const page = await client.proxies.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              emptyText: "no proxies found",
            });
          }
          case "get": {
            if (!params.proxy_id) {
              return errorResponse("error: proxy_id is required for get.");
            }
            const proxy = await client.proxies.retrieve(params.proxy_id);
            return jsonResponse(proxy);
          }
          case "rename": {
            if (!params.proxy_id) {
              return errorResponse("error: proxy_id is required for rename.");
            }
            if (!params.name) {
              return errorResponse("error: name is required for rename.");
            }
            const proxy = await client.proxies.update(params.proxy_id, {
              name: params.name,
            });
            return jsonResponse(proxy);
          }
          case "check": {
            if (!params.proxy_id) {
              return errorResponse("error: proxy_id is required for check.");
            }
            const result = await client.proxies.check(
              params.proxy_id,
              params.check_url ? { url: params.check_url } : undefined,
            );
            return jsonResponse(result);
          }
          case "delete": {
            if (!params.proxy_id)
              return errorResponse("error: proxy_id is required for delete.");
            await client.proxies.delete(params.proxy_id);
            return textResponse("proxy deleted successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_proxies", params.action, error);
      }
    },
  );
}
