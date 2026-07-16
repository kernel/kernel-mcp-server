import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TELEMETRY_EVENT_CATALOG } from "@/lib/mcp/telemetry";

export function registerKernelPrompts(server: McpServer) {
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

**MCP Exceptions:** The \`computer_action\` MCP tool with action "screenshot" is useful since it returns images directly to the agent, and \`manage_browsers\` with action "get_telemetry" reads structured telemetry events (see below).

---

## Telemetry Events (structured signal — works even after the session is deleted)

When telemetry was captured, it's usually the fastest way to pinpoint a failure — read it before reaching for screenshots or logs. If the session has been deleted, it's the only signal still available: every CLI command in this guide needs a live session.

Start broad: call \`manage_browsers\` with action "get_telemetry", session_id "${session_id}", and no filters. That starts at session creation and returns the first page (up to 100 events); page with \`next_offset\` as \`offset\` while \`has_more\` is true, preserving \`categories\`, \`until\`, and \`order\`. An empty unfiltered read is definitive: nothing was archived. Narrow when the output is too large to scan or you already know where to look: \`categories\` to isolate a signal you've spotted, \`order\` "desc" when the end of the session matters most, \`since\`/\`until\` to bracket a known failing step. Correlate event timestamps with the failing automation step.

**Gotcha: telemetry is opt-in and only covers activity that happened while capture was on.** Archived events survive telemetry being disabled and the session being deleted, so the archive — not the current config — is the ground truth: \`manage_browsers\` action "get" showing a null \`telemetry\` field means capture is off now, not that nothing was recorded. The default bundle (control/connection/system/captcha) also omits the debug-critical categories. To capture new evidence on an active browser, use \`manage_browsers\` action "update" to enable \`telemetry_console\`, \`telemetry_network\`, and \`telemetry_page\`, then reproduce the issue; recreate the browser only if the session has ended.

${TELEMETRY_EVENT_CATALOG}

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
- [ ] Telemetry events reviewed (if any were captured)
- [ ] Screenshot shows expected content (or reveals error)
- [ ] Current URL is as expected
- [ ] Supervisor logs show all services running
- [ ] Network connectivity works (curl test)
- [ ] No critical errors in chromium logs
- [ ] Cookies/session state is correct

---

## Next Steps

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
