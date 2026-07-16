import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NotFoundError } from "@onkernel/sdk";
import { z } from "zod";
import {
  buildBrowserCreateConfig,
  buildBrowserUpdateConfig,
  type BrowserConfigResult,
} from "@/lib/mcp/browser-config";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  TELEMETRY_EVENT_CATALOG,
  telemetryEventCategories,
} from "@/lib/mcp/telemetry";

type BrowserCreateParams = NonNullable<
  Parameters<KernelClient["browsers"]["create"]>[0]
>;
type BrowserUpdateParams = Parameters<KernelClient["browsers"]["update"]>[1];
type TelemetryEventsQuery = NonNullable<
  Parameters<KernelClient["browsers"]["telemetry"]["events"]>[1]
>;

type TelemetryParams = {
  telemetry_enabled?: boolean;
  telemetry_console?: boolean;
  telemetry_network?: boolean;
  telemetry_page?: boolean;
  telemetry_interaction?: boolean;
};

const telemetryCategories = [
  ["telemetry_console", "console"],
  ["telemetry_network", "network"],
  ["telemetry_page", "page"],
  ["telemetry_interaction", "interaction"],
] as const;

function buildTelemetry(
  params: TelemetryParams,
): BrowserConfigResult<
  BrowserCreateParams["telemetry"] | BrowserUpdateParams["telemetry"]
> {
  const browser: NonNullable<
    NonNullable<BrowserCreateParams["telemetry"]>["browser"]
  > = {};
  let hasBrowserCategories = false;
  let hasEnabledBrowserCategories = false;

  for (const [paramKey, category] of telemetryCategories) {
    const enabled = params[paramKey];
    if (enabled !== undefined) {
      browser[category] = { enabled };
      hasBrowserCategories = true;
      if (enabled) hasEnabledBrowserCategories = true;
    }
  }

  if (params.telemetry_enabled === false && hasEnabledBrowserCategories) {
    return {
      ok: false,
      error:
        "Error: telemetry_enabled=false cannot be combined with enabled telemetry categories.",
    };
  }

  if (params.telemetry_enabled === undefined && !hasBrowserCategories) {
    return { ok: true, value: undefined };
  }

  return {
    ok: true,
    value: {
      ...(params.telemetry_enabled !== undefined && {
        enabled: params.telemetry_enabled,
      }),
      ...(hasBrowserCategories && { browser }),
    },
  };
}

type TelemetryEnvelope = Awaited<
  ReturnType<KernelClient["browsers"]["telemetry"]["events"]>
>["items"][number];

// Payload fields that are always omitted, even when small. The size limit
// catches new high-volume fields that are added to telemetry later.
const omittedTelemetryDataFields: ReadonlySet<string> = new Set([
  "body",
  "headers",
  "post_data",
  "png",
]);
const maxTelemetryDataFieldBytes = 8 * 1024;

async function summarizeEmptyTelemetryResult(
  client: KernelClient,
  {
    sessionId,
    hasMore,
    fullSessionRead,
    soleSince,
  }: {
    sessionId: string;
    hasMore: boolean;
    fullSessionRead: boolean;
    soleSince?: string;
  },
) {
  if (hasMore) {
    return "No matching events on this page; continue with next_offset.";
  }

  const browser = await client.browsers
    .retrieve(sessionId)
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
  const telemetryDisabled =
    browser !== null &&
    !Object.values(browser.telemetry?.browser ?? {}).some(
      (category) => category?.enabled,
    );

  // An explicit since at or before the session's creation also covers the
  // whole archive. Duration-style values ("10m") fail Date.parse and stay on
  // the windowed wording, as do deleted sessions (null browser).
  const coversFullSession =
    fullSessionRead ||
    (soleSince !== undefined &&
      browser !== null &&
      Date.parse(soleSince) <= Date.parse(browser.created_at));

  if (coversFullSession) {
    return telemetryDisabled
      ? "No telemetry events are archived for this session. Telemetry is currently disabled."
      : "No telemetry events are archived for this session.";
  }
  return telemetryDisabled
    ? "No events matched this query. Broaden the categories or time window before changing capture settings; capture is currently disabled, so no new events are being archived."
    : "No events matched this query.";
}

