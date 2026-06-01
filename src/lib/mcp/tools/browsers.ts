import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildBrowserExtensions,
  buildBrowserProfile,
  buildBrowserStartUrl,
  buildBrowserViewport,
  buildBrowserViewportUpdate,
} from "@/lib/mcp/browser-config";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import { errorMessage, jsonResponse, textResponse } from "@/lib/mcp/responses";

type BrowserCreateParams = NonNullable<
  Parameters<KernelClient["browsers"]["create"]>[0]
>;
type BrowserUpdateParams = Parameters<KernelClient["browsers"]["update"]>[1];

type TelemetryParams = {
  telemetry_enabled?: boolean;
  telemetry_console?: boolean;
  telemetry_network?: boolean;
  telemetry_page?: boolean;
  telemetry_interaction?: boolean;
};

type BrowserAction = "create" | "update" | "list" | "get" | "delete";

const createActions: readonly BrowserAction[] = ["create"];
const updateActions: readonly BrowserAction[] = ["update"];
const createUpdateActions: readonly BrowserAction[] = ["create", "update"];
const sessionIdActions: readonly BrowserAction[] = ["update", "get", "delete"];
const listActions: readonly BrowserAction[] = ["list"];

const browserFieldScopes = {
  session_id: sessionIdActions,
  start_url: createActions,
  chrome_policy: createActions,
  headless: createActions,
  gpu: createActions,
  stealth: createActions,
  timeout_seconds: createActions,
  profile_name: createUpdateActions,
  profile_id: createUpdateActions,
  save_profile_changes: createUpdateActions,
  proxy_id: createUpdateActions,
  clear_proxy: updateActions,
  disable_default_proxy: updateActions,
  kiosk_mode: createActions,
  viewport_width: createUpdateActions,
  viewport_height: createUpdateActions,
  viewport_refresh_rate: createUpdateActions,
  viewport_force: updateActions,
  extension_id: createActions,
  extension_name: createActions,
  local_forward: createActions,
  remote_forward: createActions,
  status: listActions,
  limit: listActions,
  offset: listActions,
  telemetry_enabled: createUpdateActions,
  telemetry_console: createUpdateActions,
  telemetry_network: createUpdateActions,
  telemetry_page: createUpdateActions,
  telemetry_interaction: createUpdateActions,
} satisfies Record<string, readonly BrowserAction[]>;

type BrowserToolField = keyof typeof browserFieldScopes;

const scopedBrowserFields = Object.keys(
  browserFieldScopes,
) as BrowserToolField[];

const telemetryCategories = [
  ["telemetry_console", "console"],
  ["telemetry_network", "network"],
  ["telemetry_page", "page"],
  ["telemetry_interaction", "interaction"],
] as const;

function formatActionScope(field: BrowserToolField) {
  return browserFieldScopes[field].join(", ");
}

function actionFieldError(
  params: Partial<Record<BrowserToolField, unknown>>,
  action: BrowserAction,
) {
  const unsupportedField = scopedBrowserFields.find(
    (field) =>
      params[field] !== undefined &&
      !browserFieldScopes[field].includes(action),
  );

  return unsupportedField
    ? `Error: ${unsupportedField} is only supported for ${formatActionScope(
        unsupportedField,
      )}.`
    : undefined;
}

