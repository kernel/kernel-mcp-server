import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TELEMETRY_EVENT_CATALOG } from "@/lib/mcp/telemetry";

export function registerKernelPrompts(server: McpServer) {
  server.registerPrompt(
    "kernel-concepts",
    {
      description:
        "explain KERNEL browsers and apps for agents that interact with websites",
      argsSchema: z.object({
        concept: z
          .enum(["browsers", "apps", "overview"])
          .describe(
            "the concept to explain: browsers (sessions), apps (code execution), or overview (both)",
          ),
      }),
    },
    async ({ concept }) => {
      const explanations = {
        browsers: `## browsers

KERNEL runs cloud browsers in isolated environments. create a session when your agent needs to interact with a website.

- **browser control:** connect over cdp with playwright, puppeteer, or another compatible client.
- **live view:** watch a headful session while it runs.
- **replays:** record a session and review it later.
- **profiles:** reuse saved browser state across sessions.
- **session timeout:** configure when an inactive session ends, up to 72 hours.

use browsers for workflows that require a real browser, such as testing a web app or completing a form. delete sessions when they are no longer needed.`,

        apps: `## apps

KERNEL apps run code that you deploy and invoke through the api or mcp tools. an app can create and control browsers as part of a longer workflow.

1. write the code for your workflow.
2. deploy the app.
3. invoke it with the input it needs.
4. inspect its execution and results.

use apps when browser work needs to run without a persistent local process.`,

        overview: `## KERNEL overview

KERNEL provides cloud browsers and a way to run code that uses them.

- **browsers:** create an isolated browser session, connect over cdp, use live view or replays, and save browser state in a profile.
- **apps:** deploy code that creates or controls browsers, then invoke it through the api or mcp tools.

use a browser session for direct website interaction. use an app when you need to deploy and invoke a repeatable workflow.`,
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
  server.registerPrompt(
    "debug-browser-session",
    {
      description:
        "diagnose KERNEL browser session issues using telemetry, browser state, and logs.",
      argsSchema: z.object({
        session_id: z
          .string()
          .describe(
            "the browser session id or name to debug (e.g., 'abc123example456xyz' or 'checkout-flow'). a name resolves only a live session; if the session was deleted, pass its id so telemetry can still be read.",
          ),
        issue_description: z
          .string()
          .describe(
            "description of the issue you're experiencing (e.g., 'ERR_HTTP2_PROTOCOL_ERROR when navigating to a specific site', 'browser not responding', 'page not loading')",
          ),
      }),
    },
    async ({ session_id, issue_description }) => {
      const debugGuide = `# browser session debugging guide

**session id:** \`${session_id}\`
**reported issue:** ${issue_description}

---

## tools

**use the KERNEL cli for debugging.** it provides full access to browser sessions, vm logs, and process execution.

install: \`brew install onkernel/tap/kernel\` or \`npm install -g @onkernel/cli\`

**explore available commands recursively:**
\`\`\`bash
kernel --help
kernel browsers --help
kernel browsers fs --help
kernel browsers process --help
kernel browsers playwright --help
\`\`\`

**mcp exceptions:** the \`computer_action\` mcp tool with action "screenshot" is useful since it returns images directly to the agent, and \`manage_browsers\` with action "get_telemetry" reads structured telemetry events (see below).

---

## telemetry events (structured signal — works even after the session is deleted)

when telemetry was captured, it's usually the fastest way to pinpoint a failure — read it before reaching for screenshots or logs. if the session has been deleted, it's the only signal still available: every cli command in this guide needs a live session. a deleted session must be addressed by its id; its name no longer resolves.

start broad: call \`manage_browsers\` with action "get_telemetry", session_id "${session_id}", and no filters. that starts at session creation and returns the first page (up to 100 events); page with \`next_offset\` as \`offset\` while \`has_more\` is true, preserving \`categories\`, \`until\`, and \`order\`. an empty unfiltered read is definitive: nothing was archived. narrow when the output is too large to scan or you already know where to look: \`categories\` to isolate a signal you've spotted, \`order\` "desc" when the end of the session matters most, \`since\`/\`until\` to bracket a known failing step. correlate event timestamps with the failing automation step.

**gotcha: telemetry is opt-in and only covers activity that happened while capture was on.** archived events survive telemetry being disabled and the session being deleted, so the archive — not the current config — is the ground truth: \`manage_browsers\` action "get" showing no enabled \`telemetry\` categories means capture is off now, not that nothing was recorded. the default bundle (control/connection/system/captcha) also omits the debug-critical categories. to capture new evidence on an active browser, use \`manage_browsers\` action "update" to enable \`telemetry_console\`, \`telemetry_network\`, and \`telemetry_page\`, then reproduce the issue; recreate the browser only if the session has ended.

${TELEMETRY_EVENT_CATALOG}

---

## key cli commands for debugging

### check session status
\`\`\`bash
kernel browsers get ${session_id}
\`\`\`

### take a screenshot (or use mcp computer_action with action "screenshot")
\`\`\`bash
kernel browsers screenshot ${session_id}
\`\`\`

### execute playwright code
\`\`\`bash
kernel browsers playwright execute ${session_id} "return { url: page.url(), title: await page.title() }"
\`\`\`

### read vm log files
\`\`\`bash
kernel browsers fs read-file ${session_id} --path /var/log/supervisord.log
kernel browsers fs read-file ${session_id} --path /var/log/supervisord/chromium
kernel browsers fs read-file ${session_id} --path /var/log/supervisord/neko
\`\`\`

### list files in the vm
\`\`\`bash
kernel browsers fs ls ${session_id} --path /var/log
\`\`\`

### execute commands inside the vm
\`\`\`bash
kernel browsers process exec ${session_id} -- curl -I https://example.com
kernel browsers process exec ${session_id} -- cat /etc/resolv.conf
\`\`\`

### check cookies via playwright
\`\`\`bash
kernel browsers playwright execute ${session_id} "const cookies = await page.context().cookies(); return { count: cookies.length, domains: [...new Set(cookies.map(c => c.domain))] }"
\`\`\`

---

## common issues and solutions

### network errors (ERR_HTTP2_PROTOCOL_ERROR, ERR_CONNECTION_RESET, etc.)

**access restrictions are a common cause of network errors.** some sites limit automated access.

**signs of an access restriction:**
- curl works from the vm but chrome shows an error
- "Access Denied" or a verification page

**solutions:** confirm the user is authorized to automate the site and that its terms allow it. sign in with the user's own account if they have one.

### browser not responding
**cause:** chrome process crashed or hung
**check:** supervisor logs for chromium restart events
**solutions:**
1. check if timeout was reached
2. look for memory issues in logs
3. create a new browser session

### page not loading
**cause:** network, dns, or proxy issues
**check:**
1. test curl from inside vm
2. check /etc/resolv.conf for dns config
3. verify proxy settings if using one

### live view not working
**cause:** neko/webrtc issues
**check:** neko logs for connection errors
**solutions:**
1. check for firewall blocking webrtc
2. verify browser is not in headless mode

---

## expected log entries (normal operation)

these are **normal** and don't indicate problems:
- \`Failed to call method: org.freedesktop.DBus.Properties.GetAll\` - dbus permission (expected in container)
- \`vkCreateInstance: Found no drivers\` - no gpu in vm (expected)
- \`DEPRECATED_ENDPOINT\` for gcm - google deprecation (harmless)
- \`SharedImageManager::ProduceMemory\` errors - gpu-related (not critical)

---

## debugging checklist

- [ ] session exists and is active
- [ ] telemetry events reviewed (if any were captured)
- [ ] screenshot shows expected content (or reveals error)
- [ ] current url is as expected
- [ ] supervisor logs show all services running
- [ ] network connectivity works (curl test)
- [ ] no critical errors in chromium logs
- [ ] cookies/session state is correct

---

## next steps

based on your issue "${issue_description}", start with:

1. **read telemetry events** — works whether or not the session still exists; if the archive is empty and the session is active, enable the debug categories and reproduce
2. **get browser info** to confirm the session is active before using the cli commands
3. **take screenshot** to see current state
4. **check page url** to see if on error page
5. **test network** if seeing connection errors
6. **review logs** for specific error patterns`;

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
}
