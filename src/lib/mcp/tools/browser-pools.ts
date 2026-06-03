import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildBrowserCreateConfig,
  type BrowserConfigResult,
  type BrowserCreateConfigParams,
} from "@/lib/mcp/browser-config";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  jsonResponse,
  errorResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";

type BrowserPoolCreateParams = Parameters<
  KernelClient["browserPools"]["create"]
>[0];
type BrowserPoolUpdateParams = Parameters<
  KernelClient["browserPools"]["update"]
>[1];

type BrowserPoolAction =
  | "create"
  | "update"
  | "list"
  | "get"
  | "delete"
  | "flush"
  | "acquire"
  | "release";

type PoolConfigParams = BrowserCreateConfigParams & {
  size?: number;
  name?: string;
  headless?: boolean;
  stealth?: boolean;
  timeout_seconds?: number;
  proxy_id?: string;
  fill_rate_per_minute?: number;
  chrome_policy?: Record<string, unknown>;
  kiosk_mode?: boolean;
};

function buildPoolConfigParams(
  params: PoolConfigParams,
): BrowserConfigResult<BrowserPoolUpdateParams> {
  const browserConfig = buildBrowserCreateConfig(params);
  if (!browserConfig.ok) return browserConfig;

  return {
    ok: true,
    value: {
      ...(params.size !== undefined && { size: params.size }),
      ...(params.name && { name: params.name }),
      ...(params.headless !== undefined && { headless: params.headless }),
      ...(params.stealth !== undefined && { stealth: params.stealth }),
      ...(params.timeout_seconds !== undefined && {
        timeout_seconds: params.timeout_seconds,
      }),
      ...(params.proxy_id !== undefined && { proxy_id: params.proxy_id }),
      ...(params.fill_rate_per_minute !== undefined && {
        fill_rate_per_minute: params.fill_rate_per_minute,
      }),
      ...(params.chrome_policy !== undefined && {
        chrome_policy: params.chrome_policy,
      }),
      ...(params.kiosk_mode !== undefined && { kiosk_mode: params.kiosk_mode }),
      ...browserConfig.value,
    },
  };
}

function buildPoolCreateParams(
  params: PoolConfigParams,
): BrowserConfigResult<BrowserPoolCreateParams> {
  if (params.size === undefined) {
    return { ok: false, error: "Error: size is required for create." };
  }

  const config = buildPoolConfigParams(params);
  if (!config.ok) return config;

  return { ok: true, value: { ...config.value, size: params.size } };
}

function buildPoolUpdateParams(
  params: PoolConfigParams & { discard_all_idle?: boolean },
): BrowserConfigResult<BrowserPoolUpdateParams> {
  const config = buildPoolConfigParams(params);
  if (!config.ok) return config;

  return {
    ok: true,
    value: {
      ...config.value,
      ...(params.discard_all_idle !== undefined && {
        discard_all_idle: params.discard_all_idle,
      }),
    },
  };
}

