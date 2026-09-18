import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  instrument,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
  type BeforeSendFn,
  type McpAnalytics,
} from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import type {
  McpConnectionAnalyticsContext,
  McpConnectionContext,
} from "@/lib/mcp/auth-context";
import { MCP_INTENT_ARGUMENT_DESCRIPTION } from "@/lib/mcp/analytics-context";
import {
  type KernelFeedback,
  registerFeedbackTool,
} from "@/lib/mcp/tools/feedback";
import {
  KERNEL_MISSING_CAPABILITY_TOOL_NAME,
  type MissingCapabilityReport,
  registerMissingCapabilityTool,
} from "@/lib/mcp/tools/missing-capability";
import {
  clientDeclaresExtension,
  clientElicitationModes,
  initializeClientCapabilities,
  isRecord,
  MCP_APPS_EXTENSION,
  MCP_ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION,
  MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  MCP_TASKS_EXTENSION,
} from "@/lib/mcp/client-capabilities";

const projectToken = process.env.POSTHOG_PROJECT_TOKEN;

export type OAuthTokenExchangeAnalytics = {
  grantType: "authorization_code" | "refresh_token" | "unknown";
  clientType: "kernel_cli" | "registered_client" | "unknown";
  /** OAuth client_id, so a failure can be attributed to the client that caused it. */
  clientId?: string;
  accessScope: "organization" | "project" | "unknown";
  stage:
    | "request_validation"
    | "context_resolution"
    | "membership_validation"
    | "provider_exchange"
    | "provider_response_validation"
    | "persistence"
    | "complete";
  outcome: "success" | "error";
  errorCode?:
    | "invalid_request"
    | "invalid_grant"
    | "unsupported_grant_type"
    | "server_error";
  /** Upstream status when the provider rejected the exchange. */
  providerStatusCode?: number;
  /** Coarse RFC 6749 section 5.2 error code from the provider, or `unknown`
   * for anything outside that set. Narrows a failure; does not identify it. */
  providerErrorCode?: string;
  statusCode: number;
  durationMs: number;
};

export const OAUTH_TOKEN_EXCHANGE_EVENT = "oauth_token_exchange";

// Scope resolution runs before a request reaches the instrumented server, so a
// connection that never gets a scope emits no $mcp_* event. This is the only
// record of it.
export type McpConnectionScopeFailureAnalytics = {
  outcome: "rejected" | "unavailable" | "invalid";
  credentialType: "api_key" | "oauth";
  upstreamStatusCode?: number;
};

export const MCP_CONNECTION_SCOPE_FAILURE_EVENT =
  "mcp_connection_scope_failure";
export const MCP_FEEDBACK_SUBMITTED_EVENT = "mcp_feedback_submitted";
export const MCP_CAPABILITY_REQUESTED_EVENT = "mcp_capability_requested";

if (!projectToken && process.env.NODE_ENV !== "production") {
  console.error(
    "POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_PROJECT_TOKEN is configured",
  );
}

