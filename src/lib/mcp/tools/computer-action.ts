import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerComputerActionTool(server: McpServer) {
  // computer_action -- Execute one or more computer actions on a browser session
  server.tool(
    "computer_action",
    "Execute computer actions on a browser session. Pass a single action for simple operations (e.g. one click or one screenshot), or pass multiple actions to batch them into a single request for lower latency (e.g. click, type, press_key in one call). Use sleep actions between steps when the page needs time to react (e.g. after a click that triggers navigation or animation). IMPORTANT: Always include a screenshot as the last action so you can see the result of your actions. Action types: click_mouse, move_mouse, type_text, press_key, scroll, drag_mouse, set_cursor, sleep, screenshot, get_mouse_position. screenshot and get_mouse_position return data, so they must be the last action if included.",
    {
      session_id: z.string().describe("Browser session ID."),
      actions: z
        .array(
          z.object({
            type: z
              .enum([
                "click_mouse",
                "move_mouse",
                "type_text",
                "press_key",
                "scroll",
                "drag_mouse",
                "set_cursor",
                "sleep",
                "screenshot",
                "get_mouse_position",
              ])
              .describe("Action type."),
            click_mouse: z
              .object({
                x: z.number(),
                y: z.number(),
                button: z.enum(["left", "right", "middle"]).optional(),
                click_type: z.enum(["down", "up", "click"]).optional(),
                num_clicks: z.number().optional(),
                hold_keys: z.array(z.string()).optional(),
              })
              .describe("Params for click_mouse action.")
              .optional(),
            move_mouse: z
              .object({
                x: z.number(),
                y: z.number(),
                hold_keys: z.array(z.string()).optional(),
              })
              .describe("Params for move_mouse action.")
              .optional(),
            type_text: z
              .object({
                text: z.string(),
                delay: z.number().optional(),
              })
              .describe("Params for type_text action.")
              .optional(),
            press_key: z
              .object({
                keys: z
                  .array(z.string())
                  .describe(
                    'X11 keysym names or combos like "Ctrl+t", "Return".',
                  ),
                duration: z.number().optional(),
                hold_keys: z.array(z.string()).optional(),
              })
              .describe("Params for press_key action.")
              .optional(),
            scroll: z
              .object({
                x: z.number(),
                y: z.number(),
                delta_x: z
                  .number()
                  .describe("Positive=right, negative=left.")
                  .optional(),
                delta_y: z
                  .number()
                  .describe("Positive=down, negative=up.")
                  .optional(),
                hold_keys: z.array(z.string()).optional(),
              })
              .describe("Params for scroll action.")
              .optional(),
            drag_mouse: z
              .object({
                path: z
                  .array(z.array(z.number()))
                  .describe("Ordered [x,y] pairs, at least 2 points."),
                button: z.enum(["left", "middle", "right"]).optional(),
                delay: z.number().optional(),
                steps_per_segment: z.number().optional(),
                step_delay_ms: z.number().optional(),
                hold_keys: z.array(z.string()).optional(),
              })
              .describe("Params for drag_mouse action.")
              .optional(),
            set_cursor: z
              .object({
                hidden: z.boolean(),
              })
              .describe("Params for set_cursor action.")
              .optional(),
            sleep: z
              .object({
                duration_ms: z.number(),
              })
              .describe("Params for sleep action.")
              .optional(),
            screenshot: z
              .object({
                region: z
                  .object({
                    x: z.number(),
                    y: z.number(),
                    width: z.number(),
                    height: z.number(),
                  })
                  .optional(),
              })
              .describe(
                "Params for screenshot action. Omit or pass {} for full-page screenshot.",
              )
              .optional(),
          }),
        )
        .describe(
          "Ordered list of actions. Use one action for simple operations or multiple for batched sequences.",
        ),
    },
    async ({ session_id, actions }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const lastAction = actions[actions.length - 1];
        const hasTrailingScreenshot = lastAction?.type === "screenshot";
        const hasTrailingGetPosition =
          lastAction?.type === "get_mouse_position";
        const hasTrailingSpecial =
          hasTrailingScreenshot || hasTrailingGetPosition;

        // Validate: screenshot/get_mouse_position can only be the last action
        for (let i = 0; i < actions.length - 1; i++) {
          if (
            actions[i].type === "screenshot" ||
            actions[i].type === "get_mouse_position"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${actions[i].type} must be the last action in the sequence.`,
                },
              ],
            };
          }
        }

        const batchActions = hasTrailingSpecial
          ? actions.slice(0, -1)
          : actions;

        if (batchActions.length > 0) {
          await client.browsers.computer.batch(session_id, {
            actions: batchActions as Parameters<
              typeof client.browsers.computer.batch
            >[1]["actions"],
          });
        }

        if (hasTrailingScreenshot) {
          const screenshotParams = lastAction.screenshot;
          const screenshotOpts = screenshotParams?.region
            ? { region: screenshotParams.region }
            : undefined;
          const [screenshotResponse, browserInfo] = await Promise.all([
            client.browsers.computer.captureScreenshot(
              session_id,
              screenshotOpts,
            ),
            client.browsers.retrieve(session_id),
          ]);
          const blob = await screenshotResponse.blob();
          const buffer = Buffer.from(await blob.arrayBuffer());
          const viewport = browserInfo.viewport;
          const content: Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
          > = [];
          if (batchActions.length > 0) {
            content.push({
              type: "text",
              text: `Executed ${batchActions.length} action(s), then captured screenshot.`,
            });
          }
          content.push({
            type: "text",
            text: viewport
              ? `Viewport: ${viewport.width}x${viewport.height}. Use these dimensions as the coordinate space for click, scroll, and move actions.`
              : "Could not determine viewport dimensions. Use manage_browsers with action 'get' to check the browser's viewport.",
          });
          content.push({
            type: "image",
            data: buffer.toString("base64"),
            mimeType: "image/png",
          });
          return { content };
        }

        if (hasTrailingGetPosition) {
          const position =
            await client.browsers.computer.getMousePosition(session_id);
          const content: Array<{ type: "text"; text: string }> = [];
          if (batchActions.length > 0) {
            content.push({
              type: "text",
              text: `Executed ${batchActions.length} action(s).`,
            });
          }
          content.push({
            type: "text",
            text: JSON.stringify(position, null, 2),
          });
          return { content };
        }

        return {
          content: [
            {
              type: "text",
              text: `Executed ${actions.length} action(s) successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in computer_action: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
