import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerPlaywrightTool(server: McpServer) {
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
}