function buildTelemetry(
  params: TelemetryParams,
): BrowserCreateParams["telemetry"] | BrowserUpdateParams["telemetry"] {
  const browser: NonNullable<
    NonNullable<BrowserCreateParams["telemetry"]>["browser"]
  > = {};
  let hasBrowserCategories = false;

  for (const [paramKey, category] of telemetryCategories) {
    const enabled = params[paramKey];
    if (enabled !== undefined) {
      browser[category] = { enabled };
      hasBrowserCategories = true;
    }
  }

  if (params.telemetry_enabled === false && hasBrowserCategories) {
    throw new Error(
      "telemetry_enabled=false cannot be combined with telemetry category settings.",
    );
  }

  if (params.telemetry_enabled === undefined && !hasBrowserCategories) {
    return undefined;
  }

  return {
    ...(params.telemetry_enabled !== undefined && {
      enabled: params.telemetry_enabled,
    }),
    ...(hasBrowserCategories && { browser }),
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
    'Manage browser sessions in the Kernel platform. Use action "create" to launch a new browser, "update" to modify supported session settings, "list" to see existing sessions, "get" to retrieve details about a specific session, or "delete" to terminate one. Created browsers run in isolated VMs and support headless/stealth modes, profiles, proxies, viewports, extensions, Chrome policy overrides, telemetry, start URLs, and SSH tunneling.',
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
      limit: z
        .number()
        .describe("(list) Max results per page. Default 50.")
        .optional(),
      offset: z
        .number()
        .describe("(list) Pagination offset. Default 0.")
        .optional(),
      telemetry_enabled: z
        .boolean()
        .describe(
          "(create, update) Enable telemetry with VM defaults, or disable telemetry when false.",
        )
        .optional(),
      telemetry_console: z
        .boolean()
        .describe("(create, update) Enable or disable console telemetry.")
        .optional(),
      telemetry_network: z
        .boolean()
        .describe("(create, update) Enable or disable network telemetry.")
        .optional(),
      telemetry_page: z
        .boolean()
        .describe(
          "(create, update) Enable or disable page lifecycle telemetry.",
        )
        .optional(),
      telemetry_interaction: z
        .boolean()
        .describe(
          "(create, update) Enable or disable user interaction telemetry.",
        )
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
            const startUrl = buildBrowserStartUrl(params.start_url);
            if (startUrl !== undefined) createParams.start_url = startUrl;
            if (params.chrome_policy)
              createParams.chrome_policy = params.chrome_policy;
            if (params.proxy_id) createParams.proxy_id = params.proxy_id;
            const profile = buildBrowserProfile(params);
            if (profile) createParams.profile = profile;
            const viewport = buildBrowserViewport(params);
            if (viewport) createParams.viewport = viewport;
            const telemetry = buildTelemetry(params);
            if (telemetry !== undefined) createParams.telemetry = telemetry;
            const extensions = buildBrowserExtensions(params);
            if (extensions) createParams.extensions = extensions;

            const browser = await client.browsers.create(createParams);
            if (!browser)
              return textResponse("Failed to create browser session");

            let responseText = JSON.stringify(browser, null, 2);
            if (params.local_forward || params.remote_forward) {
              const sshParts = ["kernel browsers ssh", browser.session_id];
              if (params.local_forward)
                sshParts.push(`-L ${params.local_forward}`);
              if (params.remote_forward)
                sshParts.push(`-R ${params.remote_forward}`);
              const sshCommand = sshParts.join(" ");

              const remotePort = params.remote_forward
                ? params.remote_forward.split(":")[0]
                : null;
              const localPort = params.local_forward
                ? params.local_forward.split(":")[0]
                : null;

              responseText += `\n\n## SSH Port Forwarding\n\nRun this command in a terminal:\n\n\`\`\`bash\n${sshCommand}\n\`\`\`\n\nPrerequisites: [Kernel CLI](https://kernel.sh/docs/reference/cli) and [websocat](https://github.com/vi/websocat) (\`brew install websocat\` on macOS).`;

              if (remotePort) {
                responseText += `\n\nThis forwards the user's local port to port ${remotePort} inside the browser VM. Once the user has the tunnel running, use execute_playwright_code to navigate the browser to http://localhost:${remotePort}`;
              }

              if (localPort) {
                responseText += `\n\nThis forwards port ${localPort} from the browser VM to the user's local machine. Once the user has the tunnel running, services inside the VM are accessible locally at localhost:${localPort}`;
              }

              responseText += `\n\nNote: SSH connections alone don't count as browser activity. Set an appropriate timeout or keep the live view open to prevent cleanup.`;
            }
            return textResponse(responseText);
          }
          case "update": {
            const scopeError = actionFieldError(params, "update");
            if (scopeError) return textResponse(scopeError);
            if (!params.session_id)
              return textResponse(
                "Error: session_id is required for update action.",
              );
            if (params.proxy_id && params.clear_proxy) {
              return textResponse(
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
            const profile = buildBrowserProfile(params);
            if (profile) updateParams.profile = profile;
            const viewport = buildBrowserViewportUpdate(params);
            if (viewport) updateParams.viewport = viewport;
            const telemetry = buildTelemetry(params);
            if (telemetry !== undefined) updateParams.telemetry = telemetry;

            if (Object.keys(updateParams).length === 0) {
              return textResponse(
                "Error: at least one update field is required.",
              );
            }

            const browser = await client.browsers.update(
              params.session_id,
              updateParams,
            );
            if (!browser)
              return textResponse("Failed to update browser session");
            return jsonResponse(browser);
          }
          case "list": {
            const scopeError = actionFieldError(params, "list");
            if (scopeError) return textResponse(scopeError);
            const page = await client.browsers.list({
              ...(params.status && { status: params.status }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page
              .getPaginatedItems()
              .map((b) => ({ ...b, cdp_ws_url: undefined }));
            return textResponse(
              items.length > 0
                ? JSON.stringify(
                    {
                      items,
                      has_more: page.has_more,
                      next_offset: page.next_offset,
                    },
                    null,
                    2,
                  )
                : "No browsers found",
            );
          }
          case "get": {
            const scopeError = actionFieldError(params, "get");
            if (scopeError) return textResponse(scopeError);
            if (!params.session_id)
              return textResponse(
                "Error: session_id is required for get action.",
              );
            const browser = await client.browsers.retrieve(params.session_id);
            if (!browser)
              return textResponse(
                `Browser session "${params.session_id}" not found`,
              );
            return jsonResponse(browser);
          }
          case "delete": {
            const scopeError = actionFieldError(params, "delete");
            if (scopeError) return textResponse(scopeError);
            if (!params.session_id)
              return textResponse(
                "Error: session_id is required for delete action.",
              );
            await client.browsers.deleteByID(params.session_id);
            return textResponse("Browser session deleted successfully");
          }
        }
      } catch (error) {
        return textResponse(
          `Error in manage_browsers (${params.action}): ${errorMessage(error)}`,
        );
      }
    },
  );
}
