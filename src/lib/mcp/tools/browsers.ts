import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

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

  // manage_browsers -- Create, list, get, and delete browser sessions
  server.tool(
    "manage_browsers",
    'Manage browser sessions in the Kernel platform. Use action "create" to launch a new browser, "list" to see existing sessions, "get" to retrieve details about a specific session, or "delete" to terminate one. Created browsers run in isolated VMs and support headless/stealth modes, profiles, proxies, viewports, extensions, and SSH tunneling.',
    {
      action: z
        .enum(["create", "list", "get", "delete"])
        .describe("Operation to perform."),
      session_id: z
        .string()
        .describe("Browser session ID. Required for get and delete actions.")
        .optional(),
      headless: z
        .boolean()
        .describe("(create) Launch without GUI. Faster but no live view.")
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
          "(create) Profile name to load saved cookies/logins. Cannot use with profile_id.",
        )
        .optional(),
      profile_id: z
        .string()
        .describe("(create) Profile ID to load. Cannot use with profile_name.")
        .optional(),
      save_profile_changes: z
        .boolean()
        .describe("(create) Save session changes back to profile on close.")
        .optional(),
      proxy_id: z
        .string()
        .describe("(create) Proxy ID for traffic routing.")
        .optional(),
      kiosk_mode: z
        .boolean()
        .describe("(create) Hide address bar/tabs in live view.")
        .optional(),
      viewport_width: z
        .number()
        .describe(
          "(create) Window width in pixels. Must pair with viewport_height.",
        )
        .optional(),
      viewport_height: z
        .number()
        .describe(
          "(create) Window height in pixels. Must pair with viewport_width.",
        )
        .optional(),
      viewport_refresh_rate: z
        .number()
        .describe("(create) Display refresh rate in Hz.")
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
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
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
            if (
              (params.viewport_width && !params.viewport_height) ||
              (!params.viewport_width && params.viewport_height)
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: viewport_width and viewport_height must be provided together.",
                  },
                ],
              };
            }

            const createParams: Record<string, unknown> = {};
            if (params.headless !== undefined)
              createParams.headless = params.headless;
            if (params.stealth !== undefined)
              createParams.stealth = params.stealth;
            if (params.timeout_seconds !== undefined)
              createParams.timeout_seconds = params.timeout_seconds;
            if (params.kiosk_mode !== undefined)
              createParams.kiosk_mode = params.kiosk_mode;
            if (params.proxy_id) createParams.proxy_id = params.proxy_id;
            if (params.profile_name || params.profile_id) {
              createParams.profile = {
                ...(params.profile_name && { name: params.profile_name }),
                ...(params.profile_id && { id: params.profile_id }),
                ...(params.save_profile_changes !== undefined && {
                  save_changes: params.save_profile_changes,
                }),
              };
            }
            if (params.viewport_width && params.viewport_height) {
              createParams.viewport = {
                width: params.viewport_width,
                height: params.viewport_height,
                ...(params.viewport_refresh_rate && {
                  refresh_rate: params.viewport_refresh_rate,
                }),
              };
            }
            if (params.extension_id || params.extension_name) {
              createParams.extensions = [
                {
                  ...(params.extension_id && { id: params.extension_id }),
                  ...(params.extension_name && { name: params.extension_name }),
                },
              ];
            }

            const browser = await client.browsers.create(
              createParams as Parameters<typeof client.browsers.create>[0],
            );
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
          case "list": {
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
