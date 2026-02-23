import {
  createMcpHandler,
  experimental_withMcpAuth as withMcpAuth,
} from "@vercel/mcp-adapter";
import { verifyToken } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { Kernel } from "@onkernel/sdk";
import { z } from "zod";
import { isValidJwtFormat } from "@/lib/auth-utils";

// Mintlify Assistant API types
interface MintlifySearchResult {
  content: string;
  path: string;
  metadata: Record<string, unknown>;
}

function createKernelClient(apiKey: string) {
  return new Kernel({
    apiKey,
    baseURL: process.env.API_BASE_URL,
    defaultHeaders: {
      "X-Source": "mcp-server",
      "X-Referral-Source": "mcp.onkernel.com",
    },
  });
}

export async function OPTIONS(_req: NextRequest): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// Helper function to create authentication error response
function createAuthErrorResponse(
  error: string = "invalid_token",
  description: string = "Missing or invalid access token",
): Response {
  return new Response(
    JSON.stringify({
      error,
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="OAuth", error="${error}", error_description="${description}"`,
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    },
  );
}

// Create MCP handler with tools
const handler = createMcpHandler((server) => {
  // Register MCP resources
  server.resource("profiles", "profiles://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const uriString = uri.toString();

    if (uriString === "profiles://") {
      // List all profiles
      const profiles = await client.profiles.list();
      return {
        contents: [
          {
            uri: "profiles://",
            mimeType: "application/json",
            text: profiles
              ? JSON.stringify(profiles, null, 2)
              : "No profiles found",
          },
        ],
      };
    } else if (uriString.startsWith("profiles://")) {
      // Get specific profile by name
      const profileName = uriString.replace("profiles://", "");
      const profile = await client.profiles.retrieve(profileName);

      if (!profile) {
        throw new Error(`Profile "${profileName}" not found`);
      }

      return {
        contents: [
          {
            uri: uriString,
            mimeType: "application/json",
            text: JSON.stringify(profile, null, 2),
          },
        ],
      };
    }

    throw new Error(`Invalid profile URI: ${uriString}`);
  });

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

  server.resource("browser_pools", "browser_pools://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const uriString = uri.toString();

    if (uriString === "browser_pools://") {
      const pools = await client.browserPools.list();
      return {
        contents: [
          {
            uri: "browser_pools://",
            mimeType: "application/json",
            text:
              pools && pools.length > 0
                ? JSON.stringify(pools, null, 2)
                : "No browser pools found",
          },
        ],
      };
    } else if (uriString.startsWith("browser_pools://")) {
      const idOrName = uriString.replace("browser_pools://", "");
      const pool = await client.browserPools.retrieve(idOrName);

      if (!pool) {
        throw new Error(`Browser pool "${idOrName}" not found`);
      }

      return {
        contents: [
          {
            uri: uriString,
            mimeType: "application/json",
            text: JSON.stringify(pool, null, 2),
          },
        ],
      };
    }

    throw new Error(`Invalid browser pool URI: ${uriString}`);
  });

  server.resource("apps", "apps://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const uriString = uri.toString();

    if (uriString === "apps://") {
      // List all apps
      const appsPage = await client.apps.list();
      const items = appsPage.getPaginatedItems();
      return {
        contents: [
          {
            uri: "apps://",
            mimeType: "application/json",
            text:
              items.length > 0
                ? JSON.stringify(items, null, 2)
                : "No apps found",
          },
        ],
      };
    } else if (uriString.startsWith("apps://")) {
      // Get specific app by name
      const appName = uriString.replace("apps://", "");
      const appsPage = await client.apps.list({ app_name: appName });
      const app = appsPage.getPaginatedItems()[0];

      if (!app) {
        throw new Error(`App "${appName}" not found`);
      }

      return {
        contents: [
          {
            uri: uriString,
            mimeType: "application/json",
            text: JSON.stringify(app, null, 2),
          },
        ],
      };
    }

    throw new Error(`Invalid app URI: ${uriString}`);
  });

  // MCP Prompt explaining Kernel concepts
  server.prompt(
    "kernel-concepts",
    "Explain Kernel's core concepts and capabilities for AI agents working with web automation",
    {
      concept: z
        .enum(["browsers", "apps", "overview"])
        .describe(
          "The specific concept to explain: browsers (sessions), apps (code execution), profiles (browser auth), or overview (all concepts)",
        ),
    },
    async ({ concept }) => {
      const explanations = {
        browsers: `## 🌐 Browsers (Sessions)

**What they are:** Kernel provides serverless browsers-as-a-service that run in isolated cloud environments. Each browser is a complete, sandboxed instance that can automate any website.

**Key capabilities:**
- **Instant launch** - Browsers start in seconds, not minutes
- **Full isolation** - Each browser runs in its own virtual machine
- **Parallel scaling** - Run hundreds or thousands of concurrent browsers
- **Live view** - Human-in-the-loop workflows with real-time browser viewing
- **Replays** - Record and review past browser sessions as videos
- **CDP integration** - Connect with Playwright, Puppeteer, or any CDP-compatible tool
- **Profiles** - Save and reuse authentication cookies and login data across sessions

**Use cases:** Web scraping, form automation, testing, data extraction, user journey simulation, and any task requiring browser interaction.

**Session options:**
- **Timeout** - Configure browser timeout up to 72 hours for long-running sessions
- **Profiles** - Save and reuse authentication cookies and login data`,

        apps: `## 🚀 Apps (Code Execution Platform)

**What they are:** Kernel's app platform lets you deploy, host, and invoke browser automation code in production without managing infrastructure.

**Key capabilities:**
- **Serverless execution** - Deploy automation code that runs on-demand
- **Auto-scaling** - Automatically handles traffic spikes and resource allocation
- **Seamless integration** - Apps can create and manage browsers programmatically
- **Production ready** - Built-in monitoring, logging, and error handling
- **Multiple languages** - Support for Python, TypeScript, and more

**Development workflow:**
1. Write your automation code
2. Deploy to Kernel's platform
3. Invoke via API or MCP tools
4. Monitor execution and results

**Use cases:** Scheduled web scraping, API endpoints for browser automation, complex multi-step workflows, and production automation services.`,

        overview: `## 🎯 Kernel Platform Overview

**What Kernel is:** A developer platform that provides browsers-as-a-service for AI agents to access websites. Our API and MCP server allows web agents to instantly launch browsers in the cloud and automate anything on the internet.

**Core Concepts:**

### 🌐 Browsers (Sessions)
Serverless browsers that run in isolated cloud environments. Each browser can automate any website with full CDP compatibility, live viewing, replay capabilities, and profiles for authentication.

### 🚀 Apps (Code Execution)
Production-ready platform for deploying and hosting browser automation code. Handles auto-scaling, monitoring, and execution without infrastructure management.

**Why developers choose Kernel:**
- **Performance** - Crazy fast browser launch times
- **Developer experience** - Simple APIs and comprehensive tooling
- **Production ready** - Handles bot detection, authentication, scaling, and observability
- **Cost effective** - Only pay for active browser time
- **Reliable** - Built for enterprise-scale automation

**Perfect for:** AI agents, web automation, testing, scraping, form filling, and any task requiring browser interaction.`,
      };

      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: explanations[concept],
            },
          },
        ],
      };
    },
  );

  // Debug Browser Session Prompt
  server.prompt(
    "debug-browser-session",
    "Comprehensive debugging guide for troubleshooting Kernel browser sessions. Provides a systematic approach to diagnose VM issues, network problems, Chrome errors, and more.",
    {
      session_id: z
        .string()
        .describe(
          "The browser session ID to debug (e.g., 'abc123example456xyz')",
        ),
      issue_description: z
        .string()
        .describe(
          "Description of the issue you're experiencing (e.g., 'ERR_HTTP2_PROTOCOL_ERROR when navigating to a specific site', 'browser not responding', 'page not loading')",
        ),
    },
    async ({ session_id, issue_description }) => {
      const debugGuide = `# 🔍 Browser Session Debugging Guide

**Session ID:** \`${session_id}\`
**Reported Issue:** ${issue_description}

---

## Tools

**Use the Kernel CLI for debugging.** It provides full access to browser sessions, VM logs, and process execution.

Install: \`brew install onkernel/tap/kernel\` or \`npm install -g @onkernel/cli\`

**Explore available commands recursively:**
\`\`\`bash
kernel --help
kernel browsers --help
kernel browsers fs --help
kernel browsers process --help
kernel browsers playwright --help
\`\`\`

**MCP Exception:** The \`computer_action\` MCP tool with action "screenshot" is useful since it returns images directly to the agent.

---

## Key CLI Commands for Debugging

### Check session status
\`\`\`bash
kernel browsers get ${session_id}
\`\`\`

### Take a screenshot (or use MCP computer_action with action "screenshot")
\`\`\`bash
kernel browsers screenshot ${session_id}
\`\`\`

### Execute Playwright code
\`\`\`bash
kernel browsers playwright execute ${session_id} "return { url: page.url(), title: await page.title() }"
\`\`\`

### Read VM log files
\`\`\`bash
kernel browsers fs read-file ${session_id} --path /var/log/supervisord.log
kernel browsers fs read-file ${session_id} --path /var/log/supervisord/chromium
kernel browsers fs read-file ${session_id} --path /var/log/supervisord/neko
\`\`\`

### List files in the VM
\`\`\`bash
kernel browsers fs ls ${session_id} --path /var/log
\`\`\`

### Execute commands inside the VM
\`\`\`bash
kernel browsers process exec ${session_id} -- curl -I https://example.com
kernel browsers process exec ${session_id} -- cat /etc/resolv.conf
\`\`\`

### Check cookies via Playwright
\`\`\`bash
kernel browsers playwright execute ${session_id} "const cookies = await page.context().cookies(); return { count: cookies.length, domains: [...new Set(cookies.map(c => c.domain))] }"
\`\`\`

---

## Common Issues & Solutions

### Network Errors (ERR_HTTP2_PROTOCOL_ERROR, ERR_CONNECTION_RESET, etc.)

**Bot detection is a common cause of network errors.** Many sites use CDNs like Cloudflare, Imperva, or Akamai that fingerprint browsers and block automation.

**Signs of bot detection:**
- curl works from the VM but Chrome shows an error
- "Access Denied", CAPTCHA pages, or "Checking your browser..." messages
- \`stealth: false\` in browser config (check with manage_browsers action "get")

**Solutions:** Use \`stealth: true\`, use profiles with real auth, or try shorter session lifetimes.

### Browser Not Responding
**Cause:** Chrome process crashed or hung
**Check:** Supervisor logs for chromium restart events
**Solutions:**
1. Check if timeout was reached
2. Look for memory issues in logs
3. Create a new browser session

### Page Not Loading
**Cause:** Network, DNS, or proxy issues
**Check:** 
1. Test curl from inside VM
2. Check /etc/resolv.conf for DNS config
3. Verify proxy settings if using one

### Live View Not Working
**Cause:** Neko/WebRTC issues
**Check:** Neko logs for connection errors
**Solutions:**
1. Check for firewall blocking WebRTC
2. Verify browser is not in headless mode

---

## Expected Log Entries (Normal Operation)

These are **normal** and don't indicate problems:
- \`Failed to call method: org.freedesktop.DBus.Properties.GetAll\` - DBus permission (expected in container)
- \`vkCreateInstance: Found no drivers\` - No GPU in VM (expected)
- \`DEPRECATED_ENDPOINT\` for GCM - Google deprecation (harmless)
- \`SharedImageManager::ProduceMemory\` errors - GPU-related (not critical)

---

## Debugging Checklist

- [ ] Session exists and is active
- [ ] Screenshot shows expected content (or reveals error)
- [ ] Current URL is as expected
- [ ] Supervisor logs show all services running
- [ ] Network connectivity works (curl test)
- [ ] No critical errors in chromium logs
- [ ] Cookies/session state is correct

---

## Next Steps

Based on your issue "${issue_description}", start with:

1. **Get browser info** to confirm session is active
2. **Take screenshot** to see current state
3. **Check page URL** to see if on error page
4. **Test network** if seeing connection errors
5. **Review logs** for specific error patterns`;

      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: debugGuide,
            },
          },
        ],
      };
    },
  );

  // search_docs -- Search Kernel platform documentation
  server.tool(
    "search_docs",
    "Search Kernel platform documentation for guides, tutorials, and API references. Use when you need to understand how Kernel features work or troubleshoot issues.",
    {
      query: z
        .string()
        .describe(
          'Natural language search query (e.g., "how to deploy an app", "browser automation examples").',
        ),
    },
    async ({ query }, extra) => {
      if (
        !process.env.MINTLIFY_ASSISTANT_API_TOKEN ||
        !process.env.MINTLIFY_DOMAIN
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Documentation search is not configured (missing MINTLIFY_ASSISTANT_API_TOKEN or MINTLIFY_DOMAIN).",
            },
          ],
        };
      }

      try {
        const searchResponse = await fetch(
          `https://api-dsc.mintlify.com/v1/search/${process.env.MINTLIFY_DOMAIN}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.MINTLIFY_ASSISTANT_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, pageSize: 10 }),
          },
        );

        if (!searchResponse.ok) {
          throw new Error(
            `Search failed: ${searchResponse.status} ${searchResponse.statusText}`,
          );
        }

        const searchResults: MintlifySearchResult[] =
          await searchResponse.json();
        let formatted = "# Documentation Search Results\n\n";

        if (searchResults?.length > 0) {
          searchResults.forEach((result, index) => {
            formatted += `## ${index + 1}. ${result.path}\n\n${result.content}\n\n---\n\n`;
          });
        } else {
          formatted += "No results found for your query.";
        }

        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching documentation: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    },
  );

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

  // manage_profiles -- Setup, list, and delete browser profiles
  server.tool(
    "manage_profiles",
    'Manage browser profiles that persist cookies, logins, and session data across browser sessions. Use action "setup" to create/update a profile with a guided live browser session, "list" to see all profiles, or "delete" to remove one.',
    {
      action: z
        .enum(["setup", "list", "delete"])
        .describe("Operation to perform."),
      profile_name: z
        .string()
        .describe(
          "(setup, delete) Profile name. For setup: 1-255 chars. For delete: name of profile to remove.",
        )
        .optional(),
      profile_id: z
        .string()
        .describe("(delete) Profile ID to delete. Alternative to profile_name.")
        .optional(),
      update_existing: z
        .boolean()
        .describe("(setup) If true, update existing profile. Default false.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "setup": {
            if (!params.profile_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: profile_name is required for setup.",
                  },
                ],
              };
            const existingProfiles = await client.profiles.list();
            const existingProfile = existingProfiles?.find(
              (p) => p.name === params.profile_name,
            );
            let profile;
            let isNewProfile = false;

            if (existingProfile) {
              if (!params.update_existing) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Profile "${params.profile_name}" already exists (ID: ${existingProfile.id}). Set update_existing: true to update it, or choose a different name.`,
                    },
                  ],
                };
              }
              profile = existingProfile;
            } else {
              profile = await client.profiles.create({
                name: params.profile_name,
              });
              isNewProfile = true;
            }

            const browser = await client.browsers.create({
              stealth: true,
              timeout_seconds: 300,
              profile: { name: params.profile_name, save_changes: true },
            });

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Profile "${params.profile_name}" ${isNewProfile ? "created" : "loaded for update"}.\n\n` +
                    `**Setup:** Open ${browser.browser_live_view_url} and sign into accounts to save.\n` +
                    `**When done:** Use manage_browsers with action "delete" and session_id "${browser.session_id}" to save the profile.\n\n` +
                    `Profile ID: ${profile.id} | Session ID: ${browser.session_id}`,
                },
              ],
            };
          }
          case "list": {
            const profiles = await client.profiles.list();
            return {
              content: [
                {
                  type: "text",
                  text:
                    profiles?.length > 0
                      ? JSON.stringify(profiles, null, 2)
                      : "No profiles found. Use manage_profiles with action 'setup' to create one.",
                },
              ],
            };
          }
          case "delete": {
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
            const identifier = params.profile_name || params.profile_id;
            if (!identifier)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: profile_name or profile_id is required for delete.",
                  },
                ],
              };
            await client.profiles.delete(identifier);
            return {
              content: [
                {
                  type: "text",
                  text: `Profile "${identifier}" deleted successfully.`,
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_profiles (${params.action}): ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // manage_browser_pools -- Create, list, get, delete, flush, acquire, and release browser pools
  server.tool(
    "manage_browser_pools",
    'Manage pools of pre-warmed browser instances for fast acquisition. Use "create" to set up a pool, "list"/"get" to inspect pools, "acquire" to get a browser from a pool, "release" to return it, "flush" to destroy idle browsers, or "delete" to remove a pool.',
    {
      action: z
        .enum([
          "create",
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
          "Pool ID or name. Required for get/delete/flush/acquire/release.",
        )
        .optional(),
      size: z
        .number()
        .describe("(create) Number of browsers to maintain in the pool.")
        .optional(),
      name: z.string().describe("(create) Unique pool name.").optional(),
      headless: z
        .boolean()
        .describe("(create) Headless mode for pool browsers.")
        .optional(),
      stealth: z
        .boolean()
        .describe("(create) Stealth mode for pool browsers.")
        .optional(),
      timeout_seconds: z
        .number()
        .describe("(create) Idle timeout for acquired browsers. Default 600.")
        .optional(),
      profile_name: z
        .string()
        .describe("(create) Profile to load into pool browsers.")
        .optional(),
      proxy_id: z
        .string()
        .describe("(create) Proxy for pool browsers.")
        .optional(),
      fill_rate_per_minute: z
        .number()
        .describe("(create) Pool fill rate percentage per minute. Default 10%.")
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
            if (params.size === undefined)
              return {
                content: [
                  { type: "text", text: "Error: size is required for create." },
                ],
              };
            const pool = await client.browserPools.create({
              size: params.size,
              ...(params.name && { name: params.name }),
              ...(params.headless !== undefined && {
                headless: params.headless,
              }),
              ...(params.stealth !== undefined && { stealth: params.stealth }),
              ...(params.timeout_seconds !== undefined && {
                timeout_seconds: params.timeout_seconds,
              }),
              ...(params.profile_name && {
                profile: { name: params.profile_name },
              }),
              ...(params.proxy_id && { proxy_id: params.proxy_id }),
              ...(params.fill_rate_per_minute !== undefined && {
                fill_rate_per_minute: params.fill_rate_per_minute,
              }),
            });
            return {
              content: [{ type: "text", text: JSON.stringify(pool, null, 2) }],
            };
          }
          case "list": {
            const pools = await client.browserPools.list();
            return {
              content: [
                {
                  type: "text",
                  text:
                    pools?.length > 0
                      ? JSON.stringify(pools, null, 2)
                      : "No browser pools found",
                },
              ],
            };
          }
          case "get": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for get.",
                  },
                ],
              };
            const pool = await client.browserPools.retrieve(params.id_or_name);
            return {
              content: [{ type: "text", text: JSON.stringify(pool, null, 2) }],
            };
          }
          case "delete": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for delete.",
                  },
                ],
              };
            await client.browserPools.delete(params.id_or_name, {
              ...(params.force !== undefined && { force: params.force }),
            });
            return {
              content: [
                { type: "text", text: "Browser pool deleted successfully" },
              ],
            };
          }
          case "flush": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for flush.",
                  },
                ],
              };
            await client.browserPools.flush(params.id_or_name);
            return {
              content: [
                {
                  type: "text",
                  text: "Pool flushed successfully. All idle browsers destroyed.",
                },
              ],
            };
          }
          case "acquire": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for acquire.",
                  },
                ],
              };
            const browser = await client.browserPools.acquire(
              params.id_or_name,
              {
                ...(params.acquire_timeout_seconds !== undefined && {
                  acquire_timeout_seconds: params.acquire_timeout_seconds,
                }),
              },
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(browser, null, 2) },
              ],
            };
          }
          case "release": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for release.",
                  },
                ],
              };
            if (!params.session_id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: session_id is required for release.",
                  },
                ],
              };
            await client.browserPools.release(params.id_or_name, {
              session_id: params.session_id,
              ...(params.reuse !== undefined && { reuse: params.reuse }),
            });
            return {
              content: [
                {
                  type: "text",
                  text: "Browser released back to pool successfully",
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_browser_pools (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );

  // manage_proxies -- Create, list, and delete proxy configurations
  server.tool(
    "manage_proxies",
    'Manage proxy configurations for routing browser traffic. Use "create" to add a proxy, "list" to see all proxies, or "delete" to remove one. Proxy quality for bot detection avoidance, best to worst: mobile > residential > ISP > datacenter.',
    {
      action: z
        .enum(["create", "list", "delete"])
        .describe("Operation to perform."),
      proxy_id: z.string().describe("(delete) Proxy ID to delete.").optional(),
      type: z
        .enum(["datacenter", "isp", "residential", "mobile", "custom"])
        .describe("(create) Proxy type.")
        .optional(),
      name: z
        .string()
        .describe("(create) Readable name for the proxy.")
        .optional(),
      country: z
        .string()
        .describe("(create) ISO 3166 country code (e.g., 'US').")
        .optional(),
      city: z
        .string()
        .describe(
          "(create) City name without spaces (e.g., 'sanfrancisco'). Requires country.",
        )
        .optional(),
      state: z.string().describe("(create) Two-letter state code.").optional(),
      custom_host: z
        .string()
        .describe("(create, custom type) Proxy host address.")
        .optional(),
      custom_port: z
        .number()
        .describe("(create, custom type) Proxy port.")
        .optional(),
      custom_username: z
        .string()
        .describe("(create, custom type) Auth username.")
        .optional(),
      custom_password: z
        .string()
        .describe("(create, custom type) Auth password.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
            if (!params.type)
              return {
                content: [
                  { type: "text", text: "Error: type is required for create." },
                ],
              };
            if (
              params.type === "custom" &&
              (!params.custom_host || !params.custom_port)
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: custom_host and custom_port are required for custom proxy type.",
                  },
                ],
              };
            }
            const createParams: Parameters<typeof client.proxies.create>[0] =
              params.type === "custom"
                ? {
                    type: params.type,
                    ...(params.name && { name: params.name }),
                    config: {
                      host: params.custom_host!,
                      port: params.custom_port!,
                      ...(params.custom_username && {
                        username: params.custom_username,
                      }),
                      ...(params.custom_password && {
                        password: params.custom_password,
                      }),
                    },
                  }
                : {
                    type: params.type,
                    ...(params.name && { name: params.name }),
                    ...((params.country || params.city || params.state) && {
                      config: {
                        ...(params.country && { country: params.country }),
                        ...(params.city && { city: params.city }),
                        ...(params.state && { state: params.state }),
                      },
                    }),
                  };
            const proxy = await client.proxies.create(createParams);
            return {
              content: [{ type: "text", text: JSON.stringify(proxy, null, 2) }],
            };
          }
          case "list": {
            const proxies = await client.proxies.list();
            return {
              content: [
                {
                  type: "text",
                  text:
                    proxies?.length > 0
                      ? JSON.stringify(proxies, null, 2)
                      : "No proxies found",
                },
              ],
            };
          }
          case "delete": {
            if (!params.proxy_id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: proxy_id is required for delete.",
                  },
                ],
              };
            await client.proxies.delete(params.proxy_id);
            return {
              content: [{ type: "text", text: "Proxy deleted successfully" }],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_proxies (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );

  // manage_extensions -- List and delete browser extensions
  server.tool(
    "manage_extensions",
    'Manage browser extensions uploaded to your organization. Use "list" to see all extensions or "delete" to remove one.',
    {
      action: z.enum(["list", "delete"]).describe("Operation to perform."),
      id_or_name: z
        .string()
        .describe("(delete) Extension ID or name to delete.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const extensions = await client.extensions.list();
            return {
              content: [
                {
                  type: "text",
                  text:
                    extensions?.length > 0
                      ? JSON.stringify(extensions, null, 2)
                      : "No extensions found",
                },
              ],
            };
          }
          case "delete": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for delete.",
                  },
                ],
              };
            await client.extensions.delete(params.id_or_name);
            return {
              content: [
                { type: "text", text: "Extension deleted successfully" },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_extensions (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );

  // manage_apps -- List apps, invoke actions, manage deployments, check invocations
  server.tool(
    "manage_apps",
    'Manage Kernel apps, deployments, and invocations. Use "list_apps" to discover apps, "invoke" to execute an app action, "get_deployment"/"list_deployments" to check deployment status, or "get_invocation" to check action results.',
    {
      action: z
        .enum([
          "list_apps",
          "invoke",
          "get_deployment",
          "list_deployments",
          "get_invocation",
        ])
        .describe("Operation to perform."),
      app_name: z
        .string()
        .describe(
          "(list_apps, invoke, list_deployments) App name filter or target.",
        )
        .optional(),
      version: z
        .string()
        .describe(
          "(list_apps, invoke) App version filter. Defaults to 'latest' for invoke.",
        )
        .optional(),
      action_name: z
        .string()
        .describe("(invoke) Action to execute within the app.")
        .optional(),
      payload: z
        .string()
        .describe("(invoke) JSON string with action parameters.")
        .optional(),
      deployment_id: z
        .string()
        .describe("(get_deployment) Deployment ID to retrieve.")
        .optional(),
      invocation_id: z
        .string()
        .describe("(get_invocation) Invocation ID to retrieve.")
        .optional(),
      limit: z
        .number()
        .describe("(list_apps, list_deployments) Max results. Default 50.")
        .optional(),
      offset: z
        .number()
        .describe("(list_apps, list_deployments) Pagination offset. Default 0.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list_apps": {
            const page = await client.apps.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.version && { version: params.version }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page.getPaginatedItems();
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
                      : "No apps found",
                },
              ],
            };
          }
          case "invoke": {
            if (!params.app_name || !params.action_name) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: app_name and action_name are required for invoke.",
                  },
                ],
              };
            }
            const invocation = await client.invocations.create({
              app_name: params.app_name,
              action_name: params.action_name,
              payload: params.payload,
              version: params.version ?? "latest",
              async: true,
            });
            if (!invocation) throw new Error("Failed to create invocation");

            const stream = await client.invocations.follow(invocation.id);
            let finalInvocation = invocation;
            for await (const evt of stream) {
              if (evt.event === "error") {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          status: "error",
                          invocation_id: invocation.id,
                          error: evt,
                        },
                        null,
                        2,
                      ),
                    },
                  ],
                };
              }
              if (evt.event === "invocation_state") {
                finalInvocation = evt.invocation || finalInvocation;
                if (
                  finalInvocation.status === "succeeded" ||
                  finalInvocation.status === "failed"
                )
                  break;
              }
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(finalInvocation, null, 2),
                },
              ],
            };
          }
          case "get_deployment": {
            if (!params.deployment_id)
              return {
                content: [
                  { type: "text", text: "Error: deployment_id is required." },
                ],
              };
            const deployment = await client.deployments.retrieve(
              params.deployment_id,
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(deployment, null, 2) },
              ],
            };
          }
          case "list_deployments": {
            const page = await client.deployments.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page.getPaginatedItems();
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
                      : "No deployments found",
                },
              ],
            };
          }
          case "get_invocation": {
            if (!params.invocation_id)
              return {
                content: [
                  { type: "text", text: "Error: invocation_id is required." },
                ],
              };
            const invocation = await client.invocations.retrieve(
              params.invocation_id,
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(invocation, null, 2) },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_apps (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );

  // computer_action -- Mouse, keyboard, and screenshot controls for browser sessions
  server.tool(
    "computer_action",
    'Interact with a browser session at the OS level. Actions: "click" (mouse click), "type" (type text), "press_key" (keyboard keys/combos), "scroll" (mouse wheel), "move" (move cursor), "get_position" (cursor position), "screenshot" (capture page image).',
    {
      session_id: z.string().describe("Browser session ID."),
      action: z
        .enum([
          "click",
          "type",
          "press_key",
          "scroll",
          "move",
          "get_position",
          "screenshot",
        ])
        .describe("Action to perform."),
      x: z
        .number()
        .describe("(click, scroll, move, screenshot region) X coordinate.")
        .optional(),
      y: z
        .number()
        .describe("(click, scroll, move, screenshot region) Y coordinate.")
        .optional(),
      text: z.string().describe("(type) Text to type.").optional(),
      keys: z
        .array(z.string())
        .describe(
          '(press_key) Keys to press. X11 keysym names or combos like "Ctrl+t", "Return".',
        )
        .optional(),
      button: z
        .enum(["left", "right", "middle"])
        .describe("(click) Mouse button. Default left.")
        .optional(),
      num_clicks: z
        .number()
        .describe("(click) Click count (2 for double-click). Default 1.")
        .optional(),
      hold_keys: z
        .array(z.string())
        .describe("(click, press_key) Modifier keys to hold.")
        .optional(),
      delay: z
        .number()
        .describe("(type) Delay in ms between keystrokes.")
        .optional(),
      duration: z
        .number()
        .describe("(press_key) Hold duration in ms. Omit to tap.")
        .optional(),
      delta_x: z
        .number()
        .describe("(scroll) Horizontal scroll. Positive=right, negative=left.")
        .optional(),
      delta_y: z
        .number()
        .describe("(scroll) Vertical scroll. Positive=down, negative=up.")
        .optional(),
      width: z
        .number()
        .describe("(screenshot) Region capture width. Requires x, y, height.")
        .optional(),
      height: z
        .number()
        .describe("(screenshot) Region capture height. Requires x, y, width.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "click": {
            if (params.x === undefined || params.y === undefined)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: x and y are required for click.",
                  },
                ],
              };
            await client.browsers.computer.clickMouse(params.session_id, {
              x: params.x,
              y: params.y,
              ...(params.button && { button: params.button }),
              ...(params.num_clicks !== undefined && {
                num_clicks: params.num_clicks,
              }),
              ...(params.hold_keys && { hold_keys: params.hold_keys }),
            });
            return {
              content: [
                { type: "text", text: `Clicked at (${params.x}, ${params.y})` },
              ],
            };
          }
          case "type": {
            if (!params.text)
              return {
                content: [
                  { type: "text", text: "Error: text is required for type." },
                ],
              };
            await client.browsers.computer.typeText(params.session_id, {
              text: params.text,
              ...(params.delay !== undefined && { delay: params.delay }),
            });
            return {
              content: [{ type: "text", text: `Typed: "${params.text}"` }],
            };
          }
          case "press_key": {
            if (!params.keys?.length)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: keys is required for press_key.",
                  },
                ],
              };
            await client.browsers.computer.pressKey(params.session_id, {
              keys: params.keys,
              ...(params.hold_keys && { hold_keys: params.hold_keys }),
              ...(params.duration !== undefined && {
                duration: params.duration,
              }),
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Pressed keys: ${params.keys.join(", ")}`,
                },
              ],
            };
          }
          case "scroll": {
            if (params.x === undefined || params.y === undefined)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: x and y are required for scroll.",
                  },
                ],
              };
            await client.browsers.computer.scroll(params.session_id, {
              x: params.x,
              y: params.y,
              ...(params.delta_x !== undefined && { delta_x: params.delta_x }),
              ...(params.delta_y !== undefined && { delta_y: params.delta_y }),
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Scrolled at (${params.x}, ${params.y})`,
                },
              ],
            };
          }
          case "move": {
            if (params.x === undefined || params.y === undefined)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: x and y are required for move.",
                  },
                ],
              };
            await client.browsers.computer.moveMouse(params.session_id, {
              x: params.x,
              y: params.y,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Moved mouse to (${params.x}, ${params.y})`,
                },
              ],
            };
          }
          case "get_position": {
            const position = await client.browsers.computer.getMousePosition(
              params.session_id,
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(position, null, 2) },
              ],
            };
          }
          case "screenshot": {
            const hasAnyRegion =
              params.x !== undefined ||
              params.y !== undefined ||
              params.width !== undefined ||
              params.height !== undefined;
            const hasRegion =
              params.x !== undefined &&
              params.y !== undefined &&
              params.width !== undefined &&
              params.height !== undefined;
            if (hasAnyRegion && !hasRegion) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: When specifying a region, all four parameters (x, y, width, height) must be provided.",
                  },
                ],
              };
            }
            const screenshotOpts = hasRegion
              ? {
                  region: {
                    x: params.x!,
                    y: params.y!,
                    width: params.width!,
                    height: params.height!,
                  },
                }
              : undefined;
            const [screenshotResponse, browserInfo] = await Promise.all([
              client.browsers.computer.captureScreenshot(
                params.session_id,
                screenshotOpts,
              ),
              client.browsers.retrieve(params.session_id),
            ]);
            const blob = await screenshotResponse.blob();
            const buffer = Buffer.from(await blob.arrayBuffer());
            const viewport = browserInfo.viewport;
            return {
              content: [
                {
                  type: "text",
                  text: viewport
                    ? `Viewport: ${viewport.width}x${viewport.height}. Use these dimensions as the coordinate space for click, scroll, and move actions.`
                    : "Could not determine viewport dimensions. Use manage_browsers with action 'get' to check the browser's viewport before clicking.",
                },
                {
                  type: "image",
                  data: buffer.toString("base64"),
                  mimeType: "image/png",
                },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in computer_action (${params.action}): ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // exec_command -- Execute shell commands inside a browser VM
  server.tool(
    "exec_command",
    'Execute a command synchronously inside a browser VM. Returns stdout, stderr, and exit code. The command field is the executable; use args for its arguments. Common uses: read files (command: "cat", args: ["/var/log/supervisord.log"]), list dirs (command: "ls", args: ["/var/log"]), check DNS (command: "cat", args: ["/etc/resolv.conf"]), test connectivity (command: "curl", args: ["-I", "https://example.com"]).',
    {
      session_id: z.string().describe("Browser session ID."),
      command: z
        .string()
        .describe("Executable to run (e.g., 'cat', 'ls', 'curl')."),
      args: z
        .array(z.string())
        .describe("Arguments to pass to the command.")
        .optional(),
      cwd: z.string().describe("Working directory (absolute path).").optional(),
      timeout_sec: z
        .number()
        .describe("Max execution time in seconds.")
        .optional(),
      as_root: z.boolean().describe("Run with root privileges.").optional(),
    },
    async ({ session_id, command, args, cwd, timeout_sec, as_root }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const result = await client.browsers.process.exec(session_id, {
          command,
          ...(args && { args }),
          ...(cwd && { cwd }),
          ...(timeout_sec !== undefined && { timeout_sec }),
          ...(as_root !== undefined && { as_root }),
        });

        const stdout = result.stdout_b64
          ? Buffer.from(result.stdout_b64, "base64").toString("utf-8")
          : "";
        const stderr = result.stderr_b64
          ? Buffer.from(result.stderr_b64, "base64").toString("utf-8")
          : "";

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  exit_code: result.exit_code,
                  duration_ms: result.duration_ms,
                  stdout,
                  stderr,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error executing command: ${error}` },
          ],
        };
      }
    },
  );

  // execute_playwright_code -- Run Playwright/TypeScript code against a browser
  server.tool(
    "execute_playwright_code",
    'Execute Playwright/TypeScript automation code against a Kernel browser session. If session_id is provided, uses that existing browser; otherwise creates a new one. Returns the result with a video replay URL. Auto-cleans up browsers it creates. Use computer_action with action "screenshot" instead of page.screenshot() in code.',
    {
      code: z
        .string()
        .describe(
          'Playwright/TypeScript code with a `page` object in scope. Example: "await page.goto(\\"https://example.com\\"); return await page.title();" Tip: Use `await page._snapshotForAI()` for a comprehensive page state snapshot.',
        ),
      session_id: z
        .string()
        .describe(
          "Existing browser session ID. If omitted, a new browser is created and cleaned up after execution.",
        )
        .optional(),
    },
    async ({ code, session_id }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);
      let kernelBrowser;
      let replay;
      const shouldCleanup = !session_id;

      try {
        if (!code || typeof code !== "string")
          throw new Error("code is required and must be a string");

        if (session_id) {
          kernelBrowser = await client.browsers.retrieve(session_id);
          if (!kernelBrowser)
            throw new Error(`Browser session "${session_id}" not found`);
        } else {
          kernelBrowser = await client.browsers.create({ stealth: true });
          if (!kernelBrowser?.session_id)
            throw new Error("Failed to create browser session");
        }

        try {
          replay = await client.browsers.replays.start(
            kernelBrowser.session_id,
          );
        } catch {
          replay = null;
        }

        const response = await client.browsers.playwright.execute(
          kernelBrowser.session_id,
          { code },
        );

        let replayUrl = null;
        if (replay && kernelBrowser?.session_id) {
          try {
            await client.browsers.replays.stop(replay.replay_id, {
              id: kernelBrowser.session_id,
            });
            replayUrl = replay.replay_view_url;
          } catch {}
        }

        if (shouldCleanup && kernelBrowser?.session_id) {
          await client.browsers.deleteByID(kernelBrowser.session_id);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: response.success,
                  result: response.result,
                  error: response.error,
                  stdout: response.stdout,
                  stderr: response.stderr,
                  replay_url: replayUrl,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        let replayUrl = null;
        if (replay && kernelBrowser?.session_id) {
          try {
            await client.browsers.replays.stop(replay.replay_id, {
              id: kernelBrowser.session_id,
            });
            replayUrl = replay.replay_view_url;
          } catch {}
        }
        try {
          if (shouldCleanup && kernelBrowser?.session_id)
            await client.browsers.deleteByID(kernelBrowser.session_id);
        } catch {}

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  replay_url: replayUrl,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
});

async function handleAuthenticatedRequest(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7).trim()
    : null;
  if (!token) {
    return createAuthErrorResponse(
      "invalid_token",
      "Missing or invalid access token",
    );
  }

  if (!isValidJwtFormat(token)) {
    const authHandler = withMcpAuth(
      handler,
      async () => ({
        token,
        scopes: ["apikey"],
        clientId: "mcp-server",
        extra: { userId: null, clerkToken: null },
      }),
      {
        required: true,
        resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
      },
    );
    return await authHandler(req);
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    if (!payload.sub) {
      return createAuthErrorResponse(
        "invalid_token",
        "Invalid token: No user ID found in token payload",
      );
    }

    // Create authenticated handler with auth info
    const authHandler = withMcpAuth(
      handler,
      async (_req, _providedToken) => {
        // Return auth info with validated user data
        return {
          token: token, // Use the validated token
          scopes: ["openid"],
          clientId: "mcp-server",
          extra: {
            userId: payload.sub,
            clerkToken: token,
          },
        };
      },
      {
        required: true,
        resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
      },
    );

    return await authHandler(req);
  } catch (authError) {
    return createAuthErrorResponse(
      "invalid_token",
      `Invalid token: ${authError instanceof Error ? authError.message : "Authentication failed"}`,
    );
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return await handleAuthenticatedRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return await handleAuthenticatedRequest(req);
}
