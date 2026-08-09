import {
  getMoreToolsResult,
  instrument,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import { z } from "zod";
import type { McpConnectionAnalyticsContext } from "@/lib/mcp/auth-context";

const projectToken = process.env.POSTHOG_PROJECT_TOKEN;

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

// Every property this integration sends. An allow-list rather than a deny-list so a
// property the pinned SDK doesn't emit today — a renamed payload field, a new one —
// can't start flowing on an upgrade. Deliberately absent: $mcp_parameters and
// $mcp_response (call payloads), and $mcp_error_message (the text a failed tool
// returned).
const SENT_PROPERTIES = new Set<string>([
  "$groups",
  "$insert_id",
  "$process_person_profile",
  "$mcp_auth_method",
  "$mcp_connection_scope",
  "$mcp_credential_scope",
  "$mcp_scope_source",
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

function sanitizeIntent(intent: string) {
  const redacted = INTENT_REDACTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    intent.trim(),
  );

  return redacted.slice(0, INTENT_MAX_LENGTH);
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

/**
 * Captures every tool call, tools/list, and initialize handled by the server as a
 * `$mcp_*` PostHog event, and advertises the tool agents use to report a capability the
 * server doesn't have. No-op when POSTHOG_PROJECT_TOKEN is unset.
 */
const ANALYTICS_CONTEXT_PROPERTY = "__mcp_connection_analytics_context";

function connectionAnalyticsContext(extra: unknown) {
  const authInfo = (extra as { authInfo?: { extra?: unknown } } | undefined)
    ?.authInfo;
  const authExtra = authInfo?.extra as
    | { connectionAnalytics?: McpConnectionAnalyticsContext }
    | undefined;
  return authExtra?.connectionAnalytics;
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
  event.properties.$groups = { organization: context.organizationId };

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

export function instrumentMcpAnalytics(server: McpServer) {
  if (!posthog) return;

  instrument(server, posthog, {
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
    // Connection context is present only on initialize. beforeSend turns this private,
    // typed value into allow-listed analytics properties and removes it before capture.
    eventProperties: (request, extra) => {
      if (request.method !== "initialize") return null;
      const context = connectionAnalyticsContext(extra);
      return context ? { [ANALYTICS_CONTEXT_PROPERTY]: context } : null;
    },
    // No part of a call is safe to capture: arguments carry free-form input (credential
    // field maps, curl headers and bodies, typed text, shell commands, Playwright
    // source), results are serialized to a JSON string (see jsonResponse) so the SDK's
    // key-name redaction can't see inside them, and a tool's error text is whatever
    // upstream returned. Send call metadata only.
    beforeSend: (event) => {
      if (event.event === PostHogMCPAnalyticsEvent.Exception) return null;

      const properties = event.properties;
      if (!properties) return event;
      enrichMcpAnalyticsEvent(event);

      for (const key of Object.keys(properties)) {
        if (!SENT_PROPERTIES.has(key)) delete properties[key];
      }

      // Only a string is an intent. Anything else is a client sending an object or an array
      // through the argument, which would land in PostHog as a serialized payload.
      const intent = properties[PostHogMCPAnalyticsProperty.Intent];
      const sanitized =
        typeof intent === "string" ? sanitizeIntent(intent) : "";
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
    },
  });

  registerMissingCapabilityTool(server);
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