function compactTelemetryEvent({ seq, event }: TelemetryEnvelope) {
  const { ts, category, type, source, truncated } = event;
  const data = "data" in event ? event.data : undefined;

  let compactData: Record<string, unknown> | undefined;
  let omittedFields: string[] | undefined;
  if (data) {
    compactData = { ...(data as Record<string, unknown>) };
    for (const [field, value] of Object.entries(compactData)) {
      const alwaysOmit = omittedTelemetryDataFields.has(field);
      const serialized = alwaysOmit ? undefined : JSON.stringify(value);
      const oversized =
        serialized !== undefined &&
        Buffer.byteLength(serialized, "utf8") > maxTelemetryDataFieldBytes;
      if (alwaysOmit || oversized) {
        delete compactData[field];
        (omittedFields ??= []).push(field);
      }
    }
  }

  return {
    seq,
    // Raw ts (Unix microseconds) is kept alongside the readable time so exact
    // event boundaries can be fed back as since/until.
    ts,
    time: new Date(ts / 1000).toISOString(),
    category,
    type,
    source,
    ...(compactData && { data: compactData }),
    ...(truncated && { truncated }),
    ...(omittedFields && { omitted_fields: omittedFields }),
  };
}

type BrowserTelemetryReadParams = {
  session_id: string;
  categories?: TelemetryEventsQuery["category"];
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  order?: "asc" | "desc";
};

async function readBrowserTelemetry(
  client: KernelClient,
  params: BrowserTelemetryReadParams,
) {
  const query: TelemetryEventsQuery = { limit: params.limit ?? 100 };
  if (params.categories) query.category = params.categories;
  if (params.offset !== undefined) query.offset = params.offset;
  if (params.since !== undefined) query.since = params.since;
  if (params.until !== undefined) query.until = params.until;
  if (params.order !== undefined) query.order = params.order;

  // Avoid the API's five-minute default. The archive can't predate the
  // session, so the epoch reads the full session without a browser lookup;
  // until-only reads already start at the stream head and desc reads anchor
  // at the stream tail.
  if (
    query.offset === undefined &&
    query.since === undefined &&
    query.until === undefined &&
    query.order !== "desc"
  ) {
    query.since = "1970-01-01T00:00:00Z";
  }
  const unfilteredExceptSince =
    params.offset === undefined &&
    params.until === undefined &&
    params.categories === undefined;
  const fullSessionRead = unfilteredExceptSince && params.since === undefined;

  const page = await client.browsers.telemetry.events(params.session_id, query);
  const items = page.getPaginatedItems().map(compactTelemetryEvent);

  const note =
    items.length === 0
      ? await summarizeEmptyTelemetryResult(client, {
          sessionId: params.session_id,
          hasMore: Boolean(page.has_more),
          fullSessionRead,
          soleSince: unfilteredExceptSince ? params.since : undefined,
        })
      : undefined;

  // Single-line JSON rather than the pretty-printed house helpers: a page
  // carries up to 100 events and indentation would inflate the token cost.
  return textResponse(
    JSON.stringify({
      items,
      has_more: page.has_more,
      next_offset: page.next_offset,
      ...(note && { note }),
    }),
  );
}

function browserSessionNextActions(sessionId: string) {
  return [
    `Use computer_action with session_id "${sessionId}" to inspect or control the browser.`,
    `Use manage_browsers with action "get" and session_id "${sessionId}" for full browser details.`,
    `Use manage_browsers with action "delete" and session_id "${sessionId}" when the session is no longer needed.`,
  ];
}

