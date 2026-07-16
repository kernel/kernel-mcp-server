import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerPlaywrightTool(server: McpServer) {
  // execute_playwright_code -- Run Playwright/TypeScript code against a browser
  server.tool(
    "execute_playwright_code",
    'Execute Playwright/TypeScript automation code against a Kernel browser session. If session_id is provided, uses that existing browser; otherwise creates a new one. Auto-cleans up browsers it creates. Use computer_action with action "screenshot" instead of page.screenshot() in code.',
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
      const shouldCleanup = !session_id;
      let activeSessionId = session_id;

      try {
        if (!code || typeof code !== "string")
          throw new Error("code is required and must be a string");

        if (!activeSessionId) {
          const created = await client.browsers.create({ stealth: true });
          if (!created?.session_id)
            throw new Error("Failed to create browser session");
          activeSessionId = created.session_id;
        }

        const response = await client.browsers.playwright.execute(
          activeSessionId,
          { code },
        );

        if (shouldCleanup) {
          await client.browsers.deleteByID(activeSessionId);
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
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        try {
          if (shouldCleanup && activeSessionId)
            await client.browsers.deleteByID(activeSessionId);
        } catch {}

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