// Created once per lambda instance, never per request.
const posthog = projectToken
  ? new PostHog(projectToken, {
      host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

export const MCP_USED_PROJECT_ID_PROPERTY = "$mcp_used_project_id";
export const MCP_USED_PROJECT_PROPERTY = "$mcp_used_project";
export const MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY =
  "$mcp_client_supports_sampling";
export const MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY =
  "$mcp_client_supports_sampling_tools";
export const MCP_CLIENT_ELICITATION_MODE_PROPERTY =
  "$mcp_client_elicitation_mode";
export const MCP_CLIENT_SUPPORTS_APPS_PROPERTY = "$mcp_client_supports_apps";
export const MCP_CLIENT_SUPPORTS_TASKS_PROPERTY = "$mcp_client_supports_tasks";
export const MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY =
  "$mcp_client_supports_oauth_client_credentials";
export const MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY =
  "$mcp_client_supports_enterprise_auth";

type McpClientElicitationMode = "none" | "form" | "url" | "form_and_url";

type McpClientCapabilityAnalytics = {
  [MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY]: boolean;
  [MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY]: boolean;
  [MCP_CLIENT_ELICITATION_MODE_PROPERTY]: McpClientElicitationMode;
  [MCP_CLIENT_SUPPORTS_APPS_PROPERTY]: boolean;
  [MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]: boolean;
  [MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY]: boolean;
  [MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY]: boolean;
};

// Official extensions listed at https://modelcontextprotocol.io/extensions.
// Keep this explicit: arbitrary extension identifiers and settings must not enter analytics.
const CLIENT_EXTENSION_PROPERTIES = {
  [MCP_APPS_EXTENSION]: MCP_CLIENT_SUPPORTS_APPS_PROPERTY,
  [MCP_TASKS_EXTENSION]: MCP_CLIENT_SUPPORTS_TASKS_PROPERTY,
  [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION]:
    MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY,
  [MCP_ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION]:
    MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY,
} as const;

// Every property this integration sends. An allow-list rather than a deny-list so a
// property the pinned SDK doesn't emit today — a renamed payload field, a new one —
// can't start flowing on an upgrade. Deliberately absent: $mcp_parameters and
// $mcp_response (call payloads), and $mcp_error_message (the text a failed tool
// returned). $mcp_used_project_id / $mcp_used_project are presence flags only.
const SENT_PROPERTIES = new Set<string>([
  "$groups",
  "$insert_id",
  "$process_person_profile",
  "$mcp_auth_method",
  "$mcp_connection_scope",
  "$mcp_credential_scope",
  "$mcp_scope_source",
  MCP_USED_PROJECT_ID_PROPERTY,
  MCP_USED_PROJECT_PROPERTY,
  MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY,
  MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY,
  MCP_CLIENT_ELICITATION_MODE_PROPERTY,
  MCP_CLIENT_SUPPORTS_APPS_PROPERTY,
  MCP_CLIENT_SUPPORTS_TASKS_PROPERTY,
  MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY,
  MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY,
  PostHogMCPAnalyticsProperty.ClientName,
  PostHogMCPAnalyticsProperty.ClientVersion,
  PostHogMCPAnalyticsProperty.DurationMs,
  PostHogMCPAnalyticsProperty.ErrorType,
  PostHogMCPAnalyticsProperty.Intent,
  PostHogMCPAnalyticsProperty.IntentSource,
  PostHogMCPAnalyticsProperty.IsError,
  PostHogMCPAnalyticsProperty.ListedToolNames,
  PostHogMCPAnalyticsProperty.ProtocolVersion,
  PostHogMCPAnalyticsProperty.ResourceName,
  PostHogMCPAnalyticsProperty.ServerName,
  PostHogMCPAnalyticsProperty.ServerVersion,
  PostHogMCPAnalyticsProperty.SessionId,
  PostHogMCPAnalyticsProperty.Source,
  PostHogMCPAnalyticsProperty.ToolCategory,
  PostHogMCPAnalyticsProperty.ToolDescription,
  PostHogMCPAnalyticsProperty.ToolName,
  "feedback_summary",
  "feedback_type",
  "feedback_sentiment",
  "feedback_task_outcome",
  "feedback_affected_tool",
  "feedback_dedupe_key",
  "feedback_privacy_redacted",
  "feedback_product_area",
  "feedback_destination",
  "feedback_bot_detection_registrable_domain",
  "feedback_bot_detection_observed_outcome",
  "feedback_bot_detection_suspected_vendor",
  "feedback_bot_detection_challenge_type",
  "feedback_bot_detection_stealth",
  "feedback_bot_detection_proxy_type",
  "feedback_bot_detection_region",
  "feedback_bot_detection_browser_version",
  "feedback_bot_detection_browser_image_version",
  "feedback_bot_detection_reproducibility",
  "feedback_bot_detection_browser_session_id",
  "feedback_config_registry_request_method",
  "feedback_config_registry_analysis_id",
  "feedback_config_registry_recommendation_match_scope",
  "feedback_config_registry_recommendation_verification",
  "feedback_config_registry_evidence_sample_size",
  "feedback_config_registry_evidence_success_rate",
  "feedback_config_registry_evidence_last_verified_at",
  "feedback_config_registry_applied_config_key",
  "feedback_config_registry_browser_stealth",
  "feedback_config_registry_browser_headless",
  "feedback_config_registry_browser_gpu",
  "feedback_config_registry_viewport_width",
  "feedback_config_registry_viewport_height",
  "feedback_config_registry_viewport_refresh_rate",
  "feedback_config_registry_proxy_mode",
  "feedback_config_registry_proxy_type",
  "feedback_config_registry_proxy_country",
  "feedback_category",
  "feedback_task_completed",
  "feedback_tools_used",
  "feedback_friction_points",
  "feedback_suggested_improvement",
  "feedback_user_request",
  "feedback_details",
  "missing_capability_gap_reason",
  "missing_capability_destination",
  "missing_capability_area",
  "missing_capability_name",
  "missing_capability_requested_action",
  "missing_capability_task_outcome",
  "missing_capability_tools_checked",
  "missing_capability_dedupe_key",
  "missing_capability_privacy_redacted",
]);

// Free-form analytics text is agent-written. Intent stays long enough for the 15-25 words
// requested by the schema but short enough that a client ignoring the instruction cannot
// stream a payload or prompt into one event property.
const INTENT_MAX_LENGTH = 300;

// Instructions remain the first privacy boundary, but feedback has enough free-form fields
// that recognizable identifiers must also be removed server-side. Plain organization and
// person names cannot be identified reliably without false positives, so schemas still tell
// agents to anonymize them.
const INTENT_REDACTIONS: readonly [RegExp, string][] = [
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]"],
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/(?<!\w)(?:~\/|\/)(?:[\w.-]+\/)+[\w.-]+/g, "[path]"],
  [/\b[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]+/gi, "[path]"],
  [/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi, "[domain]"],
  [
    /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{20,}\b/g,
    "[token]",
  ],
  [
    /\b(?:[0-9a-f]{32,}|(?:sk|pk|rk|whsec|ghp|glpat|github_pat|xox[abprs])[_-][A-Za-z0-9_-]{8,})\b/gi,
    "[token]",
  ],
];

