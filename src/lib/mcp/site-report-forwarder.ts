import type { McpDependencies } from "@/lib/mcp/dependencies";
import { defaultMcpDependencies } from "@/lib/mcp/dependencies";
import type { KernelFeedback } from "@/lib/mcp/tools/feedback";

const NOTES_MAX_LENGTH = 2000;

type SiteReportRequest = {
  url: string;
  outcome: "blocked" | "challenged" | "degraded" | "passed";
  challenge_type?: string;
  access_provider?: string;
  reproducibility?: "single_observation" | "intermittent" | "consistent";
  task?: string;
  notes?: string;
  config_source?: "config_registry" | "custom";
  config_registry_analysis_id?: string;
};

/**
 * Builds the site-report request for feedback that names a browser session.
 * Returns null when the feedback has no site outcome to attach to a session.
 */
export function siteReportFromFeedback(
  feedback: KernelFeedback,
): { browserSessionId: string; request: SiteReportRequest } | null {
  const site = feedback.site_compatibility;
  const isSiteOutcome =
    feedback.feedback_type === "site_compatibility" ||
    feedback.feedback_type === "config_registry";
  if (!isSiteOutcome || !site?.browser_session_id) return null;

  const notes = [feedback.summary, feedback.friction_points, feedback.details]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, NOTES_MAX_LENGTH);
  const request: SiteReportRequest = {
    // The feedback schema accepts only the registrable domain, so the report
    // carries the site root rather than the page that was visited.
    url: `https://${site.registrable_domain}/`,
    outcome: site.observed_outcome,
    notes,
  };
  if (site.challenge_type) request.challenge_type = site.challenge_type;
  if (site.access_provider) request.access_provider = site.access_provider;
  if (site.reproducibility !== "unknown") {
    request.reproducibility = site.reproducibility;
  }
  if (feedback.user_request) request.task = feedback.user_request;
  if (feedback.feedback_type === "config_registry") {
    request.config_source = "config_registry";
    const analysisId = feedback.config_registry?.analysis_id;
    if (analysisId) request.config_registry_analysis_id = analysisId;
  } else {
    request.config_source = "custom";
  }
  return { browserSessionId: site.browser_session_id, request };
}

/**
 * Sends site-compatibility feedback that names a browser session to the Kernel
 * API as a site report, so it lands next to the session's telemetry instead of
 * only in analytics. Failures are swallowed: the report is a side channel and
 * must not change the feedback tool's result.
 */
export async function forwardSiteReport(
  feedback: KernelFeedback,
  extra: unknown,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  const report = siteReportFromFeedback(feedback);
  if (!report) return;
  const token = (extra as { http?: { authInfo?: { token?: string } } })?.http
    ?.authInfo?.token;
  if (!token) return;
  try {
    await dependencies
      .createKernelClient(token)
      .post(
        `/browsers/${encodeURIComponent(report.browserSessionId)}/site-reports`,
        { body: report.request },
      );
  } catch (error) {
    console.warn(
      "[feedback] site report forwarding failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
