import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";

type BrowserCreateParams = NonNullable<
  Parameters<KernelClient["browsers"]["create"]>[0]
>;
type BrowserUpdateParams = Parameters<KernelClient["browsers"]["update"]>[1];

type ProfileParams = {
  profile_name?: string;
  profile_id?: string;
  save_profile_changes?: boolean;
};

type ViewportParams = {
  viewport_width?: number;
  viewport_height?: number;
  viewport_refresh_rate?: number;
  viewport_force?: boolean;
};

type TelemetryParams = {
  telemetry_enabled?: boolean;
  telemetry_console?: boolean;
  telemetry_network?: boolean;
  telemetry_page?: boolean;
  telemetry_interaction?: boolean;
};

type BrowserAction = "create" | "update" | "list" | "get" | "delete";

const scopedBrowserFields = [
  "session_id",
  "start_url",
  "chrome_policy",
  "headless",
  "gpu",
  "stealth",
  "timeout_seconds",
  "profile_name",
  "profile_id",
  "save_profile_changes",
  "proxy_id",
  "clear_proxy",
  "disable_default_proxy",
  "kiosk_mode",
  "viewport_width",
  "viewport_height",
  "viewport_refresh_rate",
  "viewport_force",
  "extension_id",
  "extension_name",
  "local_forward",
  "remote_forward",
  "status",
  "limit",
  "offset",
  "telemetry_enabled",
  "telemetry_console",
  "telemetry_network",
  "telemetry_page",
  "telemetry_interaction",
] as const;

type BrowserToolField = (typeof scopedBrowserFields)[number];

const createActions: readonly BrowserAction[] = ["create"];
const updateActions: readonly BrowserAction[] = ["update"];
const createUpdateActions: readonly BrowserAction[] = ["create", "update"];

const browserFieldScopes: Record<BrowserToolField, readonly BrowserAction[]> = {
  session_id: ["update", "get", "delete"],
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
  status: ["list"],
  limit: ["list"],
  offset: ["list"],
  telemetry_enabled: createUpdateActions,
  telemetry_console: createUpdateActions,
  telemetry_network: createUpdateActions,
  telemetry_page: createUpdateActions,
  telemetry_interaction: createUpdateActions,
};

const telemetryCategories = [
  ["telemetry_console", "console"],
  ["telemetry_network", "network"],
  ["telemetry_page", "page"],
  ["telemetry_interaction", "interaction"],
] as const;

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

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

function buildProfile(params: ProfileParams): BrowserCreateParams["profile"] {
  if (
    params.save_profile_changes !== undefined &&
    !params.profile_name &&
    !params.profile_id
  ) {
    throw new Error(
      "profile_name or profile_id is required when save_profile_changes is set.",
    );
  }
  if (!params.profile_name && !params.profile_id) return undefined;
  return {
    ...(params.profile_name && { name: params.profile_name }),
    ...(params.profile_id && { id: params.profile_id }),
    ...(params.save_profile_changes !== undefined && {
      save_changes: params.save_profile_changes,
    }),
  };
}

function buildViewportBase(
  params: ViewportParams,
): NonNullable<BrowserCreateParams["viewport"]> | undefined {
  const width = params.viewport_width;
  const height = params.viewport_height;
  const hasWidth = width !== undefined;
  const hasHeight = height !== undefined;
  const hasViewportOptions =
    hasWidth || hasHeight || params.viewport_refresh_rate !== undefined;

  if (!hasViewportOptions) return undefined;
  if (!hasWidth || !hasHeight) {
    throw new Error(
      "viewport_width and viewport_height must be provided together.",
    );
  }

  return {
    width,
    height,
    ...(params.viewport_refresh_rate !== undefined && {
      refresh_rate: params.viewport_refresh_rate,
    }),
  };
}

function buildCreateViewport(
  params: ViewportParams,
): BrowserCreateParams["viewport"] {
  return buildViewportBase(params);
}

