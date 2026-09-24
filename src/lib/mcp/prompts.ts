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
            "The browser session ID or name to debug (e.g., 'abc123example456xyz' or 'checkout-flow'). A name resolves only a live session; if the session was deleted, pass its ID so telemetry can still be read.",
          ),
        issue_description: z
          .string()
          .describe(
            "Description of the issue you're experiencing (e.g., 'ERR_HTTP2_PROTOCOL_ERROR when navigating to a specific site', 'browser not responding', 'page not loading')",
          ),
      }),
    },
    async ({ session_id, issue_description }) => {
      const debugGuide = `# browser session debugging guide

**session id:** \`${session_id}\`
**reported issue:** ${issue_description}

---

## tools

**use the KERNEL cli for debugging.** It provides full access to browser sessions, VM logs, and process execution.

Install: \`brew install onkernel/tap/kernel\` or \`npm install -g @onkernel/cli\`

**explore available commands recursively:**
\`\`\`bash
kernel --help
kernel browsers --help
kernel browsers fs --help
kernel browsers process --help
kernel browsers playwright --help
\`\`\`

**mcp exceptions:** The \`computer_action\` MCP tool with action "screenshot" is useful since it returns images directly to the agent, and \`manage_browsers\` with action "get_telemetry" reads structured telemetry events (see below).

---

## telemetry events (structured signal — works even after the session is deleted)

When telemetry was captured, it's usually the fastest way to pinpoint a failure — read it before reaching for screenshots or logs. If the session has been deleted, it's the only signal still available: every CLI command in this guide needs a live session. A deleted session must be addressed by its ID; its name no longer resolves.

Start broad: call \`manage_browsers\` with action "get_telemetry", session_id "${session_id}", and no filters. That starts at session creation and returns the first page (up to 100 events); page with \`next_offset\` as \`offset\` while \`has_more\` is true, preserving \`categories\`, \`until\`, and \`order\`. An empty unfiltered read is definitive: nothing was archived. Narrow when the output is too large to scan or you already know where to look: \`categories\` to isolate a signal you've spotted, \`order\` "desc" when the end of the session matters most, \`since\`/\`until\` to bracket a known failing step. Correlate event timestamps with the failing automation step.

**Gotcha: telemetry is opt-in and only covers activity that happened while capture was on.** Archived events survive telemetry being disabled and the session being deleted, so the archive — not the current config — is the ground truth: \`manage_browsers\` action "get" showing no enabled \`telemetry\` categories means capture is off now, not that nothing was recorded. The default bundle (control/connection/system/captcha) also omits the debug-critical categories. To capture new evidence on an active browser, use \`manage_browsers\` action "update" to enable \`telemetry_console\`, \`telemetry_network\`, and \`telemetry_page\`, then reproduce the issue; recreate the browser only if the session has ended.

${TELEMETRY_EVENT_CATALOG}

---

## key cli commands for debugging

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

## common issues and solutions

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

## expected log entries (normal operation)

These are **normal** and don't indicate problems:
- \`Failed to call method: org.freedesktop.DBus.Properties.GetAll\` - DBus permission (expected in container)
- \`vkCreateInstance: Found no drivers\` - No GPU in VM (expected)
- \`DEPRECATED_ENDPOINT\` for GCM - Google deprecation (harmless)
- \`SharedImageManager::ProduceMemory\` errors - GPU-related (not critical)

---

## debugging checklist

- [ ] Session exists and is active
- [ ] Telemetry events reviewed (if any were captured)
- [ ] Screenshot shows expected content (or reveals error)
- [ ] Current URL is as expected
- [ ] Supervisor logs show all services running
- [ ] Network connectivity works (curl test)
- [ ] No critical errors in chromium logs
- [ ] Cookies/session state is correct

---

## next steps

Based on your issue "${issue_description}", start with:

1. **Read telemetry events** — works whether or not the session still exists; if the archive is empty and the session is active, enable the debug categories and reproduce
2. **Get browser info** to confirm the session is active before using the CLI commands
3. **Take screenshot** to see current state
4. **Check page URL** to see if on error page
5. **Test network** if seeing connection errors
6. **Review logs** for specific error patterns`;

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
