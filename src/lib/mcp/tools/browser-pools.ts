import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildBrowserExtensions,
  buildBrowserProfile,
  buildBrowserStartUrl,
  buildBrowserViewport,
  type BrowserExtensionParams,
  type BrowserProfileParams,
  type BrowserViewportParams,
} from "@/lib/mcp/browser-config";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import { errorMessage, jsonResponse, textResponse } from "@/lib/mcp/responses";

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

type PoolConfigParams = BrowserProfileParams &
  BrowserExtensionParams &
  BrowserViewportParams & {
    size?: number;
    name?: string;
    headless?: boolean;
    stealth?: boolean;
    timeout_seconds?: number;
    proxy_id?: string;
    fill_rate_per_minute?: number;
    start_url?: string;
    chrome_policy?: Record<string, unknown>;
    kiosk_mode?: boolean;
  };

const updateActions: readonly BrowserPoolAction[] = ["update"];
const createUpdateActions: readonly BrowserPoolAction[] = ["create", "update"];
const idOrNameActions: readonly BrowserPoolAction[] = [
  "update",
  "get",
  "delete",
  "flush",
  "acquire",
  "release",
];
const deleteActions: readonly BrowserPoolAction[] = ["delete"];
const acquireActions: readonly BrowserPoolAction[] = ["acquire"];
const releaseActions: readonly BrowserPoolAction[] = ["release"];

const browserPoolFieldScopes = {
  id_or_name: idOrNameActions,
  size: createUpdateActions,
  name: createUpdateActions,
  headless: createUpdateActions,
  stealth: createUpdateActions,
  timeout_seconds: createUpdateActions,
  profile_name: createUpdateActions,
  profile_id: createUpdateActions,
  save_profile_changes: createUpdateActions,
  proxy_id: createUpdateActions,
  fill_rate_per_minute: createUpdateActions,
  start_url: createUpdateActions,
  chrome_policy: createUpdateActions,
  kiosk_mode: createUpdateActions,
  extension_id: createUpdateActions,
  extension_name: createUpdateActions,
  viewport_width: createUpdateActions,
  viewport_height: createUpdateActions,
  viewport_refresh_rate: createUpdateActions,
  discard_all_idle: updateActions,
  force: deleteActions,
  acquire_timeout_seconds: acquireActions,
  session_id: releaseActions,
  reuse: releaseActions,
} satisfies Record<string, readonly BrowserPoolAction[]>;

type BrowserPoolToolField = keyof typeof browserPoolFieldScopes;

const scopedBrowserPoolFields = Object.keys(
  browserPoolFieldScopes,
) as BrowserPoolToolField[];

function formatActionScope(field: BrowserPoolToolField) {
  return browserPoolFieldScopes[field].join(", ");
}

function actionFieldError(
  params: Partial<Record<BrowserPoolToolField, unknown>>,
  action: BrowserPoolAction,
) {
  const unsupportedField = scopedBrowserPoolFields.find(
    (field) =>
      params[field] !== undefined &&
      !browserPoolFieldScopes[field].includes(action),
  );

  return unsupportedField
    ? `Error: ${unsupportedField} is only supported for ${formatActionScope(
        unsupportedField,
      )}.`
    : undefined;
}