function buildSshPortForwardingInfo(
  params: { local_forward?: string; remote_forward?: string },
  sessionId: string,
) {
  if (!params.local_forward && !params.remote_forward) return undefined;

  const sshParts = ["kernel browsers ssh", sessionId];
  if (params.local_forward) sshParts.push(`-L ${params.local_forward}`);
  if (params.remote_forward) sshParts.push(`-R ${params.remote_forward}`);

  const remotePort = params.remote_forward
    ? params.remote_forward.split(":")[0]
    : undefined;
  const localPort = params.local_forward
    ? params.local_forward.split(":")[0]
    : undefined;

  return {
    command: sshParts.join(" "),
    prerequisites: [
      "Kernel CLI: https://kernel.sh/docs/reference/cli",
      "websocat: brew install websocat on macOS",
    ],
    remote_forward: remotePort
      ? {
          browser_vm_url: `http://localhost:${remotePort}`,
          next_action: `Once the user has the tunnel running, use execute_playwright_code to navigate the browser to http://localhost:${remotePort}.`,
        }
      : undefined,
    local_forward: localPort
      ? {
          local_url: `http://localhost:${localPort}`,
          note: `Services inside the browser VM are accessible locally at localhost:${localPort} once the tunnel is running.`,
        }
      : undefined,
    note: "SSH connections alone do not count as browser activity. Set an appropriate timeout or keep the live view open to prevent cleanup.",
  };
}

