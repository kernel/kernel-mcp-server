import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResponse } from "@/lib/mcp/responses";
import {
  normalizeKernelMcpToolName,
  type KernelMcpToolName,
} from "@/lib/mcp/tool-names";

export const KERNEL_MISSING_CAPABILITY_TOOL_NAME = "get_more_tools";

const gapReasonSchema = z.enum([
  "kernel_capability_missing",
  "existing_tool_failed",
  "transient_or_capacity_failure",
  "client_permission_restriction",
  "external_integration_unavailable",
  "unknown",
]);

const capabilityAreaSchema = z.enum([
  "browsers",
  "browser_files",
  "profiles",
  "projects",
  "apps",
  "browser_pools",
  "proxies",
  "extensions",
  "managed_auth",
  "credentials",
  "api_keys",
  "replays",
  "vaults",
  "docs",
  "mcp",
  "external_integration",
  "client_environment",
  "other",
]);

const requestedActionSchema = z.enum([
  "create",
  "read",
  "update",
  "delete",
  "execute",
  "search",
  "transfer",
  "authenticate",
  "inspect",
  "other",
]);

const taskOutcomeSchema = z.enum([
  "completed",
  "completed_with_workaround",
  "partially_completed",
  "blocked",
]);

const checkedKernelToolSchema = z
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

const missingCapabilityFields = {
  context: z
    .string()
    .describe(
      "The missing capability and the user's goal, in 15-25 words and third person. Never include credentials, URLs, domains, account names, file contents, paths, or personal data.",
    ),
  gap_reason: gapReasonSchema.describe(
    "Why the task could not proceed. Only kernel_capability_missing and external_integration_unavailable are recorded as demand. For an existing tool failure, use submit_feedback instead; transient failures and client restrictions are not capability gaps.",
  ),
  capability_area: capabilityAreaSchema.describe(
    "The single KERNEL product area that would own the capability, or external_integration/client_environment when Kernel does not own it.",
  ),
  capability: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'A short generic capability name, such as "browser filesystem upload". Do not include a site, customer, account, domain, path, or payload.',
    ),
  requested_action: requestedActionSchema.describe(
    "The primary operation the missing capability needed to perform.",
  ),
  task_outcome: taskOutcomeSchema.describe(
    "Whether the task was completed, completed through a workaround, partially completed, or blocked.",
  ),
  tools_checked: z
    .array(checkedKernelToolSchema)
    .max(10)
    .optional()
    .describe(
      "The closest KERNEL MCP tools checked before confirming the gap. Omit when no existing tool is relevant.",
    ),
};

export type MissingCapabilityReport = z.infer<
  z.ZodObject<typeof missingCapabilityFields>
>;
export type MissingCapabilityCapture = (
  report: MissingCapabilityReport,
  extra: unknown,
) => void | Promise<void>;

export function registerMissingCapabilityTool(
  server: McpServer,
  capture?: MissingCapabilityCapture,
) {
  server.tool(
    KERNEL_MISSING_CAPABILITY_TOOL_NAME,
    "Report a capability that no available KERNEL tool can provide after checking the tool list. Classify disconnected third-party services as external integrations. Do not use this for an existing tool that failed, a transient or capacity failure, or a client-side permission restriction; use submit_feedback for an existing KERNEL tool failure. Reports never replace the original task, so continue with any available workaround.",
    missingCapabilityFields,
    {
      title: "Get more tools",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (report, extra) => {
      const externalIntegration =
        report.gap_reason === "external_integration_unavailable";
      if (
        (externalIntegration &&
          report.capability_area !== "external_integration") ||
        (report.gap_reason === "kernel_capability_missing" &&
          (report.capability_area === "external_integration" ||
            report.capability_area === "client_environment"))
      ) {
        return jsonResponse({
          recorded: false,
          status: "invalid_capability_owner",
          message:
            "gap_reason and capability_area identify different owners. Correct the classification, then continue the original task.",
        });
      }

      const recordable =
        report.gap_reason === "kernel_capability_missing" ||
        externalIntegration;
      if (!recordable) {
        return jsonResponse({
          recorded: false,
          status: "not_a_capability_gap",
          message:
            report.gap_reason === "existing_tool_failed"
              ? "Use submit_feedback for the existing KERNEL tool, then continue the original task."
              : "This is not a missing capability request. Continue the original task using its normal recovery or client-permission path.",
        });
      }

      let status: "recorded" | "unavailable" | "failed" = "unavailable";
      if (capture) {
        try {
          await capture(report, extra);
          status = "recorded";
        } catch (error) {
          status = "failed";
          console.error("Failed to capture MCP capability request", error);
        }
      }
      return jsonResponse({
        recorded: status === "recorded",
        status,
        capability: report.capability,
        destination:
          report.gap_reason === "kernel_capability_missing"
            ? "kernel_product_demand"
            : "external_integration_demand",
        message:
          status === "recorded"
            ? "The capability request was recorded. No additional KERNEL tools are available; continue the original task with any available workaround."
            : "The capability request was not recorded. No additional KERNEL tools are available; continue the original task with any available workaround.",
      });
    },
  );
}