/**
 * Reduces the client-controlled initialize capability map to bounded analytics.
 * MCP capability declarations count only when their settings are objects.
 */
export function clientCapabilityAnalyticsFromInitialize(
  body: unknown,
): McpClientCapabilityAnalytics | null {
  const capabilities = initializeClientCapabilities(body);
  if (!capabilities) return null;

  const sampling = isRecord(capabilities.sampling)
    ? capabilities.sampling
    : null;
  const { supportsFormMode, supportsUrlMode } =
    clientElicitationModes(capabilities);
  let elicitationMode: McpClientElicitationMode = "none";
  if (supportsFormMode) {
    elicitationMode = supportsUrlMode ? "form_and_url" : "form";
  } else if (supportsUrlMode) {
    elicitationMode = "url";
  }

  const properties: McpClientCapabilityAnalytics = {
    [MCP_CLIENT_SUPPORTS_SAMPLING_PROPERTY]: sampling !== null,
    [MCP_CLIENT_SUPPORTS_SAMPLING_TOOLS_PROPERTY]:
      sampling !== null && isRecord(sampling.tools),
    [MCP_CLIENT_ELICITATION_MODE_PROPERTY]: elicitationMode,
    [MCP_CLIENT_SUPPORTS_APPS_PROPERTY]: false,
    [MCP_CLIENT_SUPPORTS_TASKS_PROPERTY]: isRecord(capabilities.tasks),
    [MCP_CLIENT_SUPPORTS_OAUTH_CLIENT_CREDENTIALS_PROPERTY]: false,
    [MCP_CLIENT_SUPPORTS_ENTERPRISE_AUTH_PROPERTY]: false,
  };

  for (const [extension, property] of Object.entries(
    CLIENT_EXTENSION_PROPERTIES,
  )) {
    if (clientDeclaresExtension(capabilities, extension)) {
      properties[property] = true;
    }
  }

  return properties;
}

function hasNonEmptyParam(
  args: Record<string, unknown> | undefined,
  key: string,
) {
  if (!args || !Object.prototype.hasOwnProperty.call(args, key)) return false;
  const value = args[key];
  return value !== undefined && value !== "";
}

