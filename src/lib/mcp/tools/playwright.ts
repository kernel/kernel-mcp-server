import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerPlaywrightTool(server: McpServer) {
  // execute_playwright_code -- Run Playwright/TypeScript code against a browser
  server.tool(
    "execute_playwright_code",
    'Execute Playwright/TypeScript automation code against an existing Kernel browser session. Does not create or delete browsers -- use manage_browsers to manage session lifecycle. Use computer_action with action "screenshot" instead of page.screenshot() in code.',
    {
      code: z
        .string()
        .describe(
          'Playwright/TypeScript code with a `page` object in scope. Example: "await page.goto(\\"https://example.com\\"); return await page.title();" Tip: Use `await page._snapshotForAI()` for a comprehensive page state snapshot.',
        ),
      session_id: z
        .string()
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
