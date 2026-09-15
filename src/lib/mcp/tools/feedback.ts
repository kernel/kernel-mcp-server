import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse as parseDomain } from "tldts";
import { z } from "zod";
import { MCP_INTENT_ARGUMENT_DESCRIPTION } from "@/lib/mcp/analytics-context";
import { errorResponse, jsonResponse } from "@/lib/mcp/responses";

export const KERNEL_FEEDBACK_TOOL_NAME = "submit_feedback";

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
      'the overall tone. use "negative" for something broken or blocking, "mixed" for mostly fine with a concrete problem, "neutral" for a suggestion or feature request with no strong sentiment, and "positive" for praise or something that worked well. all sentiments are welcome.',
    ),
  product_area: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'the KERNEL product or area this is about, in free text (e.g. "browsers", "apps", "managed auth", "browser pools", "proxies", or "telemetry"). most useful for product feedback; use `feedback_type: "bot_detection"` instead of putting bot detection here, and for mcp feedback put the tool name in `details` or `friction_points`.',
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
      'for mcp feedback (`feedback_type: "mcp"`) only: the single category that best describes the dominant theme. use "missing_tool" when a capability is absent, "tool_description" when tool documentation is unclear, "tool_input_schema" when arguments are confusing, "tool_output_format" when a response is hard to consume, "instructions_clarity" when mcp instructions are unclear, "tool_correctness" when a tool returns wrong data, "error_message" when an error is unhelpful, and "performance" when latency is the issue. omit for product, docs, or other feedback.',
    ),
  task_completed: z
    .boolean()
    .optional()
    .describe(
      "whether the user's task was completed. be honest: `false` is useful signal. required for bot-detection and config-registry feedback, and also useful for mcp feedback.",
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
  "send feedback about anything KERNEL to the KERNEL team. set `feedback_type` to route it: `product` for any KERNEL product or feature, `bot_detection` for a site-specific pass, challenge, block, or degraded result not tied to an unchanged registry recommendation, `config_registry` for the result after requesting and applying a config registry recommendation unchanged, `mcp` for this mcp server, `docs` for KERNEL documentation, or `other`. for bot detection, fill `bot_detection` with the public registrable domain, outcome, and reproducibility. when a config registry recommendation was requested and applied unchanged, choose `config_registry`; include the request metadata, recommendation evidence, exact browser and proxy settings used, and `bot_detection.browser_session_id`. report both passes and failures so recommendation quality can be measured. if any recommended setting was changed before testing, use `bot_detection` instead so the result is not attributed to the original recommendation. all sentiments are welcome through `sentiment`: praise and feature requests are useful, not just problems. use this for confusing or broken experiences, papercuts, missing capabilities, unhelpful errors, feature requests, and things that worked especially well. keep `summary` to one sentence and make the detail fields concise and actionable, quoting the product surface, tool name, parameter, or error text when possible. include a concrete `suggested_improvement` when one is clear. never include credentials, tokens, api keys, urls, paths, browser or page content, customer or account names, private hosts, IP addresses, or personal data. a public registrable domain is allowed only in `bot_detection.registrable_domain`; never include a subdomain or account-specific host. the user can also ask to send feedback directly. submitting feedback is a side report to KERNEL, not a reason to stop: continue and finish the user's task with the other available tools.";

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

export function registerFeedbackTool(
  server: McpServer,
  capture?: KernelFeedbackCapture,
) {
  server.registerTool(
    KERNEL_FEEDBACK_TOOL_NAME,
    {
      title: "submit KERNEL feedback",
      description: TOOL_DESCRIPTION,
      inputSchema: feedbackFields,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ context: _context, ...feedback }, extra) => {
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
          await capture(feedback, extra);
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