// $mcp_parameters is { request: { params: { arguments: { ...tool args } } } }.
function toolCallArguments(
  properties: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parameters = properties[PostHogMCPAnalyticsProperty.Parameters];
  if (!isRecord(parameters) || !isRecord(parameters.request)) return undefined;
  const params = parameters.request.params;
  if (!isRecord(params) || !isRecord(params.arguments)) return undefined;
  return params.arguments;
}

function annotateProjectParamUsage(properties: Record<string, unknown>) {
  const args = toolCallArguments(properties);
  properties[MCP_USED_PROJECT_ID_PROPERTY] = hasNonEmptyParam(
    args,
    "project_id",
  );
  properties[MCP_USED_PROJECT_PROPERTY] = hasNonEmptyParam(args, "project");
}

const IPV6_CANDIDATE_PATTERN =
  /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,}(?:[A-Fa-f0-9]{0,4}|(?:\d{1,3}\.){3}\d{1,3})(?:%[A-Za-z0-9_.-]+)?(?![A-Za-z0-9:.])/g;

function redactAnalyticsTextWithStatus(text: string) {
  let value = text.trim();
  let redacted = false;
  const withoutIpv6 = value.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
    isIP(candidate) === 6 ? "[ip]" : candidate,
  );
  redacted ||= withoutIpv6 !== value;
  value = withoutIpv6;
  for (const [pattern, replacement] of INTENT_REDACTIONS) {
    const next = value.replace(pattern, replacement);
    redacted ||= next !== value;
    value = next;
  }
  return { value, redacted };
}

function redactAnalyticsText(text: string) {
  return redactAnalyticsTextWithStatus(text).value;
}

function sanitizeIntent(intent: string) {
  return redactAnalyticsText(intent).slice(0, INTENT_MAX_LENGTH);
}

const ANALYTICS_CONTEXT_PROPERTY = "__mcp_connection_analytics_context";

/**
 * Enforces the SENT_PROPERTIES allow-list on every event the SDK builds and sanitizes
 * the free-form intent.
 */
export const sanitizeMcpAnalyticsEvent: BeforeSendFn = (event) => {
  if (event.event === PostHogMCPAnalyticsEvent.Exception) return null;

  const properties = event.properties;
  if (!properties) return event;
  enrichMcpAnalyticsEvent(event);
  if (event.event === PostHogMCPAnalyticsEvent.ToolCall) {
    annotateProjectParamUsage(properties);
    const errorMessage = properties[PostHogMCPAnalyticsProperty.ErrorMessage];
    if (
      properties[PostHogMCPAnalyticsProperty.ToolName] ===
        KERNEL_MISSING_CAPABILITY_TOOL_NAME &&
      properties[PostHogMCPAnalyticsProperty.IsError] === true &&
      properties[PostHogMCPAnalyticsProperty.ErrorType] === "Error" &&
      typeof errorMessage === "string" &&
      errorMessage.includes("Input validation error")
    ) {
      properties[PostHogMCPAnalyticsProperty.ErrorType] = "validation";
    }
  }

  for (const key of Object.keys(properties)) {
    if (!SENT_PROPERTIES.has(key)) delete properties[key];
  }

  // Only a string is an intent. Anything else is a client sending an object or an array
  // through the argument, which would land in PostHog as a serialized payload.
  const intent = properties[PostHogMCPAnalyticsProperty.Intent];
  const sanitized = typeof intent === "string" ? sanitizeIntent(intent) : "";
  if (sanitized) {
    properties[PostHogMCPAnalyticsProperty.Intent] = sanitized;
  } else {
    delete properties[PostHogMCPAnalyticsProperty.Intent];
  }

  // The SDK answers a get_more_tools call before the registered schema validates it, so a
  // report can arrive with no usable context: missing, blank, or not a string. The reported
  // gap is the entire event, so drop the ones that don't carry one rather than count them.
  if (
    event.event === PostHogMCPAnalyticsEvent.MissingCapability &&
    !sanitized
  ) {
    return null;
  }

  return event;
};

