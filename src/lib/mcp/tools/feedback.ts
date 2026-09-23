import type { McpServer } from "@modelcontextprotocol/server";
import { parse as parseDomain } from "tldts";
import { z } from "zod";
import { MCP_INTENT_ARGUMENT_DESCRIPTION } from "@/lib/mcp/analytics-context";
import { errorResponse, jsonResponse } from "@/lib/mcp/responses";
import {
  normalizeKernelMcpToolName,
  type KernelMcpToolName,
} from "@/lib/mcp/tool-names";

export const KERNEL_FEEDBACK_TOOL_NAME = "submit_feedback";

const taskOutcomeSchema = z.enum([
  "completed",
  "completed_with_workaround",
  "partially_completed",
  "blocked",
  "not_applicable",
  "unknown",
]);

const affectedToolSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((value, context): KernelMcpToolName => {
    const toolName = normalizeKernelMcpToolName(value);
    if (toolName) return toolName;
    context.addIssue({
      code: "custom",
      message: "must name a tool provided by the KERNEL MCP server",
    });
    return z.NEVER;
  });

const configRegistryAppliedBrowserSchema = z.object({
  stealth: z.boolean().describe("the applied browser stealth setting."),
  headless: z.boolean().describe("the applied browser headless setting."),
  gpu: z.boolean().describe("the applied browser GPU setting."),
  viewport: z.object({
    width: z.number().int().positive().describe("the applied viewport width."),
    height: z
      .number()
      .int()
      .positive()
      .describe("the applied viewport height."),
    refresh_rate: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("the applied viewport refresh rate, if specified."),
  }),
});

const configRegistryAppliedProxySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct") }),
  z.object({
    mode: z.literal("managed"),
    type: z.enum(["datacenter", "isp", "residential", "mobile", "custom"]),
    country: z
      .string()
      .trim()
      .length(2)
      .toUpperCase()
      .optional()
      .describe(
        "the applied two-letter proxy country, if specified. do not include city, state, ZIP code, host, IP, or credentials.",
      ),
  }),
]);

const configRegistryFeedbackSchema = z.object({
  request_method: z
    .enum(["lookup", "resolve"])
    .describe(
      "the config registry operation that returned the recommendation.",
    ),
  analysis_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "the config registry analysis ID when the recommendation came from a resolve or known analysis.",
    ),
  recommendation_match_scope: z
    .enum(["exact", "host", "domain"])
    .optional()
    .describe("the match_scope returned with the recommendation."),
  recommendation_verification: z
    .enum(["verified", "inferred"])
    .optional()
    .describe("the verification value returned with the recommendation."),
  recommendation_evidence: z.object({
    sample_size: z
      .number()
      .int()
      .nonnegative()
      .describe("the recommendation evidence sample_size value."),
    success_rate: z
      .number()
      .min(0)
      .max(1)
      .describe("the recommendation evidence success_rate value."),
    last_verified_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "the recommendation evidence last_verified_at timestamp, or null when it has never been verified.",
      ),
  }),
  applied_browser: configRegistryAppliedBrowserSchema.describe(
    "the returned browser settings, applied unchanged for the observed outcome.",
  ),
  applied_proxy: configRegistryAppliedProxySchema.describe(
    "the returned proxy settings, applied unchanged for the observed outcome. never include proxy hosts, IPs, or credentials.",
  ),
});

