import {
  encodeSessionId,
  instrument,
  MCP_SESSION_HEADER,
  newSessionId,
  PostHogMCPAnalyticsEvent,
  PostHogMCPAnalyticsProperty,
} from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";

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
// $mcp_response (call payloads), $mcp_error_message (the text a failed tool returned),
// and $mcp_intent / $mcp_intent_source (agent-written, and intent capture is off).
const SENT_PROPERTIES = new Set<string>([
  "$groups",
  "$process_person_profile",
  PostHogMCPAnalyticsProperty.ClientName,
  PostHogMCPAnalyticsProperty.ClientVersion,
  PostHogMCPAnalyticsProperty.DurationMs,
  PostHogMCPAnalyticsProperty.ErrorType,
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

/**
 * Captures every tool call, tools/list, and initialize handled by the server as a
 * `$mcp_*` PostHog event. No-op when POSTHOG_PROJECT_TOKEN is unset.
 */
export function instrumentMcpAnalytics(server: McpServer) {
  if (!posthog) return;

  instrument(server, posthog, {
    // Intent capture injects a required `context` argument into every tool schema.
    // Left off so the public tool surface is unchanged.
    context: false,
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

      return event;
    },
  });
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
