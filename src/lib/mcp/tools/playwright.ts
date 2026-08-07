import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { throwToolError } from "@/lib/mcp/responses";

// The browser VM's own default script timeout. Our request has to outlast it, or the
// transport gives up while the script is still running.
const SCRIPT_BUDGET_SEC = 60;

export function registerPlaywrightTool(server: McpServer) {
  // execute_playwright_code -- Run Playwright/TypeScript code against a browser
  server.tool(
    "execute_playwright_code",
    "Execute Playwright/TypeScript automation code against an existing Kernel browser session. Does not create or delete browsers -- use manage_browsers to manage session lifecycle.",
    {
      code: z
        .string()
        .describe(
          'Playwright/TypeScript code with `page`, `context`, and `browser` objects in scope; the value you `return` is sent back. Example: `await page.goto(\'https://example.com\'); return await page.title();` Return only what you need — prefer a targeted selector (e.g. `await page.locator(\'h1\').innerText()`) or a region-scoped snapshot (e.g. `await page.locator(\'main\').ariaSnapshot()`) rather than dumping the whole page.',
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

        const response = await client.browsers.playwright.execute(
          session_id,
          { code },
          longOperationOptions(SCRIPT_BUDGET_SEC),
        );

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
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        // No normal API response came back -- the session was gone, unleased, the request
        // was rejected, or it timed out. Distinct from code that ran and threw, which comes
        // back as a 200 with success: false so the agent can read the failure and adjust.
        throwToolError("execute_playwright_code", "execute", error);
      }
    },
  );
}
