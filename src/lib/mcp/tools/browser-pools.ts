import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  browserExtensionsSchema,
  buildBrowserCreateConfig,
  buildBrowserSharedConfig,
  type BrowserConfigResult,
  type BrowserCreateConfigParams,
} from "@/lib/mcp/browser-config";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  allowedHostsDescription,
  allowedHostsSchema,
  privateHostsSchema,
  proxyRoutesError,
  proxyRoutesSchema,
} from "@/lib/mcp/network-config";
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
import { browserTelemetrySchema } from "@/lib/mcp/tools/managed-auth-telemetry";

type BrowserPoolCreateParams = Parameters<
  KernelClient["browserPools"]["create"]
>[0];
type BrowserPoolUpdateParams = Parameters<
  KernelClient["browserPools"]["update"]
>[1];
type BrowserPool = Awaited<
  ReturnType<KernelClient["browserPools"]["retrieve"]>
>;
type BrowserPoolAcquireResponse = NonNullable<
  Awaited<ReturnType<KernelClient["browserPools"]["acquire"]>>
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
  memory?: BrowserPoolCreateParams["memory"];
  region?: BrowserPoolCreateParams["region"];
  refresh_on_profile_update?: boolean;
  telemetry?:
    | BrowserPoolCreateParams["telemetry"]
    | BrowserPoolUpdateParams["telemetry"];
  network?: BrowserPoolCreateParams["network"];
  expected_network?: BrowserPoolUpdateParams["expected_network"];
  save_profile_changes?: boolean;
  tags?: Record<string, string>;
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
  if (params.expected_network !== undefined) {
    return {
      ok: false,
      error: "error: expected_network is update-only.",
    };
  }
  if (params.save_profile_changes !== undefined) {
    return {
      ok: false,
      error: "error: save_profile_changes is acquire-only.",
    };
  }
  if (params.tags !== undefined) {
    return { ok: false, error: "error: tags is acquire-only." };
  }
  if (params.start_url === "") {
    return {
      ok: false,
      error: "error: an empty start_url is update-only.",
    };
  }

  const networkError = proxyRoutesError(params.network?.proxy_routes);
  if (networkError) return { ok: false, error: `error: ${networkError}` };

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
      ...(params.memory !== undefined && { memory: params.memory }),
      ...(params.region !== undefined && { region: params.region }),
      ...(params.refresh_on_profile_update !== undefined && {
        refresh_on_profile_update: params.refresh_on_profile_update,
      }),
      ...(params.telemetry !== undefined && { telemetry: params.telemetry }),
      ...(params.network !== undefined && { network: params.network }),
      ...browserConfig.value,
    },
  };
}