/** Extracts the analytics identity resolved during MCP authentication. */
function connectionAnalyticsContext(extra: unknown) {
  const authInfo = (extra as { authInfo?: { extra?: unknown } } | undefined)
    ?.authInfo;
  const authExtra = authInfo?.extra as
    | { connectionAnalytics?: McpConnectionAnalyticsContext }
    | undefined;
  return authExtra?.connectionAnalytics;
}

// The route resolves the Kernel connection context at auth time and attaches it to
// authInfo.extra on every request, so reading the org id out of the request extras
// adds no I/O.
function connectionOrgId(extra: unknown) {
  const authInfo = (extra as { authInfo?: { extra?: unknown } } | undefined)
    ?.authInfo;
  const authExtra = authInfo?.extra as
    | { connectionContext?: McpConnectionContext | null }
    | undefined;
  return authExtra?.connectionContext?.scope.organizationId;
}

export function captureMcpCustomEvent(
  analytics: McpAnalytics,
  extra: unknown,
  event: string,
  properties: Record<string, unknown>,
) {
  const organizationId = connectionOrgId(extra);
  return analytics.capture({
    event,
    properties: {
      ...properties,
      ...(organizationId && { $groups: { organization: organizationId } }),
    },
  });
}

function analyticsDedupeKey(parts: (string | undefined)[]) {
  return createHash("sha256")
    .update(parts.filter(Boolean).join(":"))
    .digest("hex")
    .slice(0, 16);
}

export function captureMissingCapabilityReport(
  report: MissingCapabilityReport,
  extra: unknown,
  analytics: McpAnalytics,
) {
  const context = report.context
    ? redactAnalyticsTextWithStatus(report.context)
    : { value: "", redacted: false };
  const capability = redactAnalyticsTextWithStatus(report.capability);
  const destination =
    report.gap_reason === "kernel_capability_missing"
      ? "kernel_product_demand"
      : "external_integration_demand";

  return captureMcpCustomEvent(
    analytics,
    extra,
    MCP_CAPABILITY_REQUESTED_EVENT,
    {
      [PostHogMCPAnalyticsProperty.Intent]: (
        context.value || capability.value
      ).slice(0, INTENT_MAX_LENGTH),
      missing_capability_gap_reason: report.gap_reason,
      missing_capability_destination: destination,
      missing_capability_area: report.capability_area,
      missing_capability_name: capability.value,
      missing_capability_requested_action: report.requested_action,
      missing_capability_task_outcome: report.task_outcome,
      missing_capability_tools_checked: report.tools_checked,
      missing_capability_dedupe_key: analyticsDedupeKey([
        destination,
        report.capability_area,
        report.requested_action,
        capability.value.toLowerCase(),
      ]),
      missing_capability_privacy_redacted:
        context.redacted || capability.redacted,
    },
  );
}

export function enrichMcpAnalyticsEvent(event: {
  event: string;
  distinct_id: string;
  properties?: Record<string, unknown>;
}) {
  if (!event.properties) return event;

  const context = event.properties[ANALYTICS_CONTEXT_PROPERTY] as
    | McpConnectionAnalyticsContext
    | undefined;
  delete event.properties[ANALYTICS_CONTEXT_PROPERTY];

  if (event.event !== PostHogMCPAnalyticsEvent.Initialize || !context) {
    return event;
  }

  event.properties["$mcp_auth_method"] = context.authMethod;
  event.properties["$mcp_credential_scope"] = context.credentialScope;
  event.properties["$mcp_connection_scope"] = context.connectionScope;
  event.properties["$mcp_scope_source"] = context.scopeSource;
  const currentGroups = event.properties.$groups;
  event.properties.$groups = {
    ...(currentGroups &&
    typeof currentGroups === "object" &&
    !Array.isArray(currentGroups)
      ? currentGroups
      : {}),
    organization: context.organizationId,
  };

  const sessionId = event.properties[PostHogMCPAnalyticsProperty.SessionId];
  if (typeof sessionId === "string" && sessionId) {
    event.properties.$insert_id = `mcp-connection:${sessionId}`;
  }

  if (context.userId) {
    event.distinct_id = context.userId;
    delete event.properties.$process_person_profile;
  }

  return event;
}

export function isMcpAnalyticsEnabled() {
  return posthog !== null;
}

