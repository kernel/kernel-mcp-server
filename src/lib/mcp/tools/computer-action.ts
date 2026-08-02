import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";

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
      "get_mouse_position",
    ])
    .describe("Action type."),
  click_mouse: z
    .object({
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      click_type: z.enum(["down", "up", "click"]).optional(),
      num_clicks: z.number().int().min(1).optional(),
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
      delay: z.number().int().min(0).optional(),
    })
    .describe("Params for type_text action.")
    .optional(),
  press_key: z
    .object({
      keys: z
        .array(z.string())
        .describe('X11 keysym names or combos like "Ctrl+t", "Return".'),
      duration: z.number().int().min(0).optional(),
      hold_keys: z.array(z.string()).optional(),
    })
    .describe("Params for press_key action.")
    .optional(),
  scroll: z
    .object({
      x: z.number(),
      y: z.number(),
      delta_x: z.number().describe("Positive=right, negative=left.").optional(),
      delta_y: z.number().describe("Positive=down, negative=up.").optional(),
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
      delay: z.number().int().min(0).optional(),
      steps_per_segment: z.number().int().min(1).optional(),
      step_delay_ms: z.number().int().min(0).optional(),
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
      duration_ms: z.number().int().min(0),
    })
    .describe("Params for sleep action.")
    .optional(),
  write_clipboard: z
    .object({
      text: z.string(),
    })
    .describe("Params for write_clipboard action.")
    .optional(),
});

type ComputerActionParams = z.infer<typeof computerActionSchema>;
type TerminalAction = ComputerActionParams & {
  type: "get_mouse_position" | "read_clipboard";
};
type WriteClipboardAction = ComputerActionParams & { type: "write_clipboard" };
type PrefixExecutionResult =
  | { ok: true; executedActionCount: number }
  | { ok: false; error: string };

function isTerminalAction(
  action: ComputerActionParams | undefined,
): action is TerminalAction {
  return (
    action?.type === "get_mouse_position" || action?.type === "read_clipboard"
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
      return `Error: ${actions[i].type} must be the last action in the sequence.`;
    }
  }
}

function executionSummaryContent(executedActionCount: number) {
  if (executedActionCount === 0) return [];

  return [
    {
      type: "text" as const,
      text: `Executed ${executedActionCount} action(s).`,
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
          error: "Error: write_clipboard action requires write_clipboard.text.",
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
      error: `Error: ${action.type} must be the last action in the sequence.`,
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
  server.tool(
    "computer_action",
    "Drive a browser session with raw mouse and keyboard input at screen coordinates. Prefer execute_playwright_code for anything a selector can reach -- it is faster, deterministic, and does not depend on the model's ability to locate targets in an image. Reach for this tool only when there is no selector to target: canvas apps, embedded PDFs, native dialogs, drag interactions. Coordinates come from a screenshot tool call, and screen coordinates are only as accurate as the model's pixel grounding, so verify with screenshot after acting. Pass a single action, or several to batch them into one request for lower latency (e.g. click, type, press_key). Use sleep actions between steps when the page needs time to react. Action types: click_mouse, move_mouse, type_text, press_key, scroll, drag_mouse, set_cursor, sleep, write_clipboard, read_clipboard, get_mouse_position. read_clipboard and get_mouse_position return data, so they must be the last action if included.",
    {
      session_id: z.string().describe("Browser session ID."),
      actions: z
        .array(computerActionSchema)
        .min(1)
        .describe(
          "Ordered list of actions. Use one action for simple operations or multiple for batched sequences.",
        ),
    },
    {
      title: "Control browser (mouse, keyboard)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ session_id, actions }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

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
          `Executed ${executedActionCount} action(s) successfully`,
        );
      } catch (error) {
        return toolErrorResponse("computer_action", "actions", error);
      }
    },
  );
}
