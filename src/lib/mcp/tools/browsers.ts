import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// Payload fields that can carry kilobytes per event (response bodies, header
// maps). Dropped so a full page of events fits in an agent context window;
// omitted_fields tells the agent what to fetch via the API/CLI if needed.
const bulkyTelemetryDataFields = ["body", "headers", "post_data"] as const;

function compactTelemetryEvent({ seq, event }: TelemetryEnvelope) {
  const { ts, category, type, source, truncated } = event;
  const data = "data" in event ? event.data : undefined;

  let compactData: Record<string, unknown> | undefined;
  let omittedFields: string[] | undefined;
  if (data) {
    compactData = { ...(data as Record<string, unknown>) };
    for (const field of bulkyTelemetryDataFields) {
      if (compactData[field] !== undefined) {
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

  // manage_browsers -- Create, update, list, get, and delete browser sessions
  server.tool(
    "manage_browsers",
    'Manage browser sessions when an agent needs a live browser to inspect, automate, or debug web state. Use "list" to choose an existing session, "create" before browser control, "update" to change supported session settings, "get" for full details, and "delete" when finished.',
    {
      action: z
        .enum(["create", "update", "list", "get", "delete"])
        .describe("Operation to perform."),
      session_id: z
        .string()
        .describe(
          "Browser session ID. Required for update, get, and delete actions.",
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
      ...paginationParams,
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
          "(create, update) Enable or disable user interaction telemetry.",
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

  // get_browser_telemetry -- Read archived telemetry events for a session
  server.tool(
    "get_browser_telemetry",
    `Read archived telemetry events for a browser session. Works while the session is active and after it is deleted, including events captured before telemetry was disabled. If the response reports status "telemetry_currently_disabled", widen or remove filters before enabling telemetry and reproducing: update an active browser, or recreate one that has ended. Page through long sessions with offset/next_offset instead of raising limit. ${TELEMETRY_EVENT_CATALOG}`,
    {
      session_id: z.string().describe("Browser session ID."),
      categories: z
        .array(z.enum(telemetryEventCategories))
        .min(1)
        .describe(
          "Restrict results to these event categories. The filter applies within each page, so a filtered page can be empty while has_more is true.",
        )
        .optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Max events per page (1-100). Default 100.")
        .optional(),
      offset: z
        .number()
        .int()
        .min(0)
        .describe(
          "Pagination cursor: pass next_offset from the previous response to fetch the next page. Opaque — do not derive it from event seq values.",
        )
        .optional(),
      since: z
        .string()
        .describe(
          "Start of the window: an RFC-3339 timestamp or a duration like '30m' meaning that long ago. Defaults to the session's creation time. Ignored when offset is set; cannot be combined with order=desc.",
        )
        .optional(),
      until: z
        .string()
        .describe(
          "End of the window (exclusive): an RFC-3339 timestamp or a duration like '5m'.",
        )
        .optional(),
      order: z
        .enum(["asc", "desc"])
        .describe(
          "Read direction. asc (default) reads oldest first starting from since; desc reads newest first — useful for inspecting the end of a session.",
        )
        .optional(),
    },
    {
      title: "Read browser telemetry events",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      if (params.since !== undefined && params.order === "desc") {
        return errorResponse(
          "Error in get_browser_telemetry (events): since cannot be combined with order=desc. Use until to bound a newest-first read, or order=asc with since.",
        );
      }
      const client = createKernelClient(extra.authInfo.token);

      // Best-effort lookup for the session's telemetry config and creation
      // time; when it fails we still read events but skip disambiguation.
      const fetchBrowser = () =>
        client.browsers.retrieve(params.session_id).catch(() => null);

      try {
        const query: TelemetryEventsQuery = { limit: params.limit ?? 100 };
        if (params.categories) query.category = params.categories;
        if (params.offset !== undefined) query.offset = params.offset;
        if (params.since !== undefined) query.since = params.since;
        if (params.until !== undefined) query.until = params.until;
        if (params.order !== undefined) query.order = params.order;

        let browser: Awaited<ReturnType<typeof fetchBrowser>> = null;
        if (
          query.offset === undefined &&
          query.since === undefined &&
          query.order !== "desc"
        ) {
          // The API's since default is only 5m; cover the whole session.
          browser = await fetchBrowser();
          query.since = browser?.created_at ?? "1970-01-01T00:00:00Z";
        }
        // When the read covers the whole session with no filters (asc from
        // creation, or desc from the newest event), an empty result means the
        // archive is empty — there is nothing to widen.
        const fullSessionRead =
          params.offset === undefined &&
          params.since === undefined &&
          params.until === undefined &&
          params.categories === undefined;

        const page = await client.browsers.telemetry.events(
          params.session_id,
          query,
        );
        const items = page.getPaginatedItems().map(compactTelemetryEvent);

        let status: "ok" | "telemetry_currently_disabled" | "no_events" = "ok";
        let note: string | undefined;
        if (items.length === 0) {
          if (page.has_more) {
            note =
              "This page had no matching events, but more are archived — continue paging with next_offset.";
          } else {
            const emptyReason = fullSessionRead
              ? "No telemetry events are archived for this session"
              : "No archived events matched this window and filter — widen since/until or drop the categories filter";
            browser ??= await fetchBrowser();
            if (browser && !browser.telemetry) {
              status = "telemetry_currently_disabled";
              note = `${emptyReason}. Telemetry is currently disabled: update this active browser with telemetry_enabled=true plus telemetry_console, telemetry_network, and telemetry_page, then reproduce the issue.`;
            } else {
              status = "no_events";
              note = browser
                ? `${emptyReason}.`
                : `${emptyReason}, and the session could not be fetched. If the session has ended and telemetry was not enabled, recreate it with telemetry enabled (including console, network, and page) and reproduce the issue.`;
            }
          }
        }

        // Compact serialization: a full page of events would waste a large
        // share of its size on pretty-printing indentation.
        return textResponse(
          JSON.stringify({
            status,
            items,
            has_more: page.has_more,
            next_offset: page.next_offset,
            ...(note && { note }),
          }),
        );
      } catch (error) {
        return toolErrorResponse("get_browser_telemetry", "events", error);
      }
    },
  );
}