function buildPoolConfigParams(
  params: PoolConfigParams,
): BrowserPoolCreateParams {
  if (params.size === undefined) {
    throw new Error("size is required for create and update.");
  }

  const profile = buildBrowserProfile(params);
  const extensions = buildBrowserExtensions(params);
  const viewport = buildBrowserViewport(params);
  const startUrl = buildBrowserStartUrl(params.start_url);

  return {
    size: params.size,
    ...(params.name && { name: params.name }),
    ...(params.headless !== undefined && { headless: params.headless }),
    ...(params.stealth !== undefined && { stealth: params.stealth }),
    ...(params.timeout_seconds !== undefined && {
      timeout_seconds: params.timeout_seconds,
    }),
    ...(profile && { profile }),
    ...(params.proxy_id !== undefined && { proxy_id: params.proxy_id }),
    ...(params.fill_rate_per_minute !== undefined && {
      fill_rate_per_minute: params.fill_rate_per_minute,
    }),
    ...(startUrl !== undefined && { start_url: startUrl }),
    ...(params.chrome_policy !== undefined && {
      chrome_policy: params.chrome_policy,
    }),
    ...(params.kiosk_mode !== undefined && { kiosk_mode: params.kiosk_mode }),
    ...(extensions && { extensions }),
    ...(viewport && { viewport }),
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
            const scopeError = actionFieldError(params, "create");
            if (scopeError) return textResponse(scopeError);

            const pool = await client.browserPools.create(
              buildPoolConfigParams(params),
            );
            if (!pool) return textResponse("Failed to create browser pool");
            return jsonResponse(pool);
          }
          case "update": {
            const scopeError = actionFieldError(params, "update");
            if (scopeError) return textResponse(scopeError);
            if (!params.id_or_name) {
              return textResponse("Error: id_or_name is required for update.");
            }

            const updateParams: BrowserPoolUpdateParams =
              buildPoolConfigParams(params);
            if (params.discard_all_idle !== undefined) {
              updateParams.discard_all_idle = params.discard_all_idle;
            }

            const pool = await client.browserPools.update(
              params.id_or_name,
              updateParams,
            );
            return jsonResponse(pool);
          }
          case "list": {
            const scopeError = actionFieldError(params, "list");
            if (scopeError) return textResponse(scopeError);

            const pools = await client.browserPools.list();
            return textResponse(
              pools?.length > 0
                ? JSON.stringify(pools, null, 2)
                : "No browser pools found",
            );
          }
          case "get": {
            const scopeError = actionFieldError(params, "get");
            if (scopeError) return textResponse(scopeError);
            if (!params.id_or_name)
              return textResponse("Error: id_or_name is required for get.");
            const pool = await client.browserPools.retrieve(params.id_or_name);
            if (!pool)
              return textResponse(
                `Browser pool "${params.id_or_name}" not found`,
              );
            return jsonResponse(pool);
          }
          case "delete": {
            const scopeError = actionFieldError(params, "delete");
            if (scopeError) return textResponse(scopeError);
            if (!params.id_or_name)
              return textResponse("Error: id_or_name is required for delete.");
            await client.browserPools.delete(params.id_or_name, {
              ...(params.force !== undefined && { force: params.force }),
            });
            return textResponse("Browser pool deleted successfully");
          }
          case "flush": {
            const scopeError = actionFieldError(params, "flush");
            if (scopeError) return textResponse(scopeError);
            if (!params.id_or_name)
              return textResponse("Error: id_or_name is required for flush.");
            await client.browserPools.flush(params.id_or_name);
            return textResponse(
              "Pool flushed successfully. All idle browsers destroyed.",
            );
          }
          case "acquire": {
            const scopeError = actionFieldError(params, "acquire");
            if (scopeError) return textResponse(scopeError);
            if (!params.id_or_name)
              return textResponse("Error: id_or_name is required for acquire.");
            const browser = await client.browserPools.acquire(
              params.id_or_name,
              {
                ...(params.acquire_timeout_seconds !== undefined && {
                  acquire_timeout_seconds: params.acquire_timeout_seconds,
                }),
              },
            );
            if (!browser)
              return textResponse("Failed to acquire browser from pool");
            return jsonResponse(browser);
          }
          case "release": {
            const scopeError = actionFieldError(params, "release");
            if (scopeError) return textResponse(scopeError);
            if (!params.id_or_name)
              return textResponse("Error: id_or_name is required for release.");
            if (!params.session_id)
              return textResponse("Error: session_id is required for release.");
            await client.browserPools.release(params.id_or_name, {
              session_id: params.session_id,
              ...(params.reuse !== undefined && { reuse: params.reuse }),
            });
            return textResponse("Browser released back to pool successfully");
          }
        }
      } catch (error) {
        return textResponse(
          `Error in manage_browser_pools (${params.action}): ${errorMessage(
            error,
          )}`,
        );
      }
    },
  );
}
