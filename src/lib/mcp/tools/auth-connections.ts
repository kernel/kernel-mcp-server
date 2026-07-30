import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  AuthLoginStartError,
  deriveAuthNextAction,
  hasLiveAuthFlow,
  toSafeAuthConnection,
  waitForAuthConnection,
} from "@/lib/mcp/tools/managed-auth-state";
import { errorResponse } from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

function safeJsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value as Record<string, unknown>,
  };
}

export function registerAuthConnectionTools(server: McpServer) {
  server.tool(
    "manage_auth_connections",
    'Discover and wait for sanitized Kernel managed-auth connections. Start every protected-site task with action="list" and domain_filter. Reason over all pages: use an AUTHENTICATED profile with manage_browsers, ask the user to choose when multiple profiles match, or ask for consent before calling open_auth_login for a new login/re-auth. After open_auth_login, immediately follow its next_action by calling action="wait"; repeat while state is pending so the current agent turn resumes automatically when authentication completes. Never ask the user to send passwords, OTPs, or MFA values in conversation. Connection creation, deletion, login, and credential mutation are intentionally outside this model-facing tool. Actions: list, get, wait.',
    {
      action: z.enum(["list", "get", "wait"]).describe("Read operation."),
      id: z
        .string()
        .min(1)
        .describe("Auth connection ID. Required for get and re-auth wait.")
        .optional(),
      profile_name: z
        .string()
        .describe("Exact profile_name filter for list or new-login wait.")
        .optional(),
      domain_filter: z
        .string()
        .describe(
          "Domain to match for list or new-login wait. Always set this when discovering a profile for a protected site.",
        )
        .optional(),
      wait_seconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .describe("(wait) Long-poll duration. Defaults to 25 seconds.")
        .optional(),
      required_flow_type: z
        .enum(["LOGIN", "REAUTH"])
        .describe("(wait) Require this newly completed flow type.")
        .optional(),
      previous_flow_expires_at: z
        .string()
        .nullable()
        .describe(
          "(wait) Baseline flow expiry supplied by open_auth_login; do not modify.",
        )
        .optional(),
      previous_flow_event_id: z
        .string()
        .min(1)
        .nullable()
        .describe(
          "(wait) Baseline timeline event supplied by open_auth_login; do not modify.",
        )
        .optional(),
      ...paginationParams,
    },
    {
      title: "Discover Kernel managed auth connections",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const page = await client.auth.connections.list({
              ...(params.profile_name && { profile_name: params.profile_name }),
              ...(params.domain_filter && { domain: params.domain_filter }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page.getPaginatedItems().map(toSafeAuthConnection);
            const hasMore = page.hasNextPage();
            const nextOffset = page.next_offset ?? null;
            const steering = deriveAuthNextAction({
              items,
              hasMore,
              nextOffset,
              offset: params.offset,
              domainFilter: params.domain_filter,
              profileFilter: params.profile_name,
            });
            return safeJsonResponse({
              items,
              has_more: hasMore,
              next_offset: nextOffset,
              ...steering,
            });
          }
          case "get": {
            if (!params.id) {
              return errorResponse("Error: id is required for get.");
            }
            const connection = await client.auth.connections.retrieve(
              params.id,
            );
            const safe = toSafeAuthConnection(connection);
            return safeJsonResponse({
              connection: safe,
              instruction:
                connection.status === "AUTHENTICATED"
                  ? // Match waitForAuthConnection: a live in-progress flow means
                    // a (re-)auth is still running, so the current state is not
                    // settled yet.
                    hasLiveAuthFlow(safe)
                    ? "An authentication flow is still in progress for this connection. Call manage_auth_connections with action=wait and this id; create the browser only after it returns authenticated."
                    : "Authentication is verified. Use this profile_name when creating the browser."
                  : "Do not continue the protected action. Ask for consent, then use open_auth_login to authenticate securely.",
            });
          }
          case "wait": {
            if (!params.id && (!params.domain_filter || !params.profile_name)) {
              return errorResponse(
                "Error: wait requires id, or both domain_filter and profile_name.",
              );
            }
            const result = await waitForAuthConnection(
              client,
              {
                ...(params.id && { connectionId: params.id }),
                ...(params.domain_filter && { domain: params.domain_filter }),
                ...(params.profile_name && {
                  profileName: params.profile_name,
                }),
                ...(params.required_flow_type && {
                  requiredFlowType: params.required_flow_type,
                }),
                ...(params.previous_flow_expires_at !== undefined && {
                  previousFlowExpiresAt: params.previous_flow_expires_at,
                }),
                ...(params.previous_flow_event_id !== undefined && {
                  previousFlowEventId: params.previous_flow_event_id,
                }),
              },
              {
                timeoutMs: (params.wait_seconds ?? 25) * 1_000,
                signal: extra.signal,
              },
            );
            return safeJsonResponse({
              ...result,
              instruction:
                result.state === "authenticated"
                  ? "Authentication is verified. Continue the pending task now, using this profile_name when creating the browser."
                  : result.state === "failed"
                    ? "Authentication did not complete. Explain the safe error and ask whether to retry open_auth_login."
                    : "Authentication is still pending. Immediately call manage_auth_connections with action=wait and the same selector again. Do not ask the user to report completion.",
            });
          }
        }
      } catch (error) {
        return errorResponse(
          error instanceof AuthLoginStartError
            ? error.safeMessage
            : `Managed-auth ${params.action} failed. Retry or choose a different recovery option.`,
        );
      }
    },
  );
}
