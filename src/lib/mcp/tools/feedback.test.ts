import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  KERNEL_FEEDBACK_TOOL_NAME,
  type KernelFeedback,
  registerFeedbackTool,
} from "@/lib/mcp/tools/feedback";

describe("submit_feedback", () => {
  test("advertises the feedback schema and records a submission", async () => {
    const captured: KernelFeedback[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, (feedback) => {
          captured.push(feedback);
        }),
      {},
    );

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find(
        ({ name }) => name === KERNEL_FEEDBACK_TOOL_NAME,
      );
      expect(tool?.title).toBe("submit KERNEL feedback");
      expect(tool?.inputSchema.required).toEqual([
        "summary",
        "feedback_type",
        "sentiment",
      ]);

      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          summary: "Browser creation needs clearer timeout guidance",
          feedback_type: "product",
          sentiment: "mixed",
          product_area: "browsers",
          friction_points: "- The timeout response did not suggest a retry.",
          suggested_improvement:
            "Include retry timing in browser creation timeout responses.",
          task_completed: true,
          tools_used: ["manage_browsers"],
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        received: true,
        summary: "Browser creation needs clearer timeout guidance",
        feedback_type: "product",
        sentiment: "mixed",
      });
      expect(captured).toEqual([
        {
          summary: "Browser creation needs clearer timeout guidance",
          feedback_type: "product",
          sentiment: "mixed",
          product_area: "browsers",
          friction_points: "- The timeout response did not suggest a retry.",
          suggested_improvement:
            "Include retry timing in browser creation timeout responses.",
          task_completed: true,
          tools_used: ["manage_browsers"],
        },
      ]);
    } finally {
      await close();
    }
  });

  test("keeps analytics failures from failing the tool call", async () => {
    const { client, close } = await connectTestMcp(
      (server) =>
        registerFeedbackTool(server, () => {
          throw new Error("analytics unavailable");
        }),
      {},
    );

    try {
      const result = await client.callTool({
        name: KERNEL_FEEDBACK_TOOL_NAME,
        arguments: {
          summary: "The MCP response was easy to use",
          feedback_type: "mcp",
          sentiment: "positive",
        },
      });

      expect(toolResultJSON(result)).toMatchObject({
        received: true,
        summary: "The MCP response was easy to use",
      });
    } finally {
      await close();
    }
  });
});
