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
type BrowserPool = Awaited<
  ReturnType<KernelClient["browserPools"]["retrieve"]>
>;
type BrowserPoolAcquireResponse = Awaited<
  ReturnType<KernelClient["browserPools"]["acquire"]>
>;

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
  const chromePolicy =
    params.chrome_policy && Object.keys(params.chrome_policy).length > 0
      ? params.chrome_policy
      : undefined;

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
      ...(chromePolicy && { chrome_policy: chromePolicy }),
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

function summarizeBrowserPool(pool: BrowserPool) {
  const config = pool.browser_pool_config;
  return {
    id: pool.id,
    name: pool.name,
    created_at: pool.created_at,
    counts: {
      size: config.size,
      available: pool.available_count,
      acquired: pool.acquired_count,
    },
    config: {
      headless: config.headless,
      stealth: config.stealth,
      kiosk_mode: config.kiosk_mode,
      timeout_seconds: config.timeout_seconds,
      fill_rate_per_minute: config.fill_rate_per_minute,
      start_url: config.start_url,
      profile: config.profile,
      proxy_id: config.proxy_id,
      viewport: config.viewport,
      extensions: config.extensions,
      chrome_policy_keys: config.chrome_policy
        ? Object.keys(config.chrome_policy)
        : undefined,
    },
  };
}

function poolNextActions(pool: BrowserPool) {
  return [
    `Use manage_browser_pools with action "acquire" and id_or_name "${pool.id}" to get a browser from this pool.`,
    `Use manage_browser_pools with action "get" and id_or_name "${pool.id}" for full pool details.`,
  ];
}

function summarizeAcquiredBrowser(browser: BrowserPoolAcquireResponse) {
  return {
    session_id: browser.session_id,
    browser_live_view_url: browser.browser_live_view_url,
    base_url: browser.base_url,
    headless: browser.headless,
    stealth: browser.stealth,
    timeout_seconds: browser.timeout_seconds,
    pool: browser.pool,
    profile: browser.profile,
    proxy_id: browser.proxy_id,
    start_url: browser.start_url,
    viewport: browser.viewport,
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
              ? JSON.stringify(pools.map(summarizeBrowserPool), null, 2)
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
    'Manage pre-warmed browser pools when an agent needs fast browser acquisition or reusable session capacity. Use "list" for a compact pool inventory, "get" for full details, "acquire" before controlling a pooled browser, and "release" when the browser should return to the pool.',
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
        .int()
        .min(1)
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
        .int()
        .min(1)
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
        .min(0)
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
        .int()
        .min(1)
        .describe(
          "(create, update) Window width in pixels. Must pair with viewport_height.",
        )
        .optional(),
      viewport_height: z
        .number()
        .int()
        .min(1)
        .describe(
          "(create, update) Window height in pixels. Must pair with viewport_width.",
        )
        .optional(),
      viewport_refresh_rate: z
        .number()
        .int()
        .min(1)
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
        .int()
        .min(0)
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
            return jsonResponse({
              browser_pool: summarizeBrowserPool(pool),
              next_actions: poolNextActions(pool),
            });
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
            return jsonResponse({
              browser_pool: summarizeBrowserPool(pool),
              next_actions: [
                ...poolNextActions(pool),
                ...(params.discard_all_idle
                  ? [
                      "discard_all_idle was requested; idle browsers may be rebuilt before the next acquire.",
                    ]
                  : []),
              ],
            });
          }
          case "list": {
            const pools = (await client.browserPools.list()) ?? [];
            return pools.length > 0
              ? jsonResponse({
                  items: pools.map(summarizeBrowserPool),
                  note: 'Use action "get" with id_or_name for full pool details.',
                })
              : textResponse("No browser pools found");
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
            return jsonResponse({
              browser: summarizeAcquiredBrowser(browser),
              next_actions: [
                `Use computer_action with session_id "${browser.session_id}" to control this browser.`,
                `When finished, use manage_browser_pools with action "release", id_or_name "${params.id_or_name}", and session_id "${browser.session_id}".`,
                `Use manage_browsers with action "get" and session_id "${browser.session_id}" for full browser details.`,
              ],
            });
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
