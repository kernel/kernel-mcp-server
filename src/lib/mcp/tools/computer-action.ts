import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";

type ComputerBatchAction = Parameters<
  KernelClient["browsers"]["computer"]["batch"]
>[1]["actions"][number];

type ComputerToolAction = Partial<Omit<ComputerBatchAction, "type">> & {
  type:
    | ComputerBatchAction["type"]
    | "screenshot"
    | "get_mouse_position"
    | "read_clipboard"
    | "write_clipboard";
  screenshot?: {
    region?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
  write_clipboard?: { text: string };
};

type ComputerBatchToolAction = ComputerToolAction & {
  type: ComputerBatchAction["type"];
};

type ComputerResultAction = ComputerToolAction & {
  type: "screenshot" | "get_mouse_position" | "read_clipboard";
};

type ComputerExecutionResult =
  | { ok: true; executedActionCount: number }
  | { ok: false; error: string };

function isResultAction(
  action: ComputerToolAction,
): action is ComputerResultAction {
  return (
    action.type === "screenshot" ||
    action.type === "get_mouse_position" ||
    action.type === "read_clipboard"
  );
}

function isBatchAction(
  action: ComputerToolAction,
): action is ComputerBatchToolAction {
  return action.type !== "write_clipboard" && !isResultAction(action);
}

function toBatchAction(action: ComputerBatchToolAction): ComputerBatchAction {
  switch (action.type) {
    case "click_mouse":
      return { type: action.type, click_mouse: action.click_mouse };
    case "move_mouse":
      return { type: action.type, move_mouse: action.move_mouse };
    case "type_text":
      return { type: action.type, type_text: action.type_text };
    case "press_key":
      return { type: action.type, press_key: action.press_key };
    case "scroll":
      return { type: action.type, scroll: action.scroll };
    case "drag_mouse":
      return { type: action.type, drag_mouse: action.drag_mouse };
    case "set_cursor":
      return { type: action.type, set_cursor: action.set_cursor };
    case "sleep":
      return { type: action.type, sleep: action.sleep };
  }
}

function splitTrailingResultAction(actions: ComputerToolAction[]): {
  leadingActions: ComputerToolAction[];
  resultAction?: ComputerResultAction;
} {
  const lastAction = actions[actions.length - 1];
  const resultAction = isResultAction(lastAction) ? lastAction : undefined;
  return {
    leadingActions: resultAction ? actions.slice(0, -1) : actions,
    resultAction,
  };
}

async function executeLeadingComputerActions(
  client: KernelClient,
  sessionId: string,
  actions: ComputerToolAction[],
): Promise<ComputerExecutionResult> {
  let executedActionCount = 0;
  let batchActions: ComputerBatchAction[] = [];

  async function flushBatchActions() {
    if (batchActions.length === 0) return;
    await client.browsers.computer.batch(sessionId, { actions: batchActions });
    executedActionCount += batchActions.length;
    batchActions = [];
  }

  for (const action of actions) {
    if (isResultAction(action)) {
      return {
        ok: false,
        error: `Error: ${action.type} must be the last action in the sequence.`,
      };
    }

    if (action.type === "write_clipboard") {
      await flushBatchActions();
      if (!action.write_clipboard) {
        return {
          ok: false,
          error:
            "Error: write_clipboard params are required for write_clipboard action.",
        };
      }
      await client.browsers.computer.writeClipboard(sessionId, {
        text: action.write_clipboard.text,
      });
      executedActionCount += 1;
      continue;
    }

    if (isBatchAction(action)) {
      batchActions.push(toBatchAction(action));
    }
  }

  await flushBatchActions();
  return { ok: true, executedActionCount };
}

function actionCountPrefix(executedActionCount: number, suffix: string) {
  return executedActionCount > 0
    ? [
        {
          type: "text" as const,
          text: `Executed ${executedActionCount} action(s)${suffix}`,
        },
      ]
    : [];
}

export function registerComputerActionTool(server: McpServer) {
  // computer_action -- Execute one or more computer actions on a browser session
  server.tool(
    "computer_action",
    "Execute computer actions on a browser session. Pass a single action for simple operations (e.g. one click or one screenshot), or pass multiple actions to batch them into a single request for lower latency (e.g. click, type, press_key in one call). Use sleep actions between steps when the page needs time to react (e.g. after a click that triggers navigation or animation). IMPORTANT: Always include a screenshot as the last action so you can see the result of your actions. Action types: click_mouse, move_mouse, type_text, press_key, scroll, drag_mouse, set_cursor, sleep, write_clipboard, read_clipboard, screenshot, get_mouse_position. screenshot, read_clipboard, and get_mouse_position return data, so they must be the last action if included.",
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
                "write_clipboard",
                "read_clipboard",
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
            write_clipboard: z
              .object({
                text: z.string(),
              })
              .describe("Params for write_clipboard action.")
              .optional(),
          }),
        )
        .min(1)
        .describe(
          "Ordered list of actions. Use one action for simple operations or multiple for batched sequences.",
        ),
    },
    async ({ session_id, actions }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const toolActions: ComputerToolAction[] = actions;
        const { leadingActions, resultAction } =
          splitTrailingResultAction(toolActions);
        const execution = await executeLeadingComputerActions(
          client,
          session_id,
          leadingActions,
        );
        if (!execution.ok) return errorResponse(execution.error);

        if (resultAction?.type === "screenshot") {
          const screenshotParams = resultAction.screenshot;
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
          content.push(
            ...actionCountPrefix(
              execution.executedActionCount,
              ", then captured screenshot.",
            ),
          );
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

        if (resultAction?.type === "read_clipboard") {
          const clipboard =
            await client.browsers.computer.readClipboard(session_id);
          return {
            content: [
              ...actionCountPrefix(
                execution.executedActionCount,
                ", then read clipboard.",
              ),
              { type: "text", text: JSON.stringify(clipboard, null, 2) },
            ],
          };
        }

        if (resultAction?.type === "get_mouse_position") {
          const position =
            await client.browsers.computer.getMousePosition(session_id);
          return {
            content: [
              ...actionCountPrefix(execution.executedActionCount, "."),
              { type: "text", text: JSON.stringify(position, null, 2) },
            ],
          };
        }

        return textResponse(
          `Executed ${execution.executedActionCount} action(s) successfully`,
        );
      } catch (error) {
        return toolErrorResponse("computer_action", "actions", error);
      }
    },
  );
}
