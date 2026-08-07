import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  AuthLoginStartError,
  waitForAuthConnection,
} from "@/lib/mcp/tools/managed-auth-state";
import { managedAuthBrowserTelemetrySchema } from "@/lib/mcp/tools/managed-auth-telemetry";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectIDFromParams,
  projectSelectionInputSchema,
  type ProjectSelectionOptions,
} from "@/lib/mcp/project-selection";

// The additive wait action returns a sanitized snapshot (safeJsonResponse);
// every pre-existing action keeps its established raw response shape.
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

export function registerAuthConnectionTools(
  server: McpServer,
  options: ProjectSelectionOptions = {},
) {
  // manage_auth_connections -- Manage Kernel managed auth connections
  server.tool(
    "manage_auth_connections",
    'Manage reusable authenticated profiles for third-party websites. Before a browser task that needs a user account, call "list" with the exact domain_filter and inspect every page. If one relevant connection is AUTHENTICATED, create the browser with its profile_name. If multiple relevant accounts exist, ask the user which one to use. If authentication is needed and open_auth_login is available, prefer that secure App so credentials and MFA never enter chat: a direct user request to log in is already consent; if login is only discovered incidentally, ask first. For a new App login, choose a concise stable profile name derived from the service unless the user specified one. The programmatic actions remain available for every client: "create" a connection, "login" to start a hosted flow, "submit" fields/MFA/SSO, "get" status, "delete", or "wait" for completion. After authentication, resume the original task with manage_browsers using the verified profile_name.',
    {
      ...projectSelectionInputSchema(options.projectSelection),
      action: z
        .enum(["create", "list", "get", "delete", "login", "submit", "wait"])
        .describe("Operation to perform."),
      id: z
        .string()
        .describe(
          "Auth connection ID. Required for get, delete, login, submit.",
        )
        .optional(),
      domain: z
        .string()
        .describe("(create) Target domain (e.g. 'netflix.com').")
        .optional(),
      profile_name: z
        .string()
        .describe(
          "(create) Profile to manage auth for. (list) Filter by profile_name.",
        )
        .optional(),
      allowed_domains: z
        .array(z.string())
        .describe(
          "(create) Additional domains valid for this auth flow. Common SSO providers (Google, Microsoft, Okta, Auth0, Apple, GitHub, Facebook, LinkedIn, Cognito, OneLogin, Ping) are allowed by default.",
        )
        .optional(),
      credential_name: z
        .string()
        .describe(
          "(create) Name of a pre-stored Kernel credential to use for automatic login.",
        )
        .optional(),
      credential_provider: z
        .string()
        .describe(
          "(create) External credential provider name (e.g. '1password'). Use with credential_path or credential_auto.",
        )
        .optional(),
      credential_path: z
        .string()
        .describe(
          "(create) Provider-specific item path (e.g. 'VaultName/ItemName').",
        )
        .optional(),
      credential_auto: z
        .boolean()
        .describe(
          "(create) If true, the provider auto-looks up credentials by domain.",
        )
        .optional(),
      login_url: z
        .string()
        .describe(
          "(create) Optional explicit login page URL to skip discovery.",
        )
        .optional(),
      health_check_interval: z
        .number()
        .int()
        .describe(
          "(create) Seconds between automatic re-auth checks. Plan-dependent minimum, max 86400.",
        )
        .optional(),
      save_credentials: z
        .boolean()
        .describe(
          "(create) Save credentials after each successful login. Default true.",
        )
        .optional(),
      record_session: z
        .boolean()
        .describe(
          "(create) Set the connection default for recording replay video of future login, reauth, and health-check browser sessions. (login) Override that default for this login only. Omitted preserves the API default/inheritance behavior.",
        )
        .optional(),
      browser_telemetry: managedAuthBrowserTelemetrySchema
        .describe(
          "(create) Set the connection default for browser telemetry. (login) Override it for this login only. Use { enabled: true } for the default operational categories (control, connection, system, captcha); add browser category flags to opt into console, network, page, interaction, or screenshot capture. Omitted preserves API default/inheritance behavior.",
        )
        .optional(),
      proxy_id: z
        .string()
        .min(1)
        .describe("(create, login) Proxy ID to route the auth flow through.")
        .optional(),
      proxy_name: z
        .string()
        .min(1)
        .describe("(create, login) Proxy name to route the auth flow through.")
        .optional(),
      domain_filter: z.string().describe("(list) Filter by domain.").optional(),
      ...paginationParams,
      fields: z
        .record(z.string(), z.string())
        .describe(
          "(submit) Map of field name to value (e.g. { mfa_code: '123456' }). Look at discovered_fields from `get` to know what to provide.",
        )
        .optional(),
      mfa_option_id: z
        .string()
        .describe(
          "(submit) ID of the MFA option to use, from mfa_options on the connection.",
        )
        .optional(),
      sso_button_selector: z
        .string()
        .describe(
          "(submit) XPath of an SSO button to click instead of submitting fields.",
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
      flow_checkpoint: z
        .string()
        .min(1)
        .describe(
          "(wait) Signed flow checkpoint supplied by open_auth_login or begin_auth_login; forward it unchanged.",
        )
        .optional(),
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
      const client = createKernelClient(
        extra.authInfo.token,
        projectIDFromParams(params),
      );

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
                "Error: credential_name cannot be combined with credential_provider, credential_path, or credential_auto. Use one of: { credential_name } for Kernel credentials, { credential_provider, credential_path } for an external provider item, or { credential_provider, credential_auto: true } for provider domain lookup.",
              );
            }
            if ((hasPath || autoTrue) && !hasProvider) {
              return errorResponse(
                "Error: credential_path and credential_auto require credential_provider.",
              );
            }
            if (hasPath && autoTrue) {
              return errorResponse(
                "Error: credential_path and credential_auto: true are alternatives — provide exactly one.",
              );
            }
            if (hasProvider && !hasPath && !autoTrue) {
              return errorResponse(
                "Error: credential_provider requires either credential_path or credential_auto: true.",
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
              ...(params.record_session !== undefined && {
                record_session: params.record_session,
              }),
              ...(params.browser_telemetry !== undefined && {
                browser_telemetry: params.browser_telemetry,
              }),
              ...(proxy && { proxy }),
            });
            if (!connection)
              return errorResponse("Failed to create auth connection");
            return jsonResponse(connection);
          }
          case "list": {
            const page = await client.auth.connections.list({
              ...(params.profile_name && { profile_name: params.profile_name }),
              ...(params.domain_filter && { domain: params.domain_filter }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.id)
              return errorResponse("Error: id is required for get.");
            const connection = await client.auth.connections.retrieve(
              params.id,
            );
            return jsonResponse(connection);
          }
          case "delete": {
            if (!params.id)
              return errorResponse("Error: id is required for delete.");
            await client.auth.connections.delete(params.id);
            return textResponse("Auth connection deleted successfully");
          }
          case "login": {
            if (!params.id)
              return errorResponse("Error: id is required for login.");
            const proxy = buildProxy();
            const hasOverrides =
              !!proxy ||
              params.record_session !== undefined ||
              params.browser_telemetry !== undefined;
            const response = await client.auth.connections.login(
              params.id,
              hasOverrides
                ? {
                    ...(proxy && { proxy }),
                    ...(params.record_session !== undefined && {
                      record_session: params.record_session,
                    }),
                    ...(params.browser_telemetry !== undefined && {
                      browser_telemetry: params.browser_telemetry,
                    }),
                  }
                : undefined,
            );
            return jsonResponse(response);
          }
          case "submit": {
            if (!params.id)
              return errorResponse("Error: id is required for submit.");
            const hasFields =
              !!params.fields && Object.keys(params.fields).length > 0;
            if (
              !hasFields &&
              !params.mfa_option_id &&
              !params.sso_button_selector
            )
              return errorResponse(
                "Error: submit requires at least one of fields (non-empty), mfa_option_id, or sso_button_selector.",
              );
            const response = await client.auth.connections.submit(params.id, {
              ...(hasFields && { fields: params.fields }),
              ...(params.mfa_option_id && {
                mfa_option_id: params.mfa_option_id,
              }),
              ...(params.sso_button_selector && {
                sso_button_selector: params.sso_button_selector,
              }),
            });
            return jsonResponse(response);
          }
          case "wait": {
            if (!params.id && (!params.domain_filter || !params.profile_name)) {
              return errorResponse(
                "Error: wait requires id, or both domain_filter and profile_name.",
              );
            }
            if (params.flow_checkpoint && !params.id) {
              return errorResponse(
                "Error: a flow_checkpoint wait requires its connection id.",
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
                ...(params.flow_checkpoint && {
                  flowCheckpoint: params.flow_checkpoint,
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
                    ? "Authentication did not complete. Explain the safe error and ask whether to retry the login flow."
                    : "Authentication is still pending. Immediately call manage_auth_connections with action=wait and the same selector again. Do not ask the user to report completion.",
            });
          }
        }
      } catch (error) {
        if (error instanceof AuthLoginStartError) {
          return errorResponse(error.safeMessage);
        }
        throwToolError("manage_auth_connections", params.action, error);
      }
    },
  );
}
