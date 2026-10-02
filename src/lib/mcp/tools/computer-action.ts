import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

type ComputerClient = KernelClient["browsers"]["computer"];
type ComputerBatchAction = Parameters<
  ComputerClient["batch"]
>[1]["actions"][number];

const computerActionSchema = z.object({
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
    .describe("action type."),
  click_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      click_type: z.enum(["down", "up", "click"]).optional(),
      num_clicks: z.number().int().min(1).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .describe("params for click_mouse action.")
    .optional(),
  move_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      hold_keys: z.array(z.string()).optional(),
    })
    .describe("params for move_mouse action.")
    .optional(),
  type_text: z
    .object({
      text: z.string(),
      delay: z.number().int().min(0).optional(),
    })
    .describe("params for type_text action.")
    .optional(),
  press_key: z
    .object({
      keys: z
        .array(z.string())
        .describe(
          'each item must be one x11 keysym or chord, such as "Return", "Ctrl+t", or "Ctrl+minus". for sequential or repeated key presses, use separate array items; do not combine keys with spaces or commas. use type_text to enter text.',
        ),
      duration: z.number().int().min(0).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .describe("params for press_key action.")
    .optional(),
  scroll: z
    .object({
      x: z.number(),
      y: z.number(),
      delta_x: z.number().describe("positive=right, negative=left.").optional(),
      delta_y: z.number().describe("positive=down, negative=up.").optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .describe("params for scroll action.")
    .optional(),
  drag_mouse: z
    .object({
      path: z
        .array(z.array(z.number()))
        .describe("ordered [x,y] pairs, at least 2 points."),
      button: z.enum(["left", "middle", "right"]).optional(),
      delay: z.number().int().min(0).optional(),
      steps_per_segment: z.number().int().min(1).optional(),
      step_delay_ms: z.number().int().min(0).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .describe("params for drag_mouse action.")
    .optional(),
  set_cursor: z
    .object({
      hidden: z.boolean(),
    })
    .describe("params for set_cursor action.")
    .optional(),
  sleep: z
    .object({
      duration_ms: z.number().int().min(0),
    })
    .describe("params for sleep action.")
    .optional(),
  write_clipboard: z
    .object({
      text: z.string(),
    })
    .describe("params for write_clipboard action.")
    .optional(),
  screenshot: z
    .object({
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional(),
    })
    .describe(
      "params for screenshot action. omit or pass {} for full-page screenshot.",
    )
    .optional(),
});

type ComputerActionParams = z.infer<typeof computerActionSchema>;
type TerminalAction = ComputerActionParams & {
  type: "screenshot" | "get_mouse_position" | "read_clipboard";
};
type WriteClipboardAction = ComputerActionParams & { type: "write_clipboard" };
type PrefixExecutionResult =
  | { ok: true; executedActionCount: number }
  | { ok: false; error: string };

function isTerminalAction(
  action: ComputerActionParams | undefined,
): action is TerminalAction {
  return (
    action?.type === "screenshot" ||
    action?.type === "get_mouse_position" ||
    action?.type === "read_clipboard"
  );
}

function isWriteClipboardAction(
  action: ComputerActionParams,
): action is WriteClipboardAction {
  return action.type === "write_clipboard";
}

function isBatchAction(
  action: ComputerActionParams,
): action is ComputerActionParams & ComputerBatchAction {
  switch (action.type) {
    case "click_mouse":
    case "move_mouse":
    case "type_text":
    case "press_key":
    case "scroll":
    case "drag_mouse":
    case "set_cursor":
    case "sleep":
      return true;
    default:
      return false;
  }
}

function terminalActionPlacementError(actions: ComputerActionParams[]) {
  for (let i = 0; i < actions.length - 1; i++) {
    if (isTerminalAction(actions[i])) {
      return `error: ${actions[i].type} must be the last action in the sequence.`;
    }
  }
}

function executionSummaryContent(executedActionCount: number) {
  if (executedActionCount === 0) return [];

  return [
    {
      type: "text" as const,
      text: `executed ${executedActionCount} action(s).`,
    },
  ];
}

async function flushBatchActions(
  computer: ComputerClient,
  sessionId: string,
  batchActions: ComputerBatchAction[],
) {
  if (batchActions.length === 0) return 0;

  const actions = [...batchActions];
  await computer.batch(sessionId, { actions });
  batchActions.length = 0;
  return actions.length;
}

async function executeComputerActionPrefix(
  computer: ComputerClient,
  sessionId: string,
  actions: ComputerActionParams[],
): Promise<PrefixExecutionResult> {
  const batchActions: ComputerBatchAction[] = [];
  let executedActionCount = 0;

  for (const action of actions) {
    if (isWriteClipboardAction(action)) {
      const text = action.write_clipboard?.text;
      if (text === undefined) {
        return {
          ok: false,
          error: "error: write_clipboard action requires write_clipboard.text.",
        };
      }

      executedActionCount += await flushBatchActions(
        computer,
        sessionId,
        batchActions,
      );
      await computer.writeClipboard(sessionId, { text });
      executedActionCount += 1;
      continue;
    }

    if (isBatchAction(action)) {
      batchActions.push(action);
      continue;
    }

    return {
      ok: false,
      error: `error: ${action.type} must be the last action in the sequence.`,
    };
  }

  executedActionCount += await flushBatchActions(
    computer,
    sessionId,
    batchActions,
  );
  return { ok: true, executedActionCount };
}

export function registerComputerActionTool(server: McpServer) {
  // computer_action -- Execute one or more computer actions on a browser session
  server.registerTool(
    "computer_action",
    {
      description:
        "execute computer actions on a browser session. pass a single action for simple operations (e.g. one click or one screenshot), or pass multiple actions to batch them into a single request for lower latency (e.g. click, type, press_key in one call). use sleep actions between steps when the page needs time to react (e.g. after a click that triggers navigation or animation). important: always include a screenshot as the last action so you can see the result of your actions. action types: click_mouse, move_mouse, type_text, press_key, scroll, drag_mouse, set_cursor, sleep, write_clipboard, read_clipboard, screenshot, get_mouse_position. screenshot, read_clipboard, and get_mouse_position return data, so they must be the last action if included.",
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        session_id: z.string().describe("browser session id or name."),
        actions: z
          .array(computerActionSchema)
          .min(1)
          .describe(
            "ordered list of actions. use one action for simple operations or multiple for batched sequences.",
          ),
      }),
      annotations: {
        title: "control browser (mouse, keyboard, screenshot)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id, actions, project, project_id }, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, { project, project_id }),
      );

      try {
        const placementError = terminalActionPlacementError(actions);
        if (placementError) return errorResponse(placementError);

        const terminalAction = isTerminalAction(actions[actions.length - 1])
          ? actions[actions.length - 1]
          : undefined;
        const prefixActions = terminalAction ? actions.slice(0, -1) : actions;
        const prefixResult = await executeComputerActionPrefix(
          client.browsers.computer,
          session_id,
          prefixActions,
        );
        if (!prefixResult.ok) return errorResponse(prefixResult.error);

        const { executedActionCount } = prefixResult;

        if (terminalAction?.type === "screenshot") {
          const screenshotParams = terminalAction.screenshot;
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
          if (executedActionCount > 0) {
            content.push({
              type: "text",
              text: `executed ${executedActionCount} action(s), then captured screenshot.`,
            });
          }
          content.push({
            type: "text",
            text: viewport
              ? `viewport: ${viewport.width}x${viewport.height}. use these dimensions as the coordinate space for click, scroll, and move actions.`
              : "could not determine viewport dimensions. use manage_browsers with action 'get' to check the browser's viewport.",
          });
          content.push({
            type: "image",
            data: buffer.toString("base64"),
            mimeType: "image/png",
          });
          return { content };
        }

        if (terminalAction?.type === "get_mouse_position") {
          const position =
            await client.browsers.computer.getMousePosition(session_id);
          return {
            content: [
              ...executionSummaryContent(executedActionCount),
              ...jsonResponse(position).content,
            ],
          };
        }

        if (terminalAction?.type === "read_clipboard") {
          const response =
            await client.browsers.computer.readClipboard(session_id);
          return {
            content: [
              ...executionSummaryContent(executedActionCount),
              ...jsonResponse(response).content,
            ],
          };
        }

        return textResponse(
          `executed ${executedActionCount} action(s) successfully`,
        );
      } catch (error) {
        throwToolError("computer_action", "actions", error);
      }
    },
  );
}
