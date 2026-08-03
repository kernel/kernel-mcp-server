import {
  encodeSessionId,
  getMoreToolsResult,
  instrument,
  MCP_SESSION_HEADER,
  newSessionId,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import { z } from "zod";

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
  "$process_person_profile",
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
const INTENT_REDACTIONS: readonly [RegExp, string][] = [
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]"],
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[token]"],
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
    // Events are attributed to the analytics session, with no person created. The only
    // id this server holds is the Clerk subject, while every other producer in these
    // projects identifies people by their Kernel user id — identifying on the subject
    // would mint a second profile per person. Resolving the Kernel user id needs an
    // API that doesn't exist yet, so user-level reporting is out of scope until then.
    identify: null,
    // No part of a call is safe to capture: arguments carry free-form input (credential
    // field maps, curl headers and bodies, typed text, shell commands, Playwright
    // source), results are serialized to a JSON string (see jsonResponse) so the SDK's
    // key-name redaction can't see inside them, and a tool's error text is whatever
    // upstream returned. Send call metadata only.
    beforeSend: (event) => {
      if (event.event === PostHogMCPAnalyticsEvent.Exception) return null;

      const properties = event.properties;
      if (!properties) return event;

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

type InitializeRequestBody = {
  method?: string;
  params?: {
    clientInfo?: { name?: string; version?: string };
    protocolVersion?: string;
  };
};

/**
 * mcp-handler answers over SSE with a stateless transport, so it never issues an
 * `Mcp-Session-Id`. Left alone every request becomes its own PostHog session and the
 * client name is lost after the handshake. Mint the SDK's session token on the
 * initialize request instead: it goes back to the client on the response, the client
 * replays it, and any instance decodes the same session id and client info out of it.
 *
 * Returns the token, or null when there's nothing to mint. Safe on the stateless
 * transport, which ignores an incoming session id.
 */
export async function mintMcpSessionId(req: Request): Promise<string | null> {
  if (!posthog || req.headers.get(MCP_SESSION_HEADER)) return null;

  // Streamable HTTP only. The legacy SSE transport issues its own session id and its
  // clients don't replay ours, which would put the handshake in one session and the
  // calls that follow in another.
  if (!new URL(req.url).pathname.endsWith("/mcp")) return null;

  const body = (await req
    .clone()
    .json()
    .catch(() => null)) as InitializeRequestBody | null;
  if (body?.method !== "initialize") return null;

  return encodeSessionId({
    sessionId: newSessionId(),
    clientName: body.params?.clientInfo?.name,
    clientVersion: body.params?.clientInfo?.version,
    // Negotiated once, at the handshake. Carried in the token so the events after it
    // report it too.
    protocolVersion: body.params?.protocolVersion,
  });
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
