import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerBrowserPoolCapabilities(server: McpServer) {
  server.resource("browser_pools", "browser_pools://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const uriString = uri.toString();

    if (uriString === "browser_pools://") {
      const pools = await client.browserPools.list();
      return {
        contents: [
          {
            uri: "browser_pools://",
            mimeType: "application/json",
            text:
              pools && pools.length > 0
                ? JSON.stringify(pools, null, 2)
                : "No browser pools found",
          },
        ],
      };
    } else if (uriString.startsWith("browser_pools://")) {
      const idOrName = uriString.replace("browser_pools://", "");
      const pool = await client.browserPools.retrieve(idOrName);

      if (!pool) {
        throw new Error(`Browser pool "${idOrName}" not found`);
      }

      return {
        contents: [
          {
            uri: uriString,
            mimeType: "application/json",
            text: JSON.stringify(pool, null, 2),
          },
        ],
      };
    }

    throw new Error(`Invalid browser pool URI: ${uriString}`);
  });

  // manage_browser_pools -- Create, list, get, delete, flush, acquire, and release browser pools
  server.tool(
    "manage_browser_pools",
    'Manage pools of pre-warmed browser instances for fast acquisition. Use "create" to set up a pool, "list"/"get" to inspect pools, "acquire" to get a browser from a pool, "release" to return it, "flush" to destroy idle browsers, or "delete" to remove a pool.',
    {
      action: z
        .enum([
          "create",
          "list",
          "get",
          "delete",
          "flush",
          "acquire",
          "release",
        ])
        .describe("Operation to perform."),
      id_or_name: z
        .string()
        .describe(
          "Pool ID or name. Required for get/delete/flush/acquire/release.",
        )
        .optional(),
      size: z
        .number()
        .describe("(create) Number of browsers to maintain in the pool.")
        .optional(),
      name: z.string().describe("(create) Unique pool name.").optional(),
      headless: z
        .boolean()
        .describe("(create) Headless mode for pool browsers.")
        .optional(),
      stealth: z
        .boolean()
        .describe("(create) Stealth mode for pool browsers.")
        .optional(),
      timeout_seconds: z
        .number()
        .describe("(create) Idle timeout for acquired browsers. Default 600.")
        .optional(),
      profile_name: z
        .string()
        .describe("(create) Profile to load into pool browsers.")
        .optional(),
      proxy_id: z
        .string()
        .describe("(create) Proxy for pool browsers.")
        .optional(),
      fill_rate_per_minute: z
        .number()
        .describe("(create) Pool fill rate percentage per minute. Default 10%.")
        .optional(),
      force: z
        .boolean()
        .describe("(delete) Force delete even if browsers are leased.")
        .optional(),
      acquire_timeout_seconds: z
        .number()
        .describe("(acquire) Max seconds to wait for a browser.")
        .optional(),
      session_id: z
        .string()
        .describe("(release) Session ID of browser to release.")
        .optional(),
      reuse: z
        .boolean()
        .describe("(release) Reuse browser instance or recreate. Default true.")
        .optional(),
    },
    {
      title: "Manage Kernel browser pools",
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
            if (params.size === undefined)
              return {
                content: [
                  { type: "text", text: "Error: size is required for create." },
                ],
              };
            const pool = await client.browserPools.create({
              size: params.size,
              ...(params.name && { name: params.name }),
              ...(params.headless !== undefined && {
                headless: params.headless,
              }),
              ...(params.stealth !== undefined && { stealth: params.stealth }),
              ...(params.timeout_seconds !== undefined && {
                timeout_seconds: params.timeout_seconds,
              }),
              ...(params.profile_name && {
                profile: { name: params.profile_name },
              }),
              ...(params.proxy_id && { proxy_id: params.proxy_id }),
              ...(params.fill_rate_per_minute !== undefined && {
                fill_rate_per_minute: params.fill_rate_per_minute,
              }),
            });
            if (!pool)
              return {
                content: [
                  { type: "text", text: "Failed to create browser pool" },
                ],
              };
            return {
              content: [{ type: "text", text: JSON.stringify(pool, null, 2) }],
            };
          }
          case "list": {
            const pools = await client.browserPools.list();
            return {
              content: [
                {
                  type: "text",
                  text:
                    pools?.length > 0
                      ? JSON.stringify(pools, null, 2)
                      : "No browser pools found",
                },
              ],
            };
          }
          case "get": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for get.",
                  },
                ],
              };
            const pool = await client.browserPools.retrieve(params.id_or_name);
            if (!pool)
              return {
                content: [
                  {
                    type: "text",
                    text: `Browser pool "${params.id_or_name}" not found`,
                  },
                ],
              };
            return {
              content: [{ type: "text", text: JSON.stringify(pool, null, 2) }],
            };
          }
          case "delete": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for delete.",
                  },
                ],
              };
            await client.browserPools.delete(params.id_or_name, {
              ...(params.force !== undefined && { force: params.force }),
            });
            return {
              content: [
                { type: "text", text: "Browser pool deleted successfully" },
              ],
            };
          }
          case "flush": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for flush.",
                  },
                ],
              };
            await client.browserPools.flush(params.id_or_name);
            return {
              content: [
                {
                  type: "text",
                  text: "Pool flushed successfully. All idle browsers destroyed.",
                },
              ],
            };
          }
          case "acquire": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for acquire.",
                  },
                ],
              };
            const browser = await client.browserPools.acquire(
              params.id_or_name,
              {
                ...(params.acquire_timeout_seconds !== undefined && {
                  acquire_timeout_seconds: params.acquire_timeout_seconds,
                }),
              },
            );
            if (!browser)
              return {
                content: [
                  { type: "text", text: "Failed to acquire browser from pool" },
                ],
              };
            return {
              content: [
                { type: "text", text: JSON.stringify(browser, null, 2) },
              ],
            };
          }
          case "release": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for release.",
                  },
                ],
              };
            if (!params.session_id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: session_id is required for release.",
                  },
                ],
              };
            await client.browserPools.release(params.id_or_name, {
              session_id: params.session_id,
              ...(params.reuse !== undefined && { reuse: params.reuse }),
            });
            return {
              content: [
                {
                  type: "text",
                  text: "Browser released back to pool successfully",
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_browser_pools (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );
}
