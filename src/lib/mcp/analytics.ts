import { instrument } from "@posthog/mcp";
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
      enableExceptionAutocapture: true,
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

function clerkUserId(extra?: Record<string, unknown>): string | null {
  const authInfo = extra?.authInfo as
    | { extra?: { userId?: string | null } }
    | undefined;
  return authInfo?.extra?.userId ?? null;
}

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
    // The transport is stateless on Vercel, so a session id is not stable across
    // requests. Attribute to the Clerk user when the request carries a JWT; API-key
    // requests stay session-scoped.
    identify: async (_request, extra) => {
      const userId = clerkUserId(extra);
      return userId ? { distinctId: userId } : null;
    },
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