function buildUpdateViewport(
  params: ViewportParams,
): BrowserUpdateParams["viewport"] {
  const viewport = buildViewportBase(params);

  if (!viewport) {
    if (params.viewport_force !== undefined) {
      throw new Error(
        "viewport_width and viewport_height must be provided when viewport_force is set.",
      );
    }
    return undefined;
  }

  return {
    ...viewport,
    ...(params.viewport_force !== undefined && {
      force: params.viewport_force,
    }),
  };
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
    const uriString = uri.toString();

    if (uriString === "browsers://") {
      // List all browsers
      const browsersPage = await client.browsers.list();
      const items = browsersPage.getPaginatedItems();
      return {
        contents: [
          {
            uri: "browsers://",
            mimeType: "application/json",
            text:
              items.length > 0
                ? JSON.stringify(items, null, 2)
                : "No browsers found",
          },
        ],
      };
    } else if (uriString.startsWith("browsers://")) {
      // Get specific browser by session ID
      const sessionId = uriString.replace("browsers://", "");
      const browser = await client.browsers.retrieve(sessionId);

      if (!browser) {
        throw new Error(`Browser session "${sessionId}" not found`);
      }

      return {
        contents: [
          {
            uri: uriString,
            mimeType: "application/json",
            text: JSON.stringify(browser, null, 2),
          },
        ],
      };
    }

    throw new Error(`Invalid browser URI: ${uriString}`);
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
            if (params.profile_name && params.profile_id) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot specify both profile_name and profile_id.",
                  },
                ],
              };
            }
            if (params.extension_id && params.extension_name) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot specify both extension_id and extension_name.",
                  },
                ],
              };
            }

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
            if (params.start_url) createParams.start_url = params.start_url;
            if (params.chrome_policy)
              createParams.chrome_policy = params.chrome_policy;
            if (params.proxy_id) createParams.proxy_id = params.proxy_id;
            const profile = buildProfile(params);
            if (profile) createParams.profile = profile;
            const viewport = buildCreateViewport(params);
            if (viewport) createParams.viewport = viewport;
            const telemetry = buildTelemetry(params);
            if (telemetry !== undefined) createParams.telemetry = telemetry;
            if (params.extension_id || params.extension_name) {
              createParams.extensions = [
                {
                  ...(params.extension_id && { id: params.extension_id }),
                  ...(params.extension_name && { name: params.extension_name }),
                },
              ];
            }

            const browser = await client.browsers.create(createParams);
            if (!browser)
              return {
                content: [
                  { type: "text", text: "Failed to create browser session" },
                ],
              };

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
            return { content: [{ type: "text", text: responseText }] };
          }
          case "update": {
            const scopeError = actionFieldError(params, "update");
            if (scopeError) return textResponse(scopeError);
            if (!params.session_id)
              return textResponse(
                "Error: session_id is required for update action.",
              );
            if (params.profile_name && params.profile_id) {
              return textResponse(
                "Error: Cannot specify both profile_name and profile_id.",
              );
            }
            if (params.extension_id || params.extension_name) {
              return textResponse(
                "Error: extensions can only be loaded during create.",
              );
            }
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
            const profile = buildProfile(params);
            if (profile) updateParams.profile = profile;
            const viewport = buildUpdateViewport(params);
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
            return {
              content: [
                { type: "text", text: JSON.stringify(browser, null, 2) },
              ],
            };
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
            return {
              content: [
                {
                  type: "text",
                  text:
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
                },
              ],
            };
          }
          case "get": {
            const scopeError = actionFieldError(params, "get");
            if (scopeError) return textResponse(scopeError);
            if (!params.session_id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: session_id is required for get action.",
                  },
                ],
              };
            const browser = await client.browsers.retrieve(params.session_id);
            if (!browser)
              return {
                content: [
                  {
                    type: "text",
                    text: `Browser session "${params.session_id}" not found`,
                  },
                ],
              };
            return {
              content: [
                { type: "text", text: JSON.stringify(browser, null, 2) },
              ],
            };
          }
          case "delete": {
            const scopeError = actionFieldError(params, "delete");
            if (scopeError) return textResponse(scopeError);
            if (!params.session_id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: session_id is required for delete action.",
                  },
                ],
              };
            await client.browsers.deleteByID(params.session_id);
            return {
              content: [
                { type: "text", text: "Browser session deleted successfully" },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_browsers (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );
}
