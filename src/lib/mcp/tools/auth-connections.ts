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
    'Manage Kernel managed-auth connections programmatically in every client. Start protected-site tasks with action="list" and domain_filter. Actions: "create" creates a connection, "login" returns a hosted URL, "get" polls flow state and input metadata, "submit" provides fields or selects MFA/SSO, "delete" removes a connection, and "wait" verifies completion. App-capable clients additionally offer open_auth_login after user consent, but these programmatic actions remain available there too. Never echo submitted passwords or OTPs in responses.',
    {
      action: z
        .enum(["create", "list", "get", "delete", "login", "submit", "wait"])
        .describe("Operation to perform."),
      id: z
        .string()
        .min(1)
        .describe(
          "Auth connection ID. Required for get, delete, login, submit, and re-auth wait.",
        )
        .optional(),
      domain: z
        .string()
        .describe("(create) Target domain (e.g. 'netflix.com').")
        .optional(),
      profile_name: z
        .string()
        .describe(
          "(create) Profile to manage auth for. (list/wait) Exact profile_name filter.",
        )
        .optional(),
      allowed_domains: z
        .array(z.string())
        .describe("(create) Additional domains valid for this auth flow.")
        .optional(),
      credential_name: z
        .string()
        .describe("(create) Name of a pre-stored Kernel credential.")
        .optional(),
      credential_provider: z
        .string()
        .describe("(create) External credential provider name.")
        .optional(),
      credential_path: z
        .string()
        .describe("(create) Provider-specific credential item path.")
        .optional(),
      credential_auto: z
        .boolean()
        .describe("(create) Let the provider find credentials by domain.")
        .optional(),
      login_url: z
        .string()
        .describe("(create) Explicit login page URL.")
        .optional(),
      health_check_interval: z
        .number()
        .int()
        .describe("(create) Seconds between automatic re-auth checks.")
        .optional(),
      save_credentials: z
        .boolean()
        .describe("(create) Save credentials after successful login.")
        .optional(),
      proxy_id: z
        .string()
        .describe("(create/login) Proxy ID for the auth flow.")
        .optional(),
      proxy_name: z
        .string()
        .describe("(create/login) Proxy name for the auth flow.")
        .optional(),
      domain_filter: z
        .string()
        .describe("(list/wait) Exact domain filter.")
        .optional(),
      fields: z
        .record(z.string(), z.string())
        .describe("(submit) Field-name to value mapping.")
        .optional(),
      mfa_option_id: z
        .string()
        .describe("(submit) MFA option ID reported by get.")
        .optional(),
      sso_button_selector: z
        .string()
        .describe("(submit) XPath of an SSO button reported by get.")
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
        .describe(
          "(wait) Baseline timeline event supplied by open_auth_login; do not modify.",
        )
        .optional(),
      flow_wait_started_at: z
        .string()
        .min(1)
        .describe(
          "(wait) Baseline timestamp supplied by open_auth_login; do not modify.",
        )
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel managed auth connections",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);
      const buildProxy = () =>
        params.proxy_id || params.proxy_name
          ? {
              ...(params.proxy_id && { id: params.proxy_id }),
              ...(params.proxy_name && { name: params.proxy_name }),
            }
          : undefined;

      try {
        switch (params.action) {
          case "create": {
            if (!params.domain || !params.profile_name) {
              return errorResponse(
                "Error: domain and profile_name are required for create.",
              );
            }
            const hasName = !!params.credential_name;
            const hasProvider = !!params.credential_provider;
            const hasPath = !!params.credential_path;
            const autoTrue = params.credential_auto === true;
            if (hasName && (hasProvider || hasPath || autoTrue)) {
              return errorResponse(
                "Error: credential_name cannot be combined with credential_provider, credential_path, or credential_auto.",
              );
            }
            if ((hasPath || autoTrue) && !hasProvider) {
              return errorResponse(
                "Error: credential_path and credential_auto require credential_provider.",
              );
            }
            if (hasPath && autoTrue) {
              return errorResponse(
                "Error: credential_path and credential_auto: true are alternatives.",
              );
            }
            if (hasProvider && !hasPath && !autoTrue) {
              return errorResponse(
                "Error: credential_provider requires credential_path or credential_auto: true.",
              );
            }
            const credential =
              hasName || hasProvider
                ? {
                    ...(hasName && { name: params.credential_name }),
                    ...(hasProvider && {
                      provider: params.credential_provider,
                    }),
                    ...(hasPath && { path: params.credential_path }),
                    ...(autoTrue && { auto: true }),
                  }
                : undefined;
            const proxy = buildProxy();
            const connection = await client.auth.connections.create({
              domain: params.domain,
              profile_name: params.profile_name,
              ...(params.allowed_domains && {
                allowed_domains: params.allowed_domains,
              }),
              ...(credential && { credential }),
              ...(params.login_url && { login_url: params.login_url }),
              ...(params.health_check_interval !== undefined && {
                health_check_interval: params.health_check_interval,
              }),
              ...(params.save_credentials !== undefined && {
                save_credentials: params.save_credentials,
              }),
              ...(proxy && { proxy }),
            });
            if (!connection) {
              return errorResponse("Failed to create auth connection");
            }
            return safeJsonResponse({
              connection: toSafeAuthConnection(connection),
              instruction:
                "Connection created. In an App-capable client, use open_auth_login after user consent; otherwise call login to receive the hosted fallback URL.",
            });
          }
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
              interaction: {
                discovered_fields: connection.discovered_fields ?? null,
                mfa_options: connection.mfa_options ?? null,
                pending_sso_buttons: connection.pending_sso_buttons ?? null,
                sign_in_options: connection.sign_in_options ?? null,
                external_action_message:
                  connection.external_action_message ?? null,
                website_error: connection.website_error ?? null,
              },
              instruction:
                connection.status === "AUTHENTICATED"
                  ? // Match waitForAuthConnection: a live in-progress flow means
                    // a (re-)auth is still running, so the current state is not
                    // settled yet.
                    hasLiveAuthFlow(safe)
                    ? "An authentication flow is still in progress for this connection. Call manage_auth_connections with action=wait and this id; create the browser only after it returns authenticated."
                    : "Authentication is verified. Use this profile_name when creating the browser."
                  : "Authentication is required. Prefer open_auth_login after user consent; clients without MCP Apps may use login, get, and submit.",
            });
          }
          case "delete": {
            if (!params.id) {
              return errorResponse("Error: id is required for delete.");
            }
            await client.auth.connections.delete(params.id);
            return safeJsonResponse({ deleted: true, id: params.id });
          }
          case "login": {
            if (!params.id) {
              return errorResponse("Error: id is required for login.");
            }
            const proxy = buildProxy();
            const response = await client.auth.connections.login(
              params.id,
              proxy ? { proxy } : undefined,
            );
            return safeJsonResponse({
              id: response.id,
              flow_type: response.flow_type,
              flow_expires_at: response.flow_expires_at,
              hosted_url: response.hosted_url,
              ...(response.live_view_url && {
                live_view_url: response.live_view_url,
              }),
              instruction:
                "Share the hosted_url with the user. Poll with get or wait; use submit only for explicitly provided fallback inputs. Never repeat submitted values in responses.",
            });
          }
          case "submit": {
            if (!params.id) {
              return errorResponse("Error: id is required for submit.");
            }
            const hasFields =
              !!params.fields && Object.keys(params.fields).length > 0;
            if (
              !hasFields &&
              !params.mfa_option_id &&
              !params.sso_button_selector
            ) {
              return errorResponse(
                "Error: submit requires fields, mfa_option_id, or sso_button_selector.",
              );
            }
            const response = await client.auth.connections.submit(params.id, {
              ...(hasFields && { fields: params.fields }),
              ...(params.mfa_option_id && {
                mfa_option_id: params.mfa_option_id,
              }),
              ...(params.sso_button_selector && {
                sso_button_selector: params.sso_button_selector,
              }),
            });
            return safeJsonResponse({ accepted: response.accepted });
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
                ...(params.flow_wait_started_at !== undefined && {
                  flowWaitStartedAt: params.flow_wait_started_at,
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
