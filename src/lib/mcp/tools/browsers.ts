import type { McpServer } from "@modelcontextprotocol/server";
import { NotFoundError, type Kernel } from "@onkernel/sdk";
import type { BrowserNetworkConfig } from "@onkernel/sdk/resources/browsers/browsers";
import { z } from "zod";
import {
  buildBrowserCreateConfig,
  buildBrowserUpdateConfig,
  type BrowserConfigResult,
} from "@/lib/mcp/browser-config";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  registerJsonResourceCollection,
  registerJsonResourceTemplate,
} from "@/lib/mcp/resource-templates";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import { browserVaultsSchema } from "@/lib/mcp/vault-schemas";
import { deprecatedParamConflict } from "@/lib/mcp/deprecated-params";
import {
  proxyConfigError,
  proxyConfigSchema,
  proxySelectorError,
  proxySelectorSchema,
} from "@/lib/mcp/proxy-config";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";
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
        "error: telemetry_enabled=false cannot be combined with enabled telemetry categories.",
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
    return "no matching events on this page; continue with next_offset.";
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
      ? "no telemetry events are archived for this session. telemetry is currently disabled."
      : "no telemetry events are archived for this session.";
  }
  return telemetryDisabled
    ? "no events matched this query. broaden the categories or time window before changing capture settings; capture is currently disabled, so no new events are being archived."
    : "no events matched this query.";
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
  project?: string;
  project_id?: string;
  categories?: TelemetryEventsQuery["category"];
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  order?: "asc" | "desc";
  compact?: boolean;
};

const maxRawTelemetryEvents = 5;
// Producers cap each archived record at 1,000,000 bytes. This leaves room for
// the page envelope while ensuring one response cannot carry multiple max-size records.
const maxRawTelemetryResponseBytes = 1024 * 1024;

function rawTelemetryPageError(items: TelemetryEnvelope[]) {
  for (const { event } of items) {
    const data = "data" in event ? event.data : undefined;
    if (data && typeof data === "object" && "png" in data) {
      return "raw screenshot pngs are not available in json telemetry responses.";
    }
  }
  return undefined;
}

async function readBrowserTelemetry(
  client: KernelClient,
  params: BrowserTelemetryReadParams,
) {
  if (params.compact === false) {
    if (params.limit === undefined || params.limit > maxRawTelemetryEvents) {
      return errorResponse(
        `error: compact=false requires an explicit limit between 1 and ${maxRawTelemetryEvents}.`,
      );
    }
    if (!params.categories) {
      return errorResponse(
        "error: compact=false requires at least one explicit category.",
      );
    }
    if (params.categories.includes("screenshot")) {
      return errorResponse(
        "error: compact=false does not support the screenshot category because pngs are not returned in json.",
      );
    }
  }

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
  const pageItems = page.getPaginatedItems();
  const items =
    params.compact === false ? pageItems : pageItems.map(compactTelemetryEvent);

  // Counter-steer the pagination reflex: an unfiltered ascending read starts
  // at session creation, so an agent chasing a recent failure should flip to
  // desc rather than page through the whole archive oldest-first. Applies to
  // offset-continuation pages too — that's the agent already deep in a page
  // walk. Category, since, and until filters signal a deliberate bracket.
  const ascPagingNote =
    page.has_more &&
    params.categories === undefined &&
    params.since === undefined &&
    params.until === undefined &&
    query.order !== "desc"
      ? 'reading oldest-first from session start. if the end of the session matters most, use order "desc" instead of paging.'
      : undefined;

  const note =
    items.length === 0
      ? await summarizeEmptyTelemetryResult(client, {
          sessionId: params.session_id,
          hasMore: Boolean(page.has_more),
          fullSessionRead,
          soleSince: unfilteredExceptSince ? params.since : undefined,
        })
      : ascPagingNote;

  const rawReplayBestEffort =
    params.compact === false ||
    !query.category ||
    query.category.includes("screenshot")
      ? undefined
      : {
          action: "get_telemetry",
          session_id: params.session_id,
          ...(params.project && { project: params.project }),
          ...(params.project_id && { project_id: params.project_id }),
          ...(query.category && { categories: query.category }),
          limit: Math.min(query.limit ?? 100, maxRawTelemetryEvents),
          ...(query.offset !== undefined && { offset: query.offset }),
          ...(query.since && { since: query.since }),
          ...(query.until && { until: query.until }),
          ...(query.order && { order: query.order }),
          compact: false,
        };

  const response = {
    items,
    has_more: page.has_more,
    next_offset: page.next_offset,
    ...(rawReplayBestEffort && {
      raw_replay_best_effort: rawReplayBestEffort,
    }),
    ...(note && { note }),
  };
  if (params.compact === false) {
    const rawError = rawTelemetryPageError(pageItems);
    if (rawError) return errorResponse(`error: ${rawError}`);
  }

  // Single-line JSON rather than the pretty-printed house helpers: a page
  // carries up to 100 events and indentation would inflate the token cost.
  const serializedResponse = JSON.stringify(response);
  if (
    params.compact === false &&
    Buffer.byteLength(serializedResponse, "utf8") > maxRawTelemetryResponseBytes
  ) {
    return errorResponse(
      `error: raw telemetry response exceeds ${maxRawTelemetryResponseBytes} bytes. reduce limit or narrow the category and time window.`,
    );
  }
  return textResponse(serializedResponse);
}

