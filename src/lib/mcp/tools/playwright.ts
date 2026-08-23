import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { throwToolError } from "@/lib/mcp/responses";

// The script budget the browser VM enforces. It is sent explicitly so the deadline the VM
// cancels on and the deadline our request waits for come from one value, and our request
// always outlasts the VM's rather than giving up while the script is still running.
const SCRIPT_BUDGET_SEC = 60;

export function registerPlaywrightTool(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  // execute_playwright_code -- Run Playwright/TypeScript code against a browser
  server.tool(
    "execute_playwright_code",
    "Execute Playwright/TypeScript automation code against an existing Kernel browser session. Does not create or delete browsers -- use manage_browsers to manage session lifecycle.",
    {
      ...projectSelectionInputSchema(),
      code: z
        .string()
        .describe(
          "Playwright/TypeScript code with `page`, `context`, and `browser` objects in scope; the value you `return` is sent back. Every invocation should return useful page state. After navigation or interaction, return a condensed accessibility snapshot of the relevant region, e.g. `await page.goto('https://example.com'); return await page.locator('main').ariaSnapshot();` or `await page.getByRole('button', { name: 'Submit' }).click(); return await page.locator('main').ariaSnapshot();`. For targeted reads, return a compact value or object. Do not dump the full DOM or body text.",
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
    async ({ code, session_id, project, project_id }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = options.createKernelClient(
        extra.authInfo.token,
        projectForOperation(extra.authInfo, { project, project_id }),
      );

      try {
        if (!code || typeof code !== "string")
          throw new Error("code is required and must be a string");

        const response = await client.browsers.playwright.execute(
          session_id,
          { code, timeout_sec: SCRIPT_BUDGET_SEC },
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