const botDetectionReportSchema = z.object({
  registrable_domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => {
      const parsed = parseDomain(value, { allowPrivateDomains: false });
      return parsed.isIcann && parsed.domain === value;
    }, "must be a public registrable domain without a subdomain or URL components")
    .describe(
      'the public registrable domain where the result was observed (e.g. "example.com"). include no protocol, path, query, fragment, port, subdomain, account-specific host, or private/internal hostname. public registrable domains are allowed only in this field so reports can prioritize config registry coverage.',
    ),
  observed_outcome: z
    .enum(["passed", "challenged", "blocked", "degraded"])
    .describe(
      'what the site did: "passed" = the intended flow remained usable, "challenged" = an anti-bot step appeared but the flow could continue, "blocked" = the flow could not continue, and "degraded" = content or functionality was restricted.',
    ),
  suspected_vendor: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'the suspected bot-detection vendor or product, when supported by evidence (e.g. "Akamai Bot Manager"). omit rather than guess.',
    ),
  challenge_type: z
    .enum([
      "captcha",
      "javascript_challenge",
      "access_denied",
      "rate_limited",
      "login_block",
      "fingerprint_block",
      "content_restricted",
      "other",
      "unknown",
    ])
    .optional()
    .describe(
      "the dominant challenge or block observed. use unknown when the flow failed without a recognizable challenge surface.",
    ),
  stealth: z
    .enum(["enabled", "disabled", "unknown"])
    .optional()
    .describe("whether KERNEL stealth mode was enabled for the observation."),
  proxy_type: z
    .enum([
      "none",
      "datacenter",
      "isp",
      "residential",
      "mobile",
      "custom",
      "unknown",
    ])
    .optional()
    .describe(
      "the egress type used for the observation. never include a proxy URL, credential, provider account, or IP address.",
    ),
  region: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .optional()
    .describe(
      'the KERNEL browser region used for the observation (e.g. "us-east"). do not include a street address, postal code, or user location.',
    ),
  browser_version: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("the browser version reported by the KERNEL session, if known."),
  browser_image_version: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("the KERNEL browser image version or release tag, if known."),
  reproducibility: z
    .enum(["single_observation", "intermittent", "consistent", "unknown"])
    .describe(
      'how repeatable the outcome was: "single_observation" = tried once, "intermittent" = outcomes varied, "consistent" = repeated attempts matched, and "unknown" = repetition was not observable.',
    ),
  browser_session_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "the KERNEL browser session ID for internal correlation, if available. never substitute a CDP or live-view URL.",
    ),
});

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
    .enum([
      "product",
      "bot_detection",
      "config_registry",
      "mcp",
      "docs",
      "other",
    ])
    .describe(
      'what this feedback is about. "product" = any KERNEL product or feature, such as browsers, apps, profiles, proxies, browser pools, replays, telemetry, managed auth, credentials, extensions, projects, or api keys. "bot_detection" = a site-specific pass, challenge, block, or degraded result not produced by an unchanged config registry recommendation; include `bot_detection`. "config_registry" = the observed result after requesting and applying a config registry recommendation unchanged; include both `bot_detection` and `config_registry` so the outcome is attributed to the settings used. "mcp" = this mcp server itself, including a tool, input schema, response format, error, or its instructions. "docs" = KERNEL documentation. "other" = anything that does not fit the other types.',
    ),
  sentiment: z
    .enum(["positive", "neutral", "negative", "mixed"])
    .describe(
      'the overall tone. use "negative" for something broken or blocking, "mixed" for mostly fine with a concrete problem, "neutral" for a suggestion or feature request with no strong sentiment, and "positive" for praise or something that worked well. all sentiments are welcome, but task_outcome—not sentiment—describes impact.',
    ),
  task_outcome: taskOutcomeSchema
    .optional()
    .describe(
      'the outcome of the user\'s task: "completed", "completed_with_workaround", "partially_completed", "blocked", "not_applicable" for feedback not tied to a task, or "unknown" only for legacy submissions without an outcome. preferred over task_completed.',
    ),
  affected_tool: affectedToolSchema
    .optional()
    .describe(
      'the single KERNEL MCP tool this report is primarily about. preferred for new `feedback_type: "mcp"` submissions; omission remains accepted for legacy clients and routes to unclassified feedback. use the canonical tool name without a client namespace; recognized KERNEL namespace forms are normalized. feedback about tools from another MCP server or the client itself belongs with that owner.',
    ),
  product_area: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'the KERNEL product or area this is about, in free text (e.g. "browsers", "apps", "managed auth", "browser pools", "proxies", or "telemetry"). preferred for new product feedback; omission remains accepted for legacy clients and routes to unclassified feedback. use `feedback_type: "bot_detection"` instead of putting bot detection here, and use affected_tool for mcp feedback.',
    ),
  bot_detection: botDetectionReportSchema
    .optional()
    .describe(
      'the structured site outcome. required when `feedback_type` is "bot_detection" or "config_registry" and rejected for every other feedback type.',
    ),
  config_registry: configRegistryFeedbackSchema
    .optional()
    .describe(
      'the config registry recommendation, evidence snapshot, and exact settings used for the observed site outcome. required when `feedback_type` is "config_registry" and rejected for every other feedback type. `bot_detection.browser_session_id` is also required so KERNEL can investigate without collecting sensitive page details here. use this only after applying the recommendation unchanged, whether it passes or fails; if the settings were changed first, report `bot_detection` instead.',
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
      'for mcp feedback (`feedback_type: "mcp"`) only: the single category that best describes the dominant theme. `missing_tool` remains accepted for compatibility but is routed outside MCP quality; use `get_more_tools` for new capability requests. use "tool_description" when tool documentation is unclear, "tool_input_schema" when arguments are confusing, "tool_output_format" when a response is hard to consume, "instructions_clarity" when mcp instructions are unclear, "tool_correctness" when a tool returns wrong data, "error_message" when an error is unhelpful, and "performance" when latency is the issue. omit for product, docs, or other feedback.',
    ),
  task_completed: z
    .boolean()
    .optional()
    .describe(
      "legacy task completion signal retained for compatibility. prefer task_outcome, which distinguishes workarounds, partial completion, blockers, and feedback not tied to a task. task_completed remains required for bot-detection and config-registry feedback.",
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
  "send feedback about a KERNEL product, this KERNEL MCP server, or KERNEL documentation. use get_more_tools—not this tool—for a genuinely absent capability. for mcp feedback, identify the single affected KERNEL tool and its category; do not report client behavior or tools owned by another server. describe task impact with task_outcome, while sentiment remains useful for tone and praise. set feedback_type to product, bot_detection, config_registry, mcp, docs, or other. for bot detection, fill bot_detection with the public registrable domain, outcome, and reproducibility. after applying a config registry recommendation unchanged, submit exactly one config_registry report for the tested recommendation, whether it passed or failed; include the recommendation metadata, evidence, exact browser and proxy settings, and bot_detection.browser_session_id. if any setting changed before testing, use bot_detection instead. keep summary to one sentence, make detail fields concise and actionable, and include a concrete suggested_improvement when one is clear. never include credentials, tokens, api keys, urls, paths, browser or page content, customer or account names, private hosts, IP addresses, or personal data. a public registrable domain is allowed only in bot_detection.registrable_domain. submitting feedback is a side report, not a reason to stop; continue the user's task with the other available tools.";

const RESPONSE_MESSAGES = {
  recorded:
    "thank you for the feedback. it has been recorded and will be reviewed by the KERNEL team. " +
    "submitting feedback does not mean the current task is done; continue using the other available tools to finish it.",
  unavailable:
    "feedback analytics are unavailable, so this feedback was not recorded. continue using the other available tools to finish the current task.",
  failed:
    "feedback capture failed, so this feedback was not recorded. continue using the other available tools to finish the current task.",
} as const;

type FeedbackCaptureStatus = keyof typeof RESPONSE_MESSAGES;

function taskCompletedForOutcome(
  outcome: z.infer<typeof taskOutcomeSchema>,
): boolean | undefined {
  switch (outcome) {
    case "completed":
    case "completed_with_workaround":
      return true;
    case "partially_completed":
    case "blocked":
      return false;
    case "not_applicable":
    case "unknown":
      return undefined;
  }
}

function kernelToolsUsed(toolsUsed: string[] | undefined) {
  return new Set(
    toolsUsed
      ?.map(normalizeKernelMcpToolName)
      .filter(
        (toolName): toolName is KernelMcpToolName =>
          toolName !== undefined &&
          toolName !== KERNEL_FEEDBACK_TOOL_NAME &&
          toolName !== "get_more_tools",
      ),
  );
}

export function registerFeedbackTool(
  server: McpServer,
  capture?: KernelFeedbackCapture,
) {
  server.registerTool(
    KERNEL_FEEDBACK_TOOL_NAME,
    {
      title: "submit KERNEL feedback",
      description: TOOL_DESCRIPTION,
      inputSchema: z.object(feedbackFields),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ context: _context, ...feedback }, ctx) => {
      if (feedback.task_outcome === undefined) {
        feedback.task_outcome =
          feedback.task_completed === undefined
            ? "unknown"
            : feedback.task_completed
              ? "completed"
              : "blocked";
      } else {
        const expectedTaskCompleted = taskCompletedForOutcome(
          feedback.task_outcome,
        );
        if (
          feedback.task_completed !== undefined &&
          feedback.task_completed !== expectedTaskCompleted
        ) {
          return errorResponse(
            "task_outcome and task_completed describe conflicting outcomes.",
          );
        }
        feedback.task_completed ??= expectedTaskCompleted;
      }

      if (feedback.feedback_type === "mcp") {
        const candidates = kernelToolsUsed(feedback.tools_used);
        if (!feedback.affected_tool && candidates.size === 1) {
          feedback.affected_tool = [...candidates][0];
        }
        if (
          !feedback.affected_tool &&
          feedback.tools_used &&
          feedback.tools_used.length > 0 &&
          candidates.size === 0
        ) {
          return errorResponse(
            "this feedback names no KERNEL MCP tool; report client or external-server feedback to its owner.",
          );
        }
      } else {
        if (feedback.affected_tool) {
          return errorResponse(
            "affected_tool is only accepted for mcp feedback.",
          );
        }
        if (feedback.category) {
          return errorResponse("category is only accepted for mcp feedback.");
        }
      }

      const hasSiteOutcome =
        feedback.feedback_type === "bot_detection" ||
        feedback.feedback_type === "config_registry";
      if (hasSiteOutcome) {
        if (!feedback.bot_detection || feedback.task_completed === undefined) {
          return errorResponse(
            "bot_detection and task_completed are required for bot-detection and config-registry feedback.",
          );
        }
      } else if (feedback.bot_detection) {
        return errorResponse(
          "bot_detection is only accepted for bot-detection and config-registry feedback.",
        );
      }

      if (feedback.feedback_type === "config_registry") {
        if (!feedback.config_registry) {
          return errorResponse(
            "config_registry is required when feedback_type is config_registry.",
          );
        }
        if (!feedback.bot_detection?.browser_session_id) {
          return errorResponse(
            "bot_detection.browser_session_id is required when feedback_type is config_registry.",
          );
        }
      } else if (feedback.config_registry) {
        return errorResponse(
          "config_registry is only accepted when feedback_type is config_registry.",
        );
      }

      let status: FeedbackCaptureStatus = "unavailable";
      if (capture) {
        try {
          await capture(feedback, ctx);
          status = "recorded";
        } catch {
          // Feedback analytics must not block the user's original task.
          status = "failed";
        }
      }

      return jsonResponse({
        recorded: status === "recorded",
        status,
        summary: feedback.summary,
        feedback_type: feedback.feedback_type,
        sentiment: feedback.sentiment,
        message: RESPONSE_MESSAGES[status],
      });
    },
  );
}
