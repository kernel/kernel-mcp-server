import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerComputerActionTool } from "./computer-action";

describe("computer_action SDK coverage", () => {
  test("forwards navigation buttons and smooth-motion false/zero values", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerComputerActionTool, {
      browsers: {
        computer: {
          batch: async (...args: unknown[]) => {
            calls.push(args);
          },
        },
      },
    });

    const actions = [
      {
        type: "click_mouse",
        click_mouse: { x: 10, y: 20, button: "back" },
      },
      {
        type: "move_mouse",
        move_mouse: {
          x: 30,
          y: 40,
          duration_ms: 0,
          smooth: false,
        },
      },
      {
        type: "drag_mouse",
        drag_mouse: {
          path: [
            [30, 40],
            [50, 60],
          ],
          duration_ms: 0,
          smooth: false,
        },
      },
    ];

    try {
      const result = await client.callTool({
        name: "computer_action",
        arguments: { session_id: "browser-session", actions },
      });
      expect(result.isError).toBeUndefined();
      expect(calls).toEqual([["browser-session", { actions }]]);
    } finally {
      await close();
    }
  });
});