export function captureOAuthTokenExchange(
  exchange: OAuthTokenExchangeAnalytics,
  client: PostHog | null = posthog,
) {
  const properties = {
    oauth_grant_type: exchange.grantType,
    oauth_client_type: exchange.clientType,
    oauth_client_id: exchange.clientId,
    oauth_access_scope: exchange.accessScope,
    oauth_stage: exchange.stage,
    oauth_outcome: exchange.outcome,
    oauth_error_code: exchange.errorCode,
    oauth_provider_status_code: exchange.providerStatusCode,
    oauth_provider_error_code: exchange.providerErrorCode,
    http_status_code: exchange.statusCode,
    duration_ms: exchange.durationMs,
  };

  console.info("[oauth] token exchange outcome", properties);
  if (!client) return;

  try {
    client.capture({
      distinctId: "oauth-token-exchange",
      event: OAUTH_TOKEN_EXCHANGE_EVENT,
      properties: {
        $process_person_profile: false,
        ...properties,
      },
    });
  } catch (error) {
    console.error("Failed to capture OAuth token exchange analytics", error);
  }
}

export function captureMcpConnectionScopeFailure(
  failure: McpConnectionScopeFailureAnalytics,
  client: PostHog | null = posthog,
) {
  if (!client) return;

  const properties = {
    connection_scope_outcome: failure.outcome,
    connection_credential_type: failure.credentialType,
    upstream_status_code: failure.upstreamStatusCode,
  };

  try {
    client.capture({
      distinctId: "mcp-connection-scope",
      event: MCP_CONNECTION_SCOPE_FAILURE_EVENT,
      properties: {
        $process_person_profile: false,
        ...properties,
      },
    });
  } catch (error) {
    console.error("Failed to capture MCP connection scope analytics", error);
  }
}

function configRegistryAppliedConfigKey(
  configRegistry: NonNullable<KernelFeedback["config_registry"]>,
) {
  const browser = configRegistry.applied_browser;
  const viewport = browser.viewport;
  const proxy = configRegistry.applied_proxy;
  const proxyKey =
    proxy.mode === "direct"
      ? "direct"
      : `managed-${proxy.type}-${proxy.country ?? "default"}`;
  return [
    `stealth-${browser.stealth}`,
    `headless-${browser.headless}`,
    `gpu-${browser.gpu}`,
    `viewport-${viewport.width}x${viewport.height}@${viewport.refresh_rate ?? "default"}`,
    `proxy-${proxyKey}`,
  ].join("|");
}