export function registerBrowserCapabilities(server: McpServer) {
  server.resource("browsers", "browsers://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const browsersPage = await client.browsers.list();
    const items = browsersPage.getPaginatedItems();
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text:
            items.length > 0
              ? JSON.stringify(items, null, 2)
              : "No browsers found",
        },
      ],
    };
  });

  registerJsonResourceTemplate(server, {
    name: "browser",
    uriTemplate: "browsers://{sessionId}",
    variableName: "sessionId",
    resourceLabel: "Browser session",
    read: (client, sessionId) => client.browsers.retrieve(sessionId),
  });

  // manage_browsers -- Manage browser sessions and read archived telemetry
  server.tool(
    "manage_browsers",
    'Manage browser sessions and their archived telemetry. Use "list" to choose an existing session, "create" before browser control, "update" to change supported session settings, "get" for full details, "get_telemetry" to diagnose active or deleted sessions, and "delete" when finished.',
    {
      action: z
        .enum(["create", "update", "list", "get", "get_telemetry", "delete"])
        .describe("Operation to perform."),
      session_id: z
        .string()
        .describe(
          "Browser session ID. Required for update, get, get_telemetry, and delete actions.",
        )
        .optional(),
      start_url: z
        .string()
        .url()
        .describe(
          "(create) URL to open when the browser is created. Navigation is best-effort.",
        )
        .optional(),
      chrome_policy: z
        .record(z.string(), z.unknown())
        .describe(
          "(create) Chrome enterprise policy overrides. Kernel-managed policies such as extensions, proxy, CDP, and automation are blocked by the API.",
        )
        .optional(),
      headless: z
        .boolean()
        .describe("(create) Launch without GUI. Faster but no live view.")
        .optional(),
      gpu: z
        .boolean()
        .describe(
          "(create) Enable GPU acceleration. Requires Start-Up or Enterprise plan and headless=false.",
        )
        .optional(),
      stealth: z
        .boolean()
        .describe("(create) Avoid bot detection. Recommended for scraping.")
        .optional(),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(259200)
        .describe(
          "(create) Inactivity timeout in seconds (max 259200 = 72h). Default 60.",
        )
        .optional(),
      profile_name: z
        .string()
        .describe(
          "(create, update) Profile name to load saved cookies/logins. Cannot use with profile_id.",
        )
        .optional(),
      profile_id: z
        .string()
        .describe(
          "(create, update) Profile ID to load. Cannot use with profile_name.",
        )
        .optional(),
      save_profile_changes: z
        .boolean()
        .describe(
          "(create, update) Save session changes back to profile on close.",
        )
        .optional(),
      proxy_id: z
        .string()
        .describe(
          "(create, update) Proxy ID for traffic routing. For update, omit to leave unchanged.",
        )
        .optional(),
      clear_proxy: z
        .boolean()
        .describe("(update) Remove the current proxy from the browser session.")
        .optional(),
      disable_default_proxy: z
        .boolean()
        .describe(
          "(update) For stealth browsers, connect directly instead of using the default stealth proxy.",
        )
        .optional(),
      kiosk_mode: z
        .boolean()
        .describe("(create) Hide address bar/tabs in live view.")
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
      viewport_force: z
        .boolean()
        .describe(
          "(update) Force viewport changes even when live view or recording is active.",
        )
        .optional(),
      extension_id: z
        .string()
        .describe("(create) Extension ID to load.")
        .optional(),
      extension_name: z
        .string()
        .describe("(create) Extension name to load.")
        .optional(),
      local_forward: z
        .string()
        .describe("(create) SSH local forwarding (localport:host:remoteport).")
        .optional(),
      remote_forward: z
        .string()
        .describe(
          "(create) SSH remote forwarding (remoteport:host:localport). Use to expose local dev server to browser.",
        )
        .optional(),
      status: z
        .enum(["active", "deleted", "all"])
        .describe('(list) Filter by status. Default "active".')
        .optional(),
      limit: paginationParams.limit.describe(
        "(list, get_telemetry) Max results per page (1-100). get_telemetry defaults to 100; the list default is set by the API.",
      ),
      offset: paginationParams.offset.describe(
        "(list) Numeric pagination offset. (get_telemetry) Opaque cursor: pass next_offset from the previous response and preserve categories, until, and order. Do not derive it from event seq values.",
      ),
      categories: z
        .array(z.enum(telemetryEventCategories))
        .min(1)
        .describe(
          `(get_telemetry) Restrict results to these event categories. A filtered page can be empty while has_more is true. ${TELEMETRY_EVENT_CATALOG}`,
        )
        .optional(),
      since: z
        .string()
        .describe(
          "(get_telemetry) Start of the window: an RFC-3339 timestamp or a duration like '30m' meaning that long ago. Defaults to session creation. Ignored when offset is set; cannot be combined with order=desc.",
        )
        .optional(),
      until: z
        .string()
        .describe(
          "(get_telemetry) End of the window (exclusive): an RFC-3339 timestamp or a duration like '5m'. Preserve it while paging.",
        )
        .optional(),
      order: z
        .enum(["asc", "desc"])
        .describe(
          "(get_telemetry) Read direction. asc (default) reads oldest first; desc reads newest first. Preserve it while paging.",
        )
        .optional(),
      telemetry_enabled: z
        .boolean()
        .describe(
          "(create, update) Enable telemetry, or disable telemetry when false. Telemetry is off unless requested. The default category set is the lightweight operational bundle (control, connection, system, captcha) and does NOT include console, network, or page — enable those explicitly when you intend to debug page behavior.",
        )
        .optional(),
      telemetry_console: z
        .boolean()
        .describe(
          "(create, update) Enable or disable console telemetry (console output and uncaught exceptions). Off by default; enable for debugging.",
        )
        .optional(),
      telemetry_network: z
        .boolean()
        .describe(
          "(create, update) Enable or disable network telemetry (request/response metadata). Off by default; enable for debugging.",
        )
        .optional(),
      telemetry_page: z
        .boolean()
        .describe(
          "(create, update) Enable or disable page lifecycle telemetry (navigation, load, layout shifts, LCP). Off by default; enable for debugging.",
        )
        .optional(),
      telemetry_interaction: z
        .boolean()
        .describe(
          "(create, update) Enable or disable user interaction telemetry (clicks, keys, scrolls). Off by default; enable for debugging.",
        )
        .optional(),
    },
    {
      title: "Manage Kernel browser sessions",
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
            const createParams: BrowserCreateParams = {};
            if (params.headless !== undefined)
              createParams.headless = params.headless;
            if (params.gpu !== undefined) createParams.gpu = params.gpu;
            if (params.stealth !== undefined)
              createParams.stealth = params.stealth;
            if (params.timeout_seconds !== undefined)
              createParams.timeout_seconds = params.timeout_seconds;
            if (params.kiosk_mode !== undefined)
              createParams.kiosk_mode = params.kiosk_mode;
            if (
              params.chrome_policy &&
              Object.keys(params.chrome_policy).length > 0
            ) {
              createParams.chrome_policy = params.chrome_policy;
            }
            if (params.proxy_id) createParams.proxy_id = params.proxy_id;
            const browserConfig = buildBrowserCreateConfig(params);
            if (!browserConfig.ok) return errorResponse(browserConfig.error);
            Object.assign(createParams, browserConfig.value);
            const telemetry = buildTelemetry(params);
            if (!telemetry.ok) return errorResponse(telemetry.error);
            if (telemetry.value !== undefined)
              createParams.telemetry = telemetry.value;

            const browser = await client.browsers.create(createParams);
            if (!browser)
              return errorResponse("Failed to create browser session");

            const sshPortForwarding = buildSshPortForwardingInfo(
              params,
              browser.session_id,
            );
            return jsonResponse({
              browser,
              next_actions: browserSessionNextActions(browser.session_id),
              ...(sshPortForwarding && {
                ssh_port_forwarding: sshPortForwarding,
              }),
            });
          }
          case "update": {
            if (!params.session_id)
              return errorResponse(
                "Error: session_id is required for update action.",
              );
            if (params.proxy_id && params.clear_proxy) {
              return errorResponse(
                "Error: Cannot specify both proxy_id and clear_proxy.",
              );
            }

            const updateParams: BrowserUpdateParams = {};
            if (params.disable_default_proxy !== undefined) {
              updateParams.disable_default_proxy = params.disable_default_proxy;
            }
            if (params.clear_proxy) {
              updateParams.proxy_id = "";
            } else if (params.proxy_id !== undefined) {
              updateParams.proxy_id = params.proxy_id;
            }
            const browserConfig = buildBrowserUpdateConfig(params);
            if (!browserConfig.ok) return errorResponse(browserConfig.error);
            Object.assign(updateParams, browserConfig.value);
            const telemetry = buildTelemetry(params);
            if (!telemetry.ok) return errorResponse(telemetry.error);
            if (telemetry.value !== undefined)
              updateParams.telemetry = telemetry.value;

            if (Object.keys(updateParams).length === 0) {
              return errorResponse(
                "Error: at least one update field is required.",
              );
            }

            const browser = await client.browsers.update(
              params.session_id,
              updateParams,
            );
            if (!browser)
              return errorResponse("Failed to update browser session");
            return jsonResponse({
              browser,
              next_actions: browserSessionNextActions(browser.session_id),
            });
          }
          case "list": {
            const page = await client.browsers.list({
              ...(params.status && { status: params.status }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              mapItem: ({ cdp_ws_url: _cdpWsUrl, ...browser }) => browser,
              note: 'Use action "get" with session_id for full browser details.',
            });
          }
          case "get": {
            if (!params.session_id)
              return errorResponse(
                "Error: session_id is required for get action.",
              );
            const browser = await client.browsers.retrieve(params.session_id);
            if (!browser)
              return errorResponse(
                `Browser session "${params.session_id}" not found`,
              );
            return jsonResponse(browser);
          }
          case "get_telemetry": {
            if (!params.session_id)
              return errorResponse(
                "Error: session_id is required for get_telemetry action.",
              );
            if (params.since !== undefined && params.order === "desc") {
              return errorResponse(
                "Error: since cannot be combined with order=desc. Use until to bound a newest-first read, or order=asc with since.",
              );
            }
            return await readBrowserTelemetry(client, {
              session_id: params.session_id,
              categories: params.categories,
              limit: params.limit,
              offset: params.offset,
              since: params.since,
              until: params.until,
              order: params.order,
            });
          }
          case "delete": {
            if (!params.session_id)
              return errorResponse(
                "Error: session_id is required for delete action.",
              );
            await client.browsers.deleteByID(params.session_id);
            return textResponse("Browser session deleted successfully");
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_browsers", params.action, error);
      }
    },
  );
}
