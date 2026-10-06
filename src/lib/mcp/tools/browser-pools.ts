import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  buildBrowserCreateConfig,
  buildBrowserSharedConfig,
  type BrowserConfigResult,
  type BrowserCreateConfigParams,
} from "@/lib/mcp/browser-config";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  registerJsonResourceCollection,
  registerJsonResourceTemplate,
} from "@/lib/mcp/resource-templates";
import {
  jsonResponse,
  errorResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

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

type PoolConfigParams = Omit<
  BrowserCreateConfigParams,
  "save_profile_changes"
> & {
  size?: number;
  name?: string;
  headless?: boolean;
  stealth?: boolean;
  timeout_seconds?: number;
  proxy_id?: string;
  fill_rate_per_minute?: number;
  chrome_policy?: Record<string, unknown>;
  kiosk_mode?: boolean;
  clear_profile?: boolean;
  clear_extensions?: boolean;
};

const browserPoolTimeoutSchema = z.number().int().min(10).max(259200);
const browserPoolFillRateSchema = z.number().int().min(0);

function buildPoolCreateParams(
  params: PoolConfigParams,
): BrowserConfigResult<BrowserPoolCreateParams> {
  if (params.size === undefined) {
    return { ok: false, error: "error: size is required for create." };
  }
  if (params.clear_profile || params.clear_extensions) {
    return {
      ok: false,
      error: "error: clear_profile and clear_extensions are update-only.",
    };
  }
  if (params.start_url === "") {
    return {
      ok: false,
      error: "error: an empty start_url is update-only.",
    };
  }

  const browserConfig = buildBrowserCreateConfig(params);
  if (!browserConfig.ok) return browserConfig;
  const chromePolicy =
    params.chrome_policy && Object.keys(params.chrome_policy).length > 0
      ? params.chrome_policy
      : undefined;

  return {
    ok: true,
    value: {
      size: params.size,
      ...(params.name && { name: params.name }),
      ...(params.headless !== undefined && { headless: params.headless }),
      ...(params.stealth !== undefined && { stealth: params.stealth }),
      ...(params.timeout_seconds !== undefined && {
        timeout_seconds: params.timeout_seconds,
      }),
      ...(params.proxy_id && { proxy_id: params.proxy_id }),
      ...(params.fill_rate_per_minute !== undefined && {
        fill_rate_per_minute: params.fill_rate_per_minute,
      }),
      ...(chromePolicy && { chrome_policy: chromePolicy }),
      ...(params.kiosk_mode !== undefined && { kiosk_mode: params.kiosk_mode }),
      ...browserConfig.value,
    },
  };
}

function buildPoolUpdateParams(
  params: PoolConfigParams & { discard_all_idle?: boolean },
): BrowserConfigResult<BrowserPoolUpdateParams> {
  if (params.clear_profile && (params.profile_id || params.profile_name)) {
    return {
      ok: false,
      error:
        "error: clear_profile cannot be combined with profile_id or profile_name.",
    };
  }
  if (
    params.clear_extensions &&
    (params.extension_id || params.extension_name)
  ) {
    return {
      ok: false,
      error:
        "error: clear_extensions cannot be combined with extension_id or extension_name.",
    };
  }

  const browserConfig = buildBrowserSharedConfig(params);
  if (!browserConfig.ok) return browserConfig;
  if (params.start_url) {
    try {
      new URL(params.start_url);
    } catch {
      return { ok: false, error: "error: start_url must be a valid url." };
    }
  }

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
      ...(params.start_url !== undefined && { start_url: params.start_url }),
      ...browserConfig.value,
      ...(params.clear_profile && { profile: { id: "" } }),
      ...(params.clear_extensions && { extensions: [] }),
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
      profile_id: pool.profile_id,
      proxy_id: config.proxy_id,
      viewport: config.viewport,
      extension_ids: pool.extension_ids,
      chrome_policy_keys: config.chrome_policy
        ? Object.keys(config.chrome_policy)
        : undefined,
    },
  };
}

