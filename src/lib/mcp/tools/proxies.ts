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

export function registerProxyTools(server: McpServer) {
  // manage_proxies -- Create, list, get, check, and delete proxy configurations
  server.tool(
    "manage_proxies",
    'Manage proxy configurations for routing browser traffic. Use "create" to add a proxy, "list" to see all proxies, "get" to retrieve one, "check" to test connectivity (optionally against a target URL), or "delete" to remove one. Proxy quality for bot detection avoidance, best to worst: mobile > residential > ISP > datacenter.',
    {
      action: z
        .enum(["create", "list", "get", "check", "delete"])
        .describe("Operation to perform."),
      proxy_id: z
        .string()
        .describe("(get, check, delete) Proxy ID.")
        .optional(),
      check_url: httpUrlSchema
        .describe(
          "(check) Optional HTTP(S) URL to test through the proxy instead of Kernel's default check target.",
        )
        .optional(),
      type: z
        .enum(["datacenter", "isp", "residential", "mobile", "custom"])
        .describe("(create) Proxy type.")
        .optional(),
      name: z
        .string()
        .describe("(create) Readable name for the proxy.")
        .optional(),
      country: z
        .string()
        .describe("(create) ISO 3166 country code (e.g., 'US').")
        .optional(),
      city: z
        .string()
        .describe(
          "(create) City name without spaces (e.g., 'sanfrancisco'). Requires country.",
        )
        .optional(),
      state: z.string().describe("(create) Two-letter state code.").optional(),
      custom_host: z
        .string()
        .describe("(create, custom type) Proxy host address.")
        .optional(),
      custom_port: z
        .number()
        .describe("(create, custom type) Proxy port.")
        .optional(),
      custom_username: z
        .string()
        .describe("(create, custom type) Auth username.")
        .optional(),
      custom_password: z
        .string()
        .describe("(create, custom type) Auth password.")
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel proxy configurations",
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
          case "create": {
            if (!params.type)
              return errorResponse("Error: type is required for create.");
            if (
              params.type === "custom" &&
              (!params.custom_host || !params.custom_port)
            ) {
              return errorResponse(
                "Error: custom_host and custom_port are required for custom proxy type.",
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
            if (!proxy) return errorResponse("Failed to create proxy");
            return jsonResponse(proxy);
          }
          case "list": {
            const page = await client.proxies.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              emptyText: "No proxies found",
            });
          }
          case "get": {
            if (!params.proxy_id) {
              return errorResponse("Error: proxy_id is required for get.");
            }
            const proxy = await client.proxies.retrieve(params.proxy_id);
            return jsonResponse(proxy);
          }
          case "check": {
            if (!params.proxy_id) {
              return errorResponse("Error: proxy_id is required for check.");
            }
            const result = await client.proxies.check(
              params.proxy_id,
              params.check_url ? { url: params.check_url } : undefined,
            );
            return jsonResponse(result);
          }
          case "delete": {
            if (!params.proxy_id)
              return errorResponse("Error: proxy_id is required for delete.");
            await client.proxies.delete(params.proxy_id);
            return textResponse("Proxy deleted successfully");
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_proxies", params.action, error);
      }
    },
  );
}