function buildPoolUpdateParams(
  params: PoolConfigParams & { discard_all_idle?: boolean },
): BrowserConfigResult<BrowserPoolUpdateParams> {
  if (params.save_profile_changes !== undefined) {
    return {
      ok: false,
      error: "error: save_profile_changes is acquire-only.",
    };
  }
  if (params.tags !== undefined) {
    return { ok: false, error: "error: tags is acquire-only." };
  }
  if (params.region !== undefined) {
    return {
      ok: false,
      error: "error: region is fixed at create; on list it filters pools.",
    };
  }
  if (params.clear_profile && (params.profile_id || params.profile_name)) {
    return {
      ok: false,
      error:
        "error: clear_profile cannot be combined with profile_id or profile_name.",
    };
  }
  if (
    params.clear_extensions &&
    (params.extensions !== undefined ||
      params.extension_id ||
      params.extension_name)
  ) {
    return {
      ok: false,
      error:
        "error: clear_extensions cannot be combined with extensions, extension_id, or extension_name.",
    };
  }

  const networkError =
    proxyRoutesError(params.network?.proxy_routes) ??
    proxyRoutesError(params.expected_network?.proxy_routes);
  if (networkError) return { ok: false, error: `error: ${networkError}` };

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
      ...(params.memory !== undefined && { memory: params.memory }),
      ...(params.refresh_on_profile_update !== undefined && {
        refresh_on_profile_update: params.refresh_on_profile_update,
      }),
      ...(params.telemetry !== undefined && { telemetry: params.telemetry }),
      ...(params.start_url !== undefined && { start_url: params.start_url }),
      ...(params.network !== undefined && { network: params.network }),
      ...(params.expected_network !== undefined && {
        expected_network: params.expected_network,
      }),
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
    region: pool.region,
    counts: {
      size: config.size,
      available: pool.available_count,
      acquired: pool.acquired_count,
    },
    config: {
      headless: config.headless,
      stealth: config.stealth,
      kiosk_mode: config.kiosk_mode,
      memory: config.memory,
      timeout_seconds: config.timeout_seconds,
      fill_rate_per_minute: config.fill_rate_per_minute,
      refresh_on_profile_update: config.refresh_on_profile_update,
      start_url: config.start_url,
      profile_id: pool.profile_id,
      proxy_id: config.proxy_id,
      network: config.network,
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
    memory: browser.memory,
    location: browser.location,
    pool: browser.pool,
    profile: browser.profile,
    proxy_id: browser.proxy_id,
    network: browser.network,
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
          .describe(
            "(create, update) unique pool name. (list) exact-match name filter. (acquire) lease-only browser session name, unique among active sessions in the project.",
          )
          .optional(),
        query: z
          .string()
          .describe(
            "(list) case-insensitive substring match against pool name; ids match exactly.",
          )
          .optional(),
        tags: z
          .record(z.string(), z.string())
          .refine((value) => Object.keys(value).length <= 50)
          .describe(
            "(acquire) lease-only key-value tags for finding and grouping the acquired browser; up to 50 pairs and cleared on release.",
          )
          .optional(),
        region: z
          .enum(["us-east", "us-west", "eu-west", "ap-southeast"])
          .describe(
            "(create) fixed pool region; selection requires start-up or enterprise and defaults to us-east. (list) filter by region.",
          )
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
            "(create, update) profile name for pool browsers. (acquire) lease-only profile override. cannot use with profile_id.",
          )
          .optional(),
        profile_id: z
          .string()
          .describe(
            "(create, update) profile id for pool browsers. (acquire) lease-only profile override. cannot use with profile_name.",
          )
          .optional(),
        save_profile_changes: z
          .boolean()
          .describe(
            "(acquire) save lease changes back to the acquire-time profile when the session ends. requires profile_id or profile_name and is not a pool default.",
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
            "(create, update) url to open when a browser is warmed into the pool; on update, an empty string clears it. (acquire) lease-only navigation override; empty is invalid. navigation is best-effort.",
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
        memory: z
          .enum(["1GiB", "2GiB", "4GiB", "8GiB", "16GiB"])
          .describe(
            "(create, update) memory for newly warmed non-gpu browsers. headless supports 1 gib (default), 2 gib, or 4 gib; headful supports 8 gib (default) or 16 gib. existing browsers keep their allocation until replaced; use discard_all_idle to replace idle browsers.",
          )
          .optional(),
        refresh_on_profile_update: z
          .boolean()
          .describe(
            "(create, update) flush idle browsers when the attached profile changes so newly acquired browsers use the latest profile. requires a profile; defaults to true when a profile is first attached.",
          )
          .optional(),
        network: z
          .object({
            private_hosts: privateHostsSchema().optional(),
            proxy_routes: proxyRoutesSchema().optional(),
            allowed_hosts: allowedHostsSchema()
              .describe(
                allowedHostsDescription(
                  "pool browsers",
                  "changing it replaces idle browsers. a leased browser keeps its allowlist until release, when it is reset to the pool's or the browser is replaced; manage_browsers update can replace or remove it during the lease.",
                ),
              )
              .optional(),
          })
          .describe(
            "(create, update) network settings for pool browsers. on update, replaces the pool's whole network config: include every field to keep, or pass {} to remove it. private_hosts and proxy_routes changes only reach browsers created afterward (see discard_all_idle).",
          )
          .optional(),
        expected_network: z
          .object({
            private_hosts: privateHostsSchema().optional(),
            proxy_routes: proxyRoutesSchema().optional(),
            allowed_hosts: allowedHostsSchema().optional(),
          })
          .strict()
          .describe(
            "(update) optimistic concurrency precondition. send the exact network config from the last pool response, or {} if it had none. the whole update fails atomically with stale_network if the saved config differs. explicit empty lists differ from omitted lists, and proxy routes must use the resolved references from the response.",
          )
          .optional(),
        extensions: browserExtensionsSchema
          .describe(
            "(create, update) complete extension selection, each by exactly one id or name. on update, the array replaces the existing list and [] clears it. cannot be combined with extension_id, extension_name, or clear_extensions.",
          )
          .optional(),
        extension_id: z
          .string()
          .describe(
            "deprecated: use extensions. (create, update) one extension id to load.",
          )
          .optional(),
        extension_name: z
          .string()
          .describe(
            "deprecated: use extensions. (create, update) one extension name to load.",
          )
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
          .describe(
            "(create, update) display refresh rate in hz. when omitted, gpu browsers default to 60 and other browsers derive it from the dimensions.",
          )
          .optional(),
        telemetry: browserTelemetrySchema
          .nullable()
          .describe(
            "(create, update, acquire) full browser telemetry configuration, including all categories, control cdp exclusions, existing otlp destination export, and storage. create applies it to newly warmed browsers; update changes the pool baseline for future browsers; acquire is a lease-only override reset on release. enabled=false preserves false and stops capture. null or {} means no telemetry on create, no baseline change on update, and no override on acquire.",
          )
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
              ...(params.name !== undefined && { name: params.name }),
              ...(params.query !== undefined && { query: params.query }),
              ...(params.region !== undefined && { region: params.region }),
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
            if (params.profile_id && params.profile_name) {
              return errorResponse(
                "error: cannot specify both profile_name and profile_id.",
              );
            }
            if (
              params.save_profile_changes !== undefined &&
              !params.profile_id &&
              !params.profile_name
            ) {
              return errorResponse(
                "error: profile_name or profile_id is required when save_profile_changes is set.",
              );
            }
            if (params.start_url === "") {
              return errorResponse(
                "error: an empty start_url is not valid for acquire.",
              );
            }
            const browser = await client.browserPools.acquire(
              params.id_or_name,
              {
                ...(params.acquire_timeout_seconds !== undefined && {
                  acquire_timeout_seconds: params.acquire_timeout_seconds,
                }),
                ...(params.name !== undefined && { name: params.name }),
                ...((params.profile_id || params.profile_name) && {
                  profile: {
                    ...(params.profile_id && { id: params.profile_id }),
                    ...(params.profile_name && { name: params.profile_name }),
                    ...(params.save_profile_changes !== undefined && {
                      save_changes: params.save_profile_changes,
                    }),
                  },
                }),
                ...(params.start_url !== undefined && {
                  start_url: params.start_url,
                }),
                ...(params.tags !== undefined && { tags: params.tags }),
                ...(params.telemetry !== undefined && {
                  telemetry: params.telemetry,
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