function browserSessionNextActions(sessionId: string) {
  return [
    `use computer_action with session_id "${sessionId}" to inspect or control the browser.`,
    `use manage_browsers with action "get" and session_id "${sessionId}" for full browser details.`,
    `use manage_browsers with action "delete" and session_id "${sessionId}" when the session is no longer needed.`,
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
      "KERNEL cli: https://kernel.sh/docs/reference/cli",
      "websocat: brew install websocat on macos",
    ],
    remote_forward: remotePort
      ? {
          browser_vm_url: `http://localhost:${remotePort}`,
          next_action: `once the user has the tunnel running, use execute_playwright_code to navigate the browser to http://localhost:${remotePort}.`,
        }
      : undefined,
    local_forward: localPort
      ? {
          local_url: `http://localhost:${localPort}`,
          note: `services inside the browser vm are accessible locally at localhost:${localPort} once the tunnel is running.`,
        }
      : undefined,
    note: "ssh connections alone do not count as browser activity. set an appropriate timeout or keep the live view open to prevent cleanup.",
  };
}

export function registerBrowserCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  registerJsonResourceCollection(
    server,
    {
      name: "browsers",
      uriTemplate:
        "kernel://orgs/{organizationId}/projects/{projectId}/browsers",
      emptyText: "no browsers found",
      read: async (client) => {
        const browsers = [];
        for await (const browser of client.browsers.list()) {
          browsers.push(browser);
        }
        return browsers;
      },
    },
    dependencies,
  );

  registerJsonResourceTemplate(
    server,
    {
      name: "browser",
      uriTemplate:
        "kernel://orgs/{organizationId}/projects/{projectId}/browsers/{sessionId}",
      variableName: "sessionId",
      resourceLabel: "browser session",
      read: (client, sessionId) => client.browsers.retrieve(sessionId),
    },
    dependencies,
  );

  // manage_browsers -- Manage browser sessions and read archived telemetry
  server.registerTool(
    "manage_browsers",
    {
      description:
        'manage browser sessions and their archived telemetry. use "list" to choose an existing session, "create" before browser control, "update" to change supported session settings, "get" for full details, "get_telemetry" to diagnose active or deleted sessions, and "delete" when finished. live sessions can be addressed by id or by the name given at creation or set on update; deleted sessions only by id. get_telemetry compacts events by default; set compact=false with explicit categories and a limit of at most 5 when raw headers, request data, response bodies, or other omitted fields are needed.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum(["create", "update", "list", "get", "get_telemetry", "delete"])
          .describe("operation to perform."),
        session_id: z
          .string()
          .describe(
            "browser session id or name. required for update, get, get_telemetry, and delete actions. a name resolves only a live session; for a deleted session (get_telemetry) pass its id.",
          )
          .optional(),
        name: z
          .string()
          .describe(
            "(create, update) human-readable session name, unique among active sessions in the project. 1-255 chars of letters, digits, '.', '_' or '-', and not a cuid-like id. while the session is live it can be passed as session_id to the browser tools (manage_browsers, computer_action, execute_playwright_code, browser_repl, exec_command, browser_curl, manage_replays, webmcp). on update, an empty string clears the name.",
          )
          .optional(),
        tags: z
          .record(z.string(), z.string())
          .describe(
            "(create, update) key-value tags for grouping sessions. up to 50 pairs. on update, an empty object clears all tags. (list) return only sessions carrying all of these tags.",
          )
          .optional(),
        query: z
          .string()
          .describe(
            "(list) text filter matched against session name, session id, profile name or id, proxy id, or pool name.",
          )
          .optional(),
        start_url: z
          .string()
          .url()
          .describe(
            "(create) url to open when the browser is created, or (update) url to navigate to after applying the update. when a profile is loaded in the same update, this overrides the profile's restored tabs. navigation is best-effort.",
          )
          .optional(),
        vaults: browserVaultsSchema,
        chrome_policy: z
          .record(z.string(), z.unknown())
          .describe(
            "(create) chrome enterprise policy overrides. KERNEL-managed policies such as extensions, proxy, cdp, and automation are blocked by the api.",
          )
          .optional(),
        headless: z
          .boolean()
          .describe("(create) launch without gui. faster but no live view.")
          .optional(),
        gpu: z
          .boolean()
          .describe(
            "(create) enable gpu acceleration. requires start-up or enterprise plan and headless=false.",
          )
          .optional(),
        stealth: z
          .boolean()
          .describe(
            "(create) apply KERNEL site-compatibility browser settings. use only on sites and accounts the user is authorized to access.",
          )
          .optional(),
        region: z
          .enum(["us-east", "eu-west"])
          .describe(
            "(create) geographic region for the browser session. fixed once created; requires start-up or enterprise plan, defaults to us-east. (list) filter sessions by region.",
          )
          .optional(),
        timeout_seconds: z
          .number()
          .int()
          .min(10)
          .max(259200)
          .describe(
            "(create) inactivity timeout in seconds (max 259200 = 72h). default 60.",
          )
          .optional(),
        profile_name: z
          .string()
          .describe(
            "(create, update) profile name to load saved cookies/logins. cannot use with profile_id.",
          )
          .optional(),
        profile_id: z
          .string()
          .describe(
            "(create, update) profile id to load. cannot use with profile_name.",
          )
          .optional(),
        save_profile_changes: z
          .boolean()
          .describe(
            "(create, update) save session changes back to profile on close.",
          )
          .optional(),
        proxy: proxyConfigSchema()
          .describe(
            "(create, update) proxy egress, set with exactly one of id, name, or mode. id or name selects that proxy. mode direct forces direct egress; mode default restores the browser's default egress. on create, omit for the browser default; on update, omit to leave unchanged. cannot be combined with proxy_id, clear_proxy, or disable_default_proxy.",
          )
          .optional(),
        proxy_id: z
          .string()
          .describe(
            "deprecated: use `proxy.id` instead. (create, update) proxy id for traffic routing. for update, omit to leave unchanged.",
          )
          .optional(),
        network: z
          .object({
            proxy_routes: z
              .array(
                z.object({
                  hosts: z.array(z.string().min(1)).min(1).max(50),
                  proxy: proxySelectorSchema(),
                }),
              )
              .max(10)
              .describe(
                'route requests for 1–50 host patterns per route through a proxy selected by exactly one of proxy.id or proxy.name (max 10 routes). use exact hostnames or leading "*." wildcards, which match subdomains only, not the apex. matching ignores case and ports; the most specific match wins. matched hosts override the top-level proxy; unmatched hosts use the top-level proxy or the browser default. start_url uses the top-level proxy, not routes. if a route proxy is unavailable, matched requests fail closed.',
              )
              .optional(),
          })
          .describe(
            "(create only) network settings for the browser session. cannot be combined with proxy_routes.",
          )
          .optional(),
        proxy_routes: z
          .array(
            z.object({
              hosts: z.array(z.string().min(1)).min(1).max(50),
              proxy_id: z.string().min(1).optional(),
              proxy_name: z.string().min(1).optional(),
            }),
          )
          .max(10)
          .describe(
            "deprecated: use `network.proxy_routes` instead. (create only) the same routes, with each proxy selected by exactly one of proxy_id or proxy_name.",
          )
          .optional(),
        clear_proxy: z
          .boolean()
          .describe(
            "deprecated: use `proxy.mode` default instead. (update) remove the current proxy from the browser session.",
          )
          .optional(),
        disable_default_proxy: z
          .boolean()
          .describe(
            "deprecated: use `proxy.mode` direct instead. (update) connect directly instead of through the session's default KERNEL-managed proxy.",
          )
          .optional(),
        kiosk_mode: z
          .boolean()
          .describe("(create) hide address bar/tabs in live view.")
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
        viewport_force: z
          .boolean()
          .describe(
            "(update) force viewport changes even when live view or recording is active.",
          )
          .optional(),
        extension_id: z
          .string()
          .describe("(create) extension id to load.")
          .optional(),
        extension_name: z
          .string()
          .describe("(create) extension name to load.")
          .optional(),
        local_forward: z
          .string()
          .describe(
            "(create) ssh local forwarding (localport:host:remoteport).",
          )
          .optional(),
        remote_forward: z
          .string()
          .describe(
            "(create) ssh remote forwarding (remoteport:host:localport). use to expose local dev server to browser.",
          )
          .optional(),
        status: z
          .enum(["active", "deleted", "all"])
          .describe('(list) filter by status. default "active".')
          .optional(),
        limit: paginationParams.limit.describe(
          "(list, get_telemetry) max results per page (1-100). get_telemetry defaults to 100; the list default is set by the api.",
        ),
        offset: paginationParams.offset.describe(
          "(list) numeric pagination offset. (get_telemetry) opaque cursor: pass next_offset from the previous response and preserve categories, until, and order. do not derive it from event seq values.",
        ),
        categories: z
          .array(z.enum(telemetryEventCategories))
          .min(1)
          .describe(
            `(get_telemetry) restrict results to these event categories. a filtered page can be empty while has_more is true. ${TELEMETRY_EVENT_CATALOG}`,
          )
          .optional(),
        since: z
          .string()
          .describe(
            "(get_telemetry) start of the window: an rfc-3339 timestamp or a duration like '30m' meaning that long ago. defaults to session creation. ignored when offset is set; cannot be combined with order=desc.",
          )
          .optional(),
        until: z
          .string()
          .describe(
            "(get_telemetry) end of the window (exclusive): an rfc-3339 timestamp or a duration like '5m'. preserve it while paging.",
          )
          .optional(),
        order: z
          .enum(["asc", "desc"])
          .describe(
            "(get_telemetry) read direction. asc (default) reads oldest first from session start; desc reads newest first. prefer desc when diagnosing a recent failure in a long session — it reaches the end without paging. preserve it while paging.",
          )
          .optional(),
        compact: z
          .boolean()
          .describe(
            "(get_telemetry) defaults to true. compact items flatten the event envelope, add an iso time, and omit data fields named body, headers, post_data, or png plus any data field over 8 kib; omitted_fields lists removals. an eligible category-filtered compact response includes raw_replay_best_effort arguments targeting the same page start, but late events or retention may change results between calls. raw mode requires explicit categories and limit<=5, rejects screenshot pngs, and caps the serialized response at 1 mib.",
          )
          .optional(),
        telemetry_enabled: z
          .boolean()
          .describe(
            "(create, update) enable telemetry, or disable telemetry when false. telemetry is off unless requested. the default category set is the lightweight operational bundle (control, connection, system, captcha) and does not include console, network, or page — enable those explicitly when you intend to debug page behavior.",
          )
          .optional(),
        telemetry_console: z
          .boolean()
          .describe(
            "(create, update) enable or disable console telemetry (console output and uncaught exceptions). off by default; enable for debugging.",
          )
          .optional(),
        telemetry_network: z
          .boolean()
          .describe(
            "(create, update) enable or disable network telemetry (request/response metadata). off by default; enable for debugging.",
          )
          .optional(),
        telemetry_page: z
          .boolean()
          .describe(
            "(create, update) enable or disable page lifecycle telemetry (navigation, load, layout shifts, lcp). off by default; enable for debugging.",
          )
          .optional(),
        telemetry_interaction: z
          .boolean()
          .describe(
            "(create, update) enable or disable user interaction telemetry (clicks, keys, scrolls). off by default; enable for debugging.",
          )
          .optional(),
      }),
      annotations: {
        title: "manage KERNEL browser sessions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        if (params.vaults !== undefined && params.action !== "create") {
          return errorResponse(
            "vault bindings are creation-only; they cannot be added to an existing browser.",
          );
        }
        if (
          (params.network !== undefined || params.proxy_routes !== undefined) &&
          params.action !== "create"
        ) {
          return errorResponse(
            "proxy routes are creation-only; they cannot be added to an existing browser.",
          );
        }
        if (params.proxy !== undefined) {
          const error =
            proxyConfigError("proxy", params.proxy) ??
            deprecatedParamConflict("proxy", params, [
              "proxy_id",
              "clear_proxy",
              "disable_default_proxy",
            ]);
          if (error) return errorResponse(`error: ${error}`);
        }
        if (params.network !== undefined) {
          const error =
            deprecatedParamConflict("network", params, ["proxy_routes"]) ??
            params.network.proxy_routes
              ?.map((route, i) =>
                proxySelectorError(
                  `network.proxy_routes[${i}].proxy`,
                  route.proxy,
                ),
              )
              .find(Boolean);
          if (error) return errorResponse(`error: ${error}`);
        }
        switch (params.action) {
          case "create": {
            const createParams: Kernel.BrowserCreateParams = {};
            if (params.vaults !== undefined)
              createParams.vaults = params.vaults;
            if (params.headless !== undefined)
              createParams.headless = params.headless;
            if (params.gpu !== undefined) createParams.gpu = params.gpu;
            if (params.stealth !== undefined)
              createParams.stealth = params.stealth;
            if (params.region !== undefined)
              createParams.region = params.region;
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
            if (params.proxy !== undefined) createParams.proxy = params.proxy;
            if (params.proxy_id) createParams.proxy_id = params.proxy_id;
            if (params.network !== undefined)
              createParams.network = params.network;
            if (params.proxy_routes !== undefined) {
              const proxyRoutes: Array<BrowserNetworkConfig.ProxyRoute> = [];
              for (const {
                hosts,
                proxy_id,
                proxy_name,
              } of params.proxy_routes) {
                if (Boolean(proxy_id) === Boolean(proxy_name)) {
                  return errorResponse(
                    "error: each proxy route requires exactly one of proxy_id or proxy_name.",
                  );
                }
                proxyRoutes.push({
                  hosts,
                  proxy: proxy_id ? { id: proxy_id } : { name: proxy_name },
                });
              }
              createParams.network = {
                ...createParams.network,
                proxy_routes: proxyRoutes,
              };
            }
            if (params.name !== undefined) createParams.name = params.name;
            if (params.tags !== undefined) createParams.tags = params.tags;
            const browserConfig = buildBrowserCreateConfig(params);
            if (!browserConfig.ok) return errorResponse(browserConfig.error);
            Object.assign(createParams, browserConfig.value);
            const telemetry = buildTelemetry(params);
            if (!telemetry.ok) return errorResponse(telemetry.error);
            if (telemetry.value !== undefined)
              createParams.telemetry = telemetry.value;

            const browser = await client.browsers.create(
              createParams,
              params.vaults?.length
                ? { maxRetries: 0, signal: ctx.mcpReq.signal }
                : undefined,
            );
            if (!browser)
              return errorResponse("failed to create browser session");

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
                "error: session_id is required for update action.",
              );
            if (params.proxy_id && params.clear_proxy) {
              return errorResponse(
                "error: cannot specify both proxy_id and clear_proxy.",
              );
            }

            const updateParams: BrowserUpdateParams = {};
            if (params.proxy !== undefined) updateParams.proxy = params.proxy;
            if (params.disable_default_proxy !== undefined) {
              updateParams.disable_default_proxy = params.disable_default_proxy;
            }
            if (params.clear_proxy) {
              updateParams.proxy_id = "";
            } else if (params.proxy_id !== undefined) {
              updateParams.proxy_id = params.proxy_id;
            }
            if (params.name !== undefined) updateParams.name = params.name;
            if (params.tags !== undefined) updateParams.tags = params.tags;
            const browserConfig = buildBrowserUpdateConfig(params);
            if (!browserConfig.ok) return errorResponse(browserConfig.error);
            Object.assign(updateParams, browserConfig.value);
            const telemetry = buildTelemetry(params);
            if (!telemetry.ok) return errorResponse(telemetry.error);
            if (telemetry.value !== undefined)
              updateParams.telemetry = telemetry.value;

            if (Object.keys(updateParams).length === 0) {
              return errorResponse(
                "error: at least one update field is required.",
              );
            }

            const browser = await client.browsers.update(
              params.session_id,
              updateParams,
            );
            if (!browser)
              return errorResponse("failed to update browser session");
            return jsonResponse({
              browser,
              next_actions: browserSessionNextActions(browser.session_id),
            });
          }
          case "list": {
            const page = await client.browsers.list({
              ...(params.status && { status: params.status }),
              ...(params.region && { region: params.region }),
              ...(params.query && { query: params.query }),
              ...(params.tags !== undefined && { tags: params.tags }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              mapItem: ({ cdp_ws_url: _cdpWsUrl, ...browser }) => browser,
              note: 'use action "get" with session_id for full browser details.',
            });
          }
          case "get": {
            if (!params.session_id)
              return errorResponse(
                "error: session_id is required for get action.",
              );
            const browser = await client.browsers.retrieve(params.session_id);
            if (!browser)
              return errorResponse(
                `browser session "${params.session_id}" not found`,
              );
            return jsonResponse(browser);
          }
          case "get_telemetry": {
            if (!params.session_id)
              return errorResponse(
                "error: session_id is required for get_telemetry action.",
              );
            if (params.since !== undefined && params.order === "desc") {
              return errorResponse(
                "error: since cannot be combined with order=desc. use until to bound a newest-first read, or order=asc with since.",
              );
            }
            return await readBrowserTelemetry(client, {
              session_id: params.session_id,
              project: params.project,
              project_id: params.project_id,
              categories: params.categories,
              limit: params.limit,
              offset: params.offset,
              since: params.since,
              until: params.until,
              order: params.order,
              compact: params.compact,
            });
          }
          case "delete": {
            if (!params.session_id)
              return errorResponse(
                "error: session_id is required for delete action.",
              );
            await client.browsers.deleteByID(params.session_id);
            return textResponse("browser session deleted successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_browsers", params.action, error);
      }
    },
  );
}