export function captureMcpFeedback(
  feedback: KernelFeedback,
  extra: unknown,
  analytics: McpAnalytics,
) {
  const isSiteOutcome =
    feedback.feedback_type === "bot_detection" ||
    feedback.feedback_type === "config_registry";
  const botDetection = isSiteOutcome ? feedback.bot_detection : undefined;
  const configRegistry =
    feedback.feedback_type === "config_registry"
      ? feedback.config_registry
      : undefined;

  let privacyRedacted = false;
  const safeText = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const sanitized = redactAnalyticsTextWithStatus(value);
    privacyRedacted ||= sanitized.redacted;
    return sanitized.value;
  };

  const summary = safeText(feedback.summary)!;
  const productArea = safeText(feedback.product_area);
  const suspectedVendor = safeText(botDetection?.suspected_vendor);
  const region = safeText(botDetection?.region);
  const browserVersion = safeText(botDetection?.browser_version);
  const browserImageVersion = safeText(botDetection?.browser_image_version);
  const browserSessionId = safeText(botDetection?.browser_session_id);
  const analysisId = safeText(configRegistry?.analysis_id);
  const toolsUsed = feedback.tools_used?.map((tool) => safeText(tool)!);
  const frictionPoints = safeText(feedback.friction_points);
  const suggestedImprovement = safeText(feedback.suggested_improvement);
  const userRequest = safeText(feedback.user_request);
  const details = safeText(feedback.details);

  const taskOutcome =
    feedback.task_outcome ??
    (feedback.task_completed === true
      ? "completed"
      : feedback.task_completed === false
        ? "blocked"
        : "unknown");
  const destination = configRegistry
    ? "config_registry_quality"
    : botDetection
      ? "config_registry_prioritization"
      : feedback.feedback_type === "mcp"
        ? feedback.category === "missing_tool"
          ? "legacy_capability_feedback"
          : feedback.affected_tool
            ? "mcp_quality"
            : "mcp_unclassified"
        : feedback.feedback_type === "product"
          ? !productArea
            ? "product_unclassified"
            : feedback.sentiment === "positive"
              ? "product_praise"
              : "product_feedback"
          : `${feedback.feedback_type}_feedback`;
  const appliedConfigKey = configRegistry
    ? configRegistryAppliedConfigKey(configRegistry)
    : undefined;
  const dedupeKey = configRegistry
    ? analyticsDedupeKey([
        "config_registry",
        analysisId ?? configRegistry.request_method,
        botDetection?.registrable_domain,
        appliedConfigKey,
        botDetection?.observed_outcome,
      ])
    : botDetection
      ? analyticsDedupeKey([
          "bot_detection",
          botDetection.registrable_domain,
          botDetection.observed_outcome,
          botDetection.reproducibility,
        ])
      : analyticsDedupeKey([
          feedback.feedback_type,
          feedback.affected_tool,
          productArea,
          feedback.category,
          summary.normalize("NFKC").toLowerCase().replace(/\s+/gu, " "),
        ]);

  return captureMcpCustomEvent(analytics, extra, MCP_FEEDBACK_SUBMITTED_EVENT, {
    feedback_summary: summary,
    feedback_type: feedback.feedback_type,
    feedback_sentiment: feedback.sentiment,
    feedback_task_outcome: taskOutcome,
    feedback_affected_tool: feedback.affected_tool,
    feedback_dedupe_key: dedupeKey,
    feedback_privacy_redacted: privacyRedacted,
    feedback_product_area: productArea,
    feedback_destination: destination,
    feedback_bot_detection_registrable_domain: botDetection?.registrable_domain,
    feedback_bot_detection_observed_outcome: botDetection?.observed_outcome,
    feedback_bot_detection_suspected_vendor: suspectedVendor,
    feedback_bot_detection_challenge_type: botDetection?.challenge_type,
    feedback_bot_detection_stealth: botDetection?.stealth,
    feedback_bot_detection_proxy_type: botDetection?.proxy_type,
    feedback_bot_detection_region: region,
    feedback_bot_detection_browser_version: browserVersion,
    feedback_bot_detection_browser_image_version: browserImageVersion,
    feedback_bot_detection_reproducibility: botDetection?.reproducibility,
    feedback_bot_detection_browser_session_id: browserSessionId,
    feedback_config_registry_request_method: configRegistry?.request_method,
    feedback_config_registry_analysis_id: analysisId,
    feedback_config_registry_recommendation_match_scope:
      configRegistry?.recommendation_match_scope,
    feedback_config_registry_recommendation_verification:
      configRegistry?.recommendation_verification,
    feedback_config_registry_evidence_sample_size:
      configRegistry?.recommendation_evidence.sample_size,
    feedback_config_registry_evidence_success_rate:
      configRegistry?.recommendation_evidence.success_rate,
    feedback_config_registry_evidence_last_verified_at:
      configRegistry?.recommendation_evidence.last_verified_at,
    feedback_config_registry_applied_config_key: appliedConfigKey,
    feedback_config_registry_browser_stealth:
      configRegistry?.applied_browser.stealth,
    feedback_config_registry_browser_headless:
      configRegistry?.applied_browser.headless,
    feedback_config_registry_browser_gpu: configRegistry?.applied_browser.gpu,
    feedback_config_registry_viewport_width:
      configRegistry?.applied_browser.viewport.width,
    feedback_config_registry_viewport_height:
      configRegistry?.applied_browser.viewport.height,
    feedback_config_registry_viewport_refresh_rate:
      configRegistry?.applied_browser.viewport.refresh_rate,
    feedback_config_registry_proxy_mode: configRegistry?.applied_proxy.mode,
    feedback_config_registry_proxy_type:
      configRegistry?.applied_proxy.mode === "managed"
        ? configRegistry.applied_proxy.type
        : undefined,
    feedback_config_registry_proxy_country:
      configRegistry?.applied_proxy.mode === "managed"
        ? configRegistry.applied_proxy.country
        : undefined,
    feedback_category: feedback.category,
    feedback_task_completed: feedback.task_completed,
    feedback_tools_used: toolsUsed,
    feedback_friction_points: frictionPoints,
    feedback_suggested_improvement: suggestedImprovement,
    feedback_user_request: userRequest,
    feedback_details: details,
  });
}

