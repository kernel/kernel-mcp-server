import {
  decodeSessionId,
  deriveSessionIdFromMCPSession,
  getMoreToolsResult,
  instrument,
  MCP_SESSION_HEADER,
  newSessionId,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
  type BeforeSendFn,
} from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import { z } from "zod";
import type {
  McpConnectionAnalyticsContext,
  McpConnectionContext,
} from "@/lib/mcp/auth-context";
import {
  type KernelFeedback,
  registerFeedbackTool,
} from "@/lib/mcp/tools/feedback";
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
]);

const INTENT_ARGUMENT_DESCRIPTION =
  "Why this tool is being called and how it fits the user's overall goal, in 15-25 words, " +
  "third person. Used for product analytics. Never restate argument values, and never " +
  "include credentials, tokens, URLs, file contents, or personal data. Example: " +
  '"Inspecting a running browser session to diagnose a checkout automation that stopped ' +
  'responding partway through the flow."';

// Intent is the only free-form text this captures, and an agent writes it. Long enough for
// the 15-25 words asked for, short enough that a client ignoring the instruction can't
// stream a payload or a prompt into an event property.
const INTENT_MAX_LENGTH = 300;

// The intent descriptions ask agents to leave specifics out, and the agent writing the string
// is the only thing holding them to it. These cover the shapes that are unambiguous when one
// does slip through. They are not a substitute for the instruction: no pattern can tell that a
// plain noun is a customer's name, so an intent still has to be treated as agent-written prose.
//
// A capability gap is often named as a long snake_case or kebab-case identifier, and that name
// is the whole point of the report, so length alone can't stand in for a credential. What marks
// one is either a vendor prefix (Kernel API keys are sk_*) or an unbroken high-entropy run:
// mixed case with a digit, or hex. Separator-joined lowercase names match none of those.
const INTENT_REDACTIONS: readonly [RegExp, string][] = [
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]"],
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
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

function redactAnalyticsText(text: string) {
  return INTENT_REDACTIONS.reduce(
    (redacted, [pattern, replacement]) =>
      redacted.replace(pattern, replacement),
    text.trim(),
  );
}

function sanitizeIntent(intent: string) {
  return redactAnalyticsText(intent).slice(0, INTENT_MAX_LENGTH);
}

// Must stay the SDK's default name: reportMissing advertises a tool under this name and
// dispatches calls to it as capability reports, and the name is what ties the two together.
const MISSING_CAPABILITY_TOOL_NAME = "get_more_tools";

const MISSING_CAPABILITY_CONTEXT_DESCRIPTION =
  "The capability that is missing and what the user was trying to do, in 15-25 words, third " +
  "person. Used for product analytics. Name the capability, not the specifics: never include " +
  "credentials, tokens, URLs, domain or account names, file contents, or personal data. " +
  'Example: "Wanted to run one automation across several sessions at once; no tool exposes ' +
  'fan-out over a pool."';

/**
 * Advertises `get_more_tools`, which agents call when no tool covers what they were asked
 * to do. Registered here rather than left to `reportMissing` alone, which injects its own
 * descriptor only when no tool of this name exists: the SDK asks for "a description of
 * your goal" and skips the `context` description configured below, and this is the one
 * intent field describing the user's original ask, so it's the likeliest to carry a target
 * site or an account. The tool description itself is the SDK's — it's what gets an agent to
 * report a gap instead of giving up.
 *
 * The callback is the fallback path. `instrument` answers a call to this tool itself, with
 * this same result, and records `$mcp_missing_capability` instead of a tool call.
 */
function registerMissingCapabilityTool(server: McpServer) {
  server.tool(
    MISSING_CAPABILITY_TOOL_NAME,
    "Check for additional tools whenever your task might benefit from specialized capabilities - even if existing tools could work as a fallback.",
    {
      context: z.string().describe(MISSING_CAPABILITY_CONTEXT_DESCRIPTION),
    },
    {
      title: "Get more tools",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async () => getMoreToolsResult(),
  );
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

function connectionSessionId(extra: unknown) {
  const requestExtra = extra as
    | { requestInfo?: { headers?: unknown }; sessionId?: unknown }
    | undefined;
  const headers = requestExtra?.requestInfo?.headers;
  if (headers && typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    const key = Object.keys(record).find(
      (candidate) => candidate.toLowerCase() === MCP_SESSION_HEADER,
    );
    const value = key ? record[key] : undefined;
    const token = Array.isArray(value) ? value[0] : value;
    const decoded = decodeSessionId(token);
    if (decoded) return decoded.sessionId;
  }

  return typeof requestExtra?.sessionId === "string" && requestExtra.sessionId
    ? deriveSessionIdFromMCPSession(requestExtra.sessionId)
    : newSessionId();
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
    oauth_access_scope: exchange.accessScope,
    oauth_stage: exchange.stage,
    oauth_outcome: exchange.outcome,
    oauth_error_code: exchange.errorCode,
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

export function captureMcpFeedback(
  feedback: KernelFeedback,
  extra: unknown,
  client: PostHog | null = posthog,
) {
  if (!client) return;

  const organizationId = connectionOrgId(extra);

  client.capture({
    distinctId: connectionSessionId(extra),
    event: MCP_FEEDBACK_SUBMITTED_EVENT,
    properties: {
      $process_person_profile: false,
      ...(organizationId && { $groups: { organization: organizationId } }),
      feedback_summary: redactAnalyticsText(feedback.summary),
      feedback_type: feedback.feedback_type,
      feedback_sentiment: feedback.sentiment,
      feedback_product_area: feedback.product_area
        ? redactAnalyticsText(feedback.product_area)
        : undefined,
      feedback_category: feedback.category,
      feedback_task_completed: feedback.task_completed,
      feedback_tools_used: feedback.tools_used?.map(redactAnalyticsText),
      feedback_friction_points: feedback.friction_points
        ? redactAnalyticsText(feedback.friction_points)
        : undefined,
      feedback_suggested_improvement: feedback.suggested_improvement
        ? redactAnalyticsText(feedback.suggested_improvement)
        : undefined,
      feedback_user_request: feedback.user_request
        ? redactAnalyticsText(feedback.user_request)
        : undefined,
      feedback_details: feedback.details
        ? redactAnalyticsText(feedback.details)
        : undefined,
    },
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
  const captureFeedback = (feedback: KernelFeedback, extra: unknown) =>
    captureMcpFeedback(feedback, extra, client);
  if (!client) {
    registerFeedbackTool(server, captureFeedback);
    return;
  }

  instrument(server, client, {
    // Records a `$mcp_missing_capability` event, carrying the reported gap as $mcp_intent,
    // when an agent calls the tool registered by registerMissingCapabilityTool.
    reportMissing: true,
    missingCapabilityToolName: MISSING_CAPABILITY_TOOL_NAME,
    // Adds a required `context` argument to every advertised tool, which the agent fills
    // with why it is making the call. Recorded as $mcp_intent. The description replaces
    // the SDK default: it repeats per tool in every tools/list response, so it stays
    // short, and it names the arguments agents must not copy into it.
    context: { description: INTENT_ARGUMENT_DESCRIPTION },
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

  registerMissingCapabilityTool(server);
  registerFeedbackTool(server, captureFeedback);
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
