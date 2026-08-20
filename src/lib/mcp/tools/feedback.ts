import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MCP_INTENT_ARGUMENT_DESCRIPTION } from "@/lib/mcp/analytics-context";
import { jsonResponse } from "@/lib/mcp/responses";

export const KERNEL_FEEDBACK_TOOL_NAME = "submit_feedback";

const feedbackFields = {
  context: z.string().describe(MCP_INTENT_ARGUMENT_DESCRIPTION),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      'a one-sentence headline capturing the feedback (e.g. "browser creation timed out without recovery guidance", "manage_browsers returned exactly the context needed", or "the proxy docs need a residential example").',
    ),
  feedback_type: z
    .enum(["product", "mcp", "docs", "other"])
    .describe(
      'what this feedback is about. "product" = any KERNEL product or feature, such as browsers, apps, profiles, proxies, browser pools, replays, telemetry, managed auth, credentials, extensions, projects, or api keys. "mcp" = this mcp server itself, including a tool, input schema, response format, error, or its instructions. "docs" = KERNEL documentation. "other" = anything that does not fit the other types.',
    ),
  sentiment: z
    .enum(["positive", "neutral", "negative", "mixed"])
    .describe(
      'the overall tone. use "negative" for something broken or blocking, "mixed" for mostly fine with a concrete problem, "neutral" for a suggestion or feature request with no strong sentiment, and "positive" for praise or something that worked well. all sentiments are welcome.',
    ),
  product_area: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'the KERNEL product or area this is about, in free text (e.g. "browsers", "apps", "managed auth", "browser pools", "proxies", or "telemetry"). most useful for product feedback; for mcp feedback put the tool name in `details` or `friction_points` instead.',
    ),
  category: z
    .enum([
      "tool_correctness",
      "tool_description",
      "tool_input_schema",
      "tool_output_format",
      "missing_tool",
      "instructions_clarity",
      "performance",
      "error_message",
      "other",
    ])
    .optional()
    .describe(
      'for mcp feedback (`feedback_type: "mcp"`) only: the single category that best describes the dominant theme. use "missing_tool" when a capability is absent, "tool_description" when tool documentation is unclear, "tool_input_schema" when arguments are confusing, "tool_output_format" when a response is hard to consume, "instructions_clarity" when mcp instructions are unclear, "tool_correctness" when a tool returns wrong data, "error_message" when an error is unhelpful, and "performance" when latency is the issue. omit for product, docs, or other feedback.',
    ),
  task_completed: z
    .boolean()
    .optional()
    .describe(
      'whether the user\'s task was completed. be honest: `false` is useful signal. most relevant when `feedback_type` is "mcp".',
    ),
  tools_used: z
    .array(z.string().trim().min(1).max(100))
    .max(50)
    .optional()
    .describe(
      'the mcp tool names called while working on the user\'s task (e.g. ["manage_browsers", "execute_playwright_code"]).',
    ),
  friction_points: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "clear, concise bullet points describing what was confusing, broken, slow, or missing. quote the exact product surface, tool name, parameter, or error text when possible. omit for purely positive feedback.",
    ),
  suggested_improvement: z
    .string()
    .trim()
    .min(1)
    .max(3000)
    .optional()
    .describe(
      "the single most impactful, concrete change that would address this feedback, when one can be named. optional for praise or observations.",
    ),
  user_request: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "a short, anonymized paraphrase of what the user originally asked. do not include personal data, customer or account names, target urls, or sensitive browser content.",
    ),
  details: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "additional context that does not fit the other fields. keep it to clear, concise bullet points.",
    ),
};

export type KernelFeedback = Omit<
  z.infer<z.ZodObject<typeof feedbackFields>>,
  "context"
>;
export type KernelFeedbackCapture = (
  feedback: KernelFeedback,
  extra: unknown,
) => void | Promise<void>;

const TOOL_DESCRIPTION =
  "send feedback about anything KERNEL to the KERNEL team. set `feedback_type` to route it: `product` for any KERNEL product or feature, `mcp` for this mcp server, `docs` for KERNEL documentation, or `other`. all sentiments are welcome through `sentiment`: praise and feature requests are useful, not just problems. use this for confusing or broken experiences, papercuts, missing capabilities, unhelpful errors, feature requests, and things that worked especially well. keep `summary` to one sentence and make the detail fields concise and actionable, quoting the product surface, tool name, parameter, or error text when possible. include a concrete `suggested_improvement` when one is clear. never include credentials, tokens, api keys, urls, browser or page content, customer or account names, or personal data. the user can also ask to send feedback directly. submitting feedback is a side report to KERNEL, not a reason to stop: continue and finish the user's task with the other available tools.";

const RESPONSE_MESSAGE =
  "thank you for the feedback. it has been recorded and will be reviewed by the KERNEL team. " +
  "submitting feedback does not mean the current task is done; continue using the other available tools to finish it.";

export function registerFeedbackTool(
  server: McpServer,
  capture: KernelFeedbackCapture,
) {
  server.registerTool(
    KERNEL_FEEDBACK_TOOL_NAME,
    {
      title: "submit KERNEL feedback",
      description: TOOL_DESCRIPTION,
      inputSchema: feedbackFields,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ context: _context, ...feedback }, extra) => {
      try {
        await capture(feedback, extra);
      } catch {
        // Feedback analytics must not block the user's original task.
      }

      return jsonResponse({
        received: true,
        summary: feedback.summary,
        feedback_type: feedback.feedback_type,
        sentiment: feedback.sentiment,
        message: RESPONSE_MESSAGE,
      });
    },
  );
}