/**
 * Captures MCP protocol analytics and registers the analytics-backed reporting tools.
 * Feedback remains available when analytics is disabled so the tool contract is stable.
 */
export function instrumentMcpAnalytics(
  server: McpServer,
  client: PostHog | null = posthog,
) {
  if (!client) {
    registerMissingCapabilityTool(server);
    registerFeedbackTool(server);
    return;
  }

  // Register first so analytics wraps the legacy dispatch shim and records those calls.
  let analytics: McpAnalytics;
  registerMissingCapabilityTool(server, (report, extra) =>
    captureMissingCapabilityReport(report, extra, analytics),
  );

  analytics = instrument(server, client, {
    // The first-class get_more_tools handler validates and captures structured demand itself.
    // Point the SDK's name-based interception at an unadvertised name so calls to the real
    // tool reach its registered schema and callback even while reportMissing is disabled.
    reportMissing: false,
    missingCapabilityToolName: "__posthog_missing_capability_disabled",
    // Adds a required `context` argument to every advertised tool, which the agent fills
    // with why it is making the call. Recorded as $mcp_intent. The description replaces
    // the SDK default: it repeats per tool in every tools/list response, so it stays
    // short, and it names the arguments agents must not copy into it.
    context: { description: MCP_INTENT_ARGUMENT_DESCRIPTION },
    // A failed tool call otherwise fans out into a second `$exception` event whose
    // `$exception_list` is built from the text the tool returned.
    enableExceptionAutocapture: false,
    // Keep general MCP telemetry session-scoped. The initialize event alone uses the
    // canonical Kernel user ID when auth context identifies a user; API-key principals
    // remain anonymous because their principal ID identifies the credential itself.
    identify: null,
    // Attributes every event to the caller's organization via $groups — the same
    // convention as the Kernel API's own events (api_call sends $groups with
    // organization = org id). Stamped here rather than through the SDK's identify
    // callback because identify never runs for tools/list, and mcp-handler builds a
    // fresh McpServer per HTTP request, so the SDK's per-session identity cache is
    // always cold when a tools/list request arrives.
    //
    // The connection analytics context is present only on initialize. beforeSend turns
    // this private, typed value into allow-listed analytics properties and removes it
    // before capture.
    eventProperties: (request, extra) => {
      const orgId = connectionOrgId(extra);
      const properties: Record<string, unknown> = orgId
        ? { $groups: { organization: orgId } }
        : {};
      if (request.method === "initialize") {
        const context = connectionAnalyticsContext(extra);
        if (context) properties[ANALYTICS_CONTEXT_PROPERTY] = context;
        const capabilities = clientCapabilityAnalyticsFromInitialize(request);
        if (capabilities) Object.assign(properties, capabilities);
      }
      return Object.keys(properties).length > 0 ? properties : null;
    },
    // No part of a call is safe to capture: arguments carry free-form input (credential
    // field maps, curl headers and bodies, typed text, shell commands, Playwright
    // source), results are serialized to a JSON string (see jsonResponse) so the SDK's
    // key-name redaction can't see inside them, and a tool's error text is whatever
    // upstream returned. Send call metadata only.
    beforeSend: sanitizeMcpAnalyticsEvent,
  });

  registerFeedbackTool(server, (feedback, extra) =>
    captureMcpFeedback(feedback, extra, analytics),
  );
}

/**
 * Drains queued events after the response has been sent, so capture never adds
 * latency to a tool call.
 */
export async function flushMcpAnalytics() {
  if (!posthog) return;
  try {
    await posthog.flush();
  } catch (error) {
    console.error("Failed to flush PostHog MCP analytics events", error);
  }
}
