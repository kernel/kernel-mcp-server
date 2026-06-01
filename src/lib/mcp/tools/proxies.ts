import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerProxyTools(server: McpServer) {
  // manage_proxies -- Create, list, and delete proxy configurations
  server.tool(
    "manage_proxies",
    'Manage proxy configurations for routing browser traffic. Use "create" to add a proxy, "list" to see all proxies, or "delete" to remove one. Proxy quality for bot detection avoidance, best to worst: mobile > residential > ISP > datacenter.',
    {
      action: z
        .enum(["create", "list", "delete"])
        .describe("Operation to perform."),
      proxy_id: z.string().describe("(delete) Proxy ID to delete.").optional(),
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
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
            if (!params.type)
              return {
                content: [
                  { type: "text", text: "Error: type is required for create." },
                ],
              };
            if (
              params.type === "custom" &&
              (!params.custom_host || !params.custom_port)
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: custom_host and custom_port are required for custom proxy type.",
                  },
                ],
              };
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
            if (!proxy)
              return {
                content: [{ type: "text", text: "Failed to create proxy" }],
              };
            return {
              content: [{ type: "text", text: JSON.stringify(proxy, null, 2) }],
            };
          }
          case "list": {
            const proxies = await client.proxies.list();
            return {
              content: [
                {
                  type: "text",
                  text:
                    proxies?.length > 0
                      ? JSON.stringify(proxies, null, 2)
                      : "No proxies found",
                },
              ],
            };
          }
          case "delete": {
            if (!params.proxy_id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: proxy_id is required for delete.",
                  },
                ],
              };
            await client.proxies.delete(params.proxy_id);
            return {
              content: [{ type: "text", text: "Proxy deleted successfully" }],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_proxies (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );
}