function poolNextActions(pool: BrowserPool) {
  return [
    `use manage_browser_pools with action "acquire" and id_or_name "${pool.id}" to get a browser from this pool.`,
    `use manage_browser_pools with action "get" and id_or_name "${pool.id}" for full pool details.`,
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
  registerJsonResourceCollection(server, {
    name: "browser_pools",
    uriTemplate:
      "kernel://orgs/{organizationId}/projects/{projectId}/browser-pools",
    emptyText: "no browser pools found",
    read: async (client) => {
      const pools = [];
      for await (const pool of client.browserPools.list()) {
        pools.push(summarizeBrowserPool(pool));
      }
      return pools;
    },
  });

  registerJsonResourceTemplate(server, {
    name: "browser_pool",
    uriTemplate:
      "kernel://orgs/{organizationId}/projects/{projectId}/browser-pools/{idOrName}",
    variableName: "idOrName",
    resourceLabel: "browser pool",
    read: (client, idOrName) => client.browserPools.retrieve(idOrName),
  });

  // manage_browser_pools -- Create, update, list, get, delete, flush, acquire, and release browser pools
  server.registerTool(
    "manage_browser_pools",
    {
      description:
        'manage pre-warmed browser pools when an agent needs fast browser acquisition or reusable session capacity. use "list" for a compact pool inventory, "get" for full details, "acquire" before controlling a pooled browser, and "release" when the browser should return to the pool.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
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
          .describe("operation to perform."),
        id_or_name: z
          .string()
          .describe(
            "pool id or name. required for update/get/delete/flush/acquire/release.",
          )
          .optional(),
        size: z
          .number()
          .int()
          .min(1)
          .describe(
            "(create, update) number of browsers to maintain in the pool.",
          )
          .optional(),
        name: z
          .string()
          .describe("(create, update) unique pool name.")
          .optional(),
        headless: z
          .boolean()
          .describe("(create, update) headless mode for pool browsers.")
          .optional(),
        stealth: z
          .boolean()
          .describe(
            "(create, update) apply site-compatibility settings to pool browsers.",
          )
          .optional(),
        timeout_seconds: browserPoolTimeoutSchema
          .describe(
            "(create, update) idle timeout for acquired browsers. default 600.",
          )
          .optional(),
        profile_name: z
          .string()
          .describe(
            "(create, update) profile name to load into pool browsers. cannot use with profile_id.",
          )
          .optional(),
        profile_id: z
          .string()
          .describe(
            "(create, update) profile id to load into pool browsers. cannot use with profile_name.",
          )
          .optional(),
        clear_profile: z
          .boolean()
          .describe(
            "(update) remove the profile from the pool. cannot use with profile_id or profile_name.",
          )
          .optional(),
        proxy_id: z
          .string()
          .describe(
            "(create, update) proxy for pool browsers. on update, an empty string clears the proxy.",
          )
          .optional(),
        fill_rate_per_minute: browserPoolFillRateSchema
          .describe(
            "(create, update) pool fill rate percentage per minute. default 25%.",
          )
          .optional(),
        start_url: z
          .union([z.literal(""), z.string().url()])
          .describe(
            "(create, update) url to open when a browser is warmed into the pool. on update, an empty string clears it. navigation is best-effort.",
          )
          .optional(),
        chrome_policy: z
          .record(z.string(), z.unknown())
          .describe(
            "(create, update) chrome enterprise policy overrides for all browsers in the pool. on update, an empty object clears the policy. KERNEL-managed policies such as extensions, proxy, cdp, and automation are blocked by the api.",
          )
          .optional(),
        kiosk_mode: z
          .boolean()
          .describe("(create, update) hide address bar/tabs in live view.")
          .optional(),
        extension_id: z
          .string()
          .describe("(create, update) extension id to load.")
          .optional(),
        extension_name: z
          .string()
          .describe("(create, update) extension name to load.")
          .optional(),
        clear_extensions: z
          .boolean()
          .describe(
            "(update) remove all extensions from the pool. cannot use with extension_id or extension_name.",
          )
          .optional(),
        viewport_width: z
          .number()
          .int()
          .min(1)
          .describe(
            "(create, update) window width in pixels. must pair with viewport_height.",
          )
          .optional(),
        viewport_height: z
          .number()
          .int()
          .min(1)
          .describe(
            "(create, update) window height in pixels. must pair with viewport_width.",
          )
          .optional(),
        viewport_refresh_rate: z
          .number()
          .int()
          .min(1)
          .describe("(create, update) display refresh rate in hz.")
          .optional(),
        discard_all_idle: z
          .boolean()
          .describe(
            "(update) discard idle browsers and rebuild the pool immediately.",
          )
          .optional(),
        force: z
          .boolean()
          .describe("(delete) force delete even if browsers are leased.")
          .optional(),
        acquire_timeout_seconds: z
          .number()
          .int()
          .min(0)
          .describe("(acquire) max seconds to wait for a browser.")
          .optional(),
        session_id: z
          .string()
          .describe(
            "(release) session id of the browser to release. must be the id, not the session name.",
          )
          .optional(),
        reuse: z
          .boolean()
          .describe(
            "(release) reuse browser instance or recreate. default true.",
          )
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL browser pools",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "create": {
            const createParams = buildPoolCreateParams(params);
            if (!createParams.ok) return errorResponse(createParams.error);

            const pool = await client.browserPools.create(createParams.value);
            if (!pool) return errorResponse("failed to create browser pool");
            return jsonResponse({
              browser_pool: summarizeBrowserPool(pool),
              next_actions: poolNextActions(pool),
            });
          }
          case "update": {
            if (!params.id_or_name) {
              return errorResponse("error: id_or_name is required for update.");
            }

            const updateParams = buildPoolUpdateParams(params);
            if (!updateParams.ok) return errorResponse(updateParams.error);
            if (Object.keys(updateParams.value).length === 0) {
              return errorResponse(
                "error: at least one update field is required.",
              );
            }

            const pool = await client.browserPools.update(
              params.id_or_name,
              updateParams.value,
            );
            if (!pool) return errorResponse("failed to update browser pool");
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
            const page = await client.browserPools.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              mapItem: summarizeBrowserPool,
              note: 'use action "get" with id_or_name for full pool details.',
              emptyText: "no browser pools found",
            });
          }
          case "get": {
            if (!params.id_or_name)
              return errorResponse("error: id_or_name is required for get.");
            const pool = await client.browserPools.retrieve(params.id_or_name);
            if (!pool)
              return errorResponse(
                `browser pool "${params.id_or_name}" not found`,
              );
            return jsonResponse(pool);
          }
          case "delete": {
            if (!params.id_or_name)
              return errorResponse("error: id_or_name is required for delete.");
            await client.browserPools.delete(params.id_or_name, {
              ...(params.force !== undefined && { force: params.force }),
            });
            return textResponse("browser pool deleted successfully");
          }
          case "flush": {
            if (!params.id_or_name)
              return errorResponse("error: id_or_name is required for flush.");
            await client.browserPools.flush(params.id_or_name);
            return textResponse(
              "pool flushed successfully. all idle browsers destroyed.",
            );
          }
          case "acquire": {
            if (!params.id_or_name)
              return errorResponse(
                "error: id_or_name is required for acquire.",
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
              return errorResponse("failed to acquire browser from pool");
            // Prefer the stable pool id for the release hint (acquire may have
            // been called by name); fall back to the caller's identifier.
            const poolId = browser.pool?.id ?? params.id_or_name;
            return jsonResponse({
              browser: summarizeAcquiredBrowser(browser),
              next_actions: [
                `use computer_action with session_id "${browser.session_id}" to control this browser.`,
                `when finished, use manage_browser_pools with action "release", id_or_name "${poolId}", and session_id "${browser.session_id}".`,
                `use manage_browsers with action "get" and session_id "${browser.session_id}" for full browser details.`,
              ],
            });
          }
          case "release": {
            if (!params.id_or_name)
              return errorResponse(
                "error: id_or_name is required for release.",
              );
            if (!params.session_id)
              return errorResponse(
                "error: session_id is required for release.",
              );
            await client.browserPools.release(params.id_or_name, {
              session_id: params.session_id,
              ...(params.reuse !== undefined && { reuse: params.reuse }),
            });
            return textResponse("browser released back to pool successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_browser_pools", params.action, error);
      }
    },
  );
}