export function registerBrowserPoolCapabilities(server: McpServer) {
  server.resource("browser_pools", "browser-pools://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const pools = await client.browserPools.list();
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text:
            pools && pools.length > 0
              ? JSON.stringify(pools, null, 2)
              : "No browser pools found",
        },
      ],
    };
  });

  registerJsonResourceTemplate(server, {
    name: "browser_pool",
    uriTemplate: "browser-pools://{idOrName}",
    variableName: "idOrName",
    resourceLabel: "Browser pool",
    read: (client, idOrName) => client.browserPools.retrieve(idOrName),
  });

  // manage_browser_pools -- Create, update, list, get, delete, flush, acquire, and release browser pools
  server.tool(
    "manage_browser_pools",
    'Manage pools of pre-warmed browser instances for fast acquisition. Use "create" to set up a pool, "update" to change pool configuration, "list"/"get" to inspect pools, "acquire" to get a browser from a pool, "release" to return it, "flush" to destroy idle browsers, or "delete" to remove a pool.',
    {
      action: z
        .enum([
          "create",
          "update",
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
          "Pool ID or name. Required for update/get/delete/flush/acquire/release.",
        )
        .optional(),
      size: z
        .number()
        .describe(
          "(create, update) Number of browsers to maintain in the pool.",
        )
        .optional(),
      name: z
        .string()
        .describe("(create, update) Unique pool name.")
        .optional(),
      headless: z
        .boolean()
        .describe("(create, update) Headless mode for pool browsers.")
        .optional(),
      stealth: z
        .boolean()
        .describe("(create, update) Stealth mode for pool browsers.")
        .optional(),
      timeout_seconds: z
        .number()
        .describe(
          "(create, update) Idle timeout for acquired browsers. Default 600.",
        )
        .optional(),
      profile_name: z
        .string()
        .describe(
          "(create, update) Profile name to load into pool browsers. Cannot use with profile_id.",
        )
        .optional(),
      profile_id: z
        .string()
        .describe(
          "(create, update) Profile ID to load into pool browsers. Cannot use with profile_name.",
        )
        .optional(),
      save_profile_changes: z
        .boolean()
        .describe(
          "(create, update) Save browser changes back to the selected profile when sessions end.",
        )
        .optional(),
      proxy_id: z
        .string()
        .describe("(create, update) Proxy for pool browsers.")
        .optional(),
      fill_rate_per_minute: z
        .number()
        .describe(
          "(create, update) Pool fill rate percentage per minute. Default 10%.",
        )
        .optional(),
      start_url: z
        .string()
        .url()
        .describe(
          "(create, update) URL to open when a browser is warmed into the pool. Navigation is best-effort.",
        )
        .optional(),
      chrome_policy: z
        .record(z.string(), z.unknown())
        .describe(
          "(create, update) Chrome enterprise policy overrides for all browsers in the pool. Kernel-managed policies such as extensions, proxy, CDP, and automation are blocked by the API.",
        )
        .optional(),
      kiosk_mode: z
        .boolean()
        .describe("(create, update) Hide address bar/tabs in live view.")
        .optional(),
      extension_id: z
        .string()
        .describe("(create, update) Extension ID to load.")
        .optional(),
      extension_name: z
        .string()
        .describe("(create, update) Extension name to load.")
        .optional(),
      viewport_width: z
        .number()
        .describe(
          "(create, update) Window width in pixels. Must pair with viewport_height.",
        )
        .optional(),
      viewport_height: z
        .number()
        .describe(
          "(create, update) Window height in pixels. Must pair with viewport_width.",
        )
        .optional(),
      viewport_refresh_rate: z
        .number()
        .describe("(create, update) Display refresh rate in Hz.")
        .optional(),
      discard_all_idle: z
        .boolean()
        .describe(
          "(update) Discard idle browsers and rebuild the pool immediately.",
        )
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
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
            const createParams = buildPoolCreateParams(params);
            if (!createParams.ok) return errorResponse(createParams.error);

            const pool = await client.browserPools.create(createParams.value);
            if (!pool) return errorResponse("Failed to create browser pool");
            return jsonResponse(pool);
          }
          case "update": {
            if (!params.id_or_name) {
              return errorResponse("Error: id_or_name is required for update.");
            }

            const updateParams = buildPoolUpdateParams(params);
            if (!updateParams.ok) return errorResponse(updateParams.error);
            if (Object.keys(updateParams.value).length === 0) {
              return errorResponse(
                "Error: at least one update field is required.",
              );
            }

            const pool = await client.browserPools.update(
              params.id_or_name,
              updateParams.value,
            );
            if (!pool) return errorResponse("Failed to update browser pool");
            return jsonResponse(pool);
          }
          case "list": {
            const pools = await client.browserPools.list();
            return textResponse(
              pools?.length > 0
                ? JSON.stringify(pools, null, 2)
                : "No browser pools found",
            );
          }
          case "get": {
            if (!params.id_or_name)
              return errorResponse("Error: id_or_name is required for get.");
            const pool = await client.browserPools.retrieve(params.id_or_name);
            if (!pool)
              return errorResponse(
                `Browser pool "${params.id_or_name}" not found`,
              );
            return jsonResponse(pool);
          }
          case "delete": {
            if (!params.id_or_name)
              return errorResponse("Error: id_or_name is required for delete.");
            await client.browserPools.delete(params.id_or_name, {
              ...(params.force !== undefined && { force: params.force }),
            });
            return textResponse("Browser pool deleted successfully");
          }
          case "flush": {
            if (!params.id_or_name)
              return errorResponse("Error: id_or_name is required for flush.");
            await client.browserPools.flush(params.id_or_name);
            return textResponse(
              "Pool flushed successfully. All idle browsers destroyed.",
            );
          }
          case "acquire": {
            if (!params.id_or_name)
              return errorResponse(
                "Error: id_or_name is required for acquire.",
              );
            const browser = await client.browserPools.acquire(
              params.id_or_name,
              {
                ...(params.acquire_timeout_seconds !== undefined && {
                  acquire_timeout_seconds: params.acquire_timeout_seconds,
                }),
              },
            );
            if (!browser)
              return errorResponse("Failed to acquire browser from pool");
            return jsonResponse(browser);
          }
          case "release": {
            if (!params.id_or_name)
              return errorResponse(
                "Error: id_or_name is required for release.",
              );
            if (!params.session_id)
              return errorResponse(
                "Error: session_id is required for release.",
              );
            await client.browserPools.release(params.id_or_name, {
              session_id: params.session_id,
              ...(params.reuse !== undefined && { reuse: params.reuse }),
            });
            return textResponse("Browser released back to pool successfully");
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_browser_pools", params.action, error);
      }
    },
  );
}
