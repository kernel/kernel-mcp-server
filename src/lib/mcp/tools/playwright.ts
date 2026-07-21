import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

// Cap per-field output so a single call can't flood the model's context. Whole-page
// reads (innerText/ariaSnapshot on body) routinely run tens to hundreds of KB.
const MAX_FIELD_CHARS = 25_000;

function cap(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= MAX_FIELD_CHARS) return value;
  const dropped = text.length - MAX_FIELD_CHARS;
  return `${text.slice(0, MAX_FIELD_CHARS)}\n\n[output truncated: showing ${MAX_FIELD_CHARS} of ${text.length} chars, ${dropped} dropped. Return a targeted selector instead of a whole-page read.]`;
}

export function registerPlaywrightTool(server: McpServer) {
  // execute_playwright_code -- Run Playwright/TypeScript code against a browser
  server.tool(
    "execute_playwright_code",
    "Execute Playwright/TypeScript automation code against an existing Kernel browser session. Does not create or delete browsers -- use manage_browsers to manage session lifecycle.",
    {
      code: z
        .string()
        .describe(
          [
            'Playwright/TypeScript code with a `page` object in scope. Example: "await page.goto(\\"https://example.com\\"); return await page.title();"',
            "Return only what you need, and orient before you extract — work broad-and-cheap to narrow-and-specific so you never dump a whole page:",
            "1. ORIENT (do this first on an unfamiliar page): return a small overview, e.g. `return { url: page.url(), title: await page.title(), headings: await page.locator('h1,h2,h3').allInnerTexts() }`. For a structural map, evaluateAll over landmarks and return each region's role + accessible name + control count (not its text), e.g. `return await page.locator('main,nav,header,footer,aside,section,form').evaluateAll(els => els.map(e => ({ region: e.getAttribute('role') || e.tagName.toLowerCase(), label: (e.getAttribute('aria-label') || e.querySelector('h1,h2,h3')?.textContent || '').trim().slice(0,60), controls: e.querySelectorAll('a,button,input,select,textarea').length })))`.",
            "2. SCOPE: pick the one region that matters, then `await page.locator(SELECTOR).ariaSnapshot()` for its interactive tree.",
            "3. EXTRACT: pull the value with a targeted locator, e.g. `await page.locator(SELECTOR).innerText()`.",
            "Do NOT call `innerText()` or `ariaSnapshot()` on `body` — whole-page reads are large and get truncated.",
          ].join(" "),
        ),
      session_id: z
        .string()
        .min(1, "session_id is required")
        .describe("Browser session ID to execute the code against."),
    },
    {
      title: "Execute Playwright code",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ code, session_id }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        if (!code || typeof code !== "string")
          throw new Error("code is required and must be a string");

        const response = await client.browsers.playwright.execute(session_id, {
          code,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: response.success,
                  result: cap(response.result),
                  error: cap(response.error),
                  stdout: cap(response.stdout),
                  stderr: cap(response.stderr),
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
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
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
}
