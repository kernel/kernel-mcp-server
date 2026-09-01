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
  projectForOperation,
  projectSelectionInputSchema,
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

export function registerAuthConnectionTools(server: McpServer) {
  // manage_auth_connections -- Manage Kernel managed auth connections
  server.tool(
    "manage_auth_connections",
    'Manage reusable authenticated profiles for third-party websites. Before a browser task that needs a user account, call "list" with the exact domain_filter and inspect every page. If one relevant connection is AUTHENTICATED, create the browser with its profile_name. If multiple relevant accounts exist, ask the user which one to use. If authentication is needed and open_auth_login is available, prefer that secure App so credentials and MFA never enter chat: a direct user request to log in is already consent; if login is only discovered incidentally, ask first. For a new App login, choose a concise stable profile name derived from the service unless the user specified one. The programmatic actions remain available for every client: "create" or "update" a connection, "login" to start a hosted flow, "submit" fields or choices, "get" status, inspect the "timeline", "delete", or "wait" for completion. Prefer interaction_id with canonical field_values or selected_choice_id when the connection returns fields or choices. After authentication, resume the original task with manage_browsers using the verified profile_name.',
    {
      ...projectSelectionInputSchema(),
      action: z
        .enum([
          "create",
          "list",
          "get",
          "update",
          "delete",
          "login",
          "submit",
          "timeline",
          "wait",
        ])
        .describe("Operation to perform."),
      id: z
        .string()
        .describe(
          "Auth connection ID. Required for get, update, delete, login, submit, and timeline.",
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
          "(create, update) Additional hostname roots valid for credential entry. Exact hostnames and their subdomains are allowed; leading www. and *. are normalized away. An omitted or empty list leaves credential entry unrestricted.",
        )
        .optional(),
      credential_name: z
        .string()
        .describe(
          "(create, update) Name of a pre-stored Kernel credential to use for automatic login.",
        )
        .optional(),
      credential_provider: z
        .string()
        .describe(
          "(create, update) External credential provider name (e.g. '1password'). Use with credential_path or credential_auto.",
        )
        .optional(),
      credential_path: z
        .string()
        .describe(
          "(create, update) Provider-specific item path (e.g. 'VaultName/ItemName').",
        )
        .optional(),
      credential_auto: z
        .boolean()
        .describe(
          "(create, update) If true, the provider auto-looks up credentials by domain.",
        )
        .optional(),
      login_url: z
        .string()
        .describe(
          "(create, update) Optional explicit login page URL to skip discovery. On update, use an empty string to clear it.",
        )
        .optional(),
      health_check_interval: z
        .number()
        .int()
        .min(300)
        .max(86400)
        .describe(
          "(create, update) Seconds between automatic health checks. Plan-dependent minimum, max 86400.",
        )
        .optional(),
      health_checks: z
        .boolean()
        .describe(
          "(create, update) Enable scheduled authentication health checks. Defaults to true on create.",
        )
        .optional(),
      auto_reauth: z
        .boolean()
        .describe(
          "(create, update) Permit automatic re-authentication after a scheduled health check detects an expired session. Defaults to true on create and has no effect when health_checks is false.",
        )
        .optional(),
      save_credentials: z
        .boolean()
        .describe(
          "(create, update) Save credentials after each successful login. Defaults to true on create.",
        )
        .optional(),
      record_session: z
        .boolean()
        .describe(
          "(create, update) Set the connection default for recording replay video of future login, reauth, and health-check browser sessions. (login) Override that default for this login only. Omitted preserves the API default or inherited value.",
        )
        .optional(),
      browser_telemetry: managedAuthBrowserTelemetrySchema
        .describe(
          "(create, update) Set the connection default for browser telemetry. (login) Override it for this login only. Use { enabled: true } for the default operational categories (control, connection, system, captcha); browser category settings can opt into console, network, page, interaction, screenshot, or platform capture, tune control CDP exclusions, and configure OTLP export. Omitted preserves the API default or inherited value.",
        )
        .optional(),
      browser_stealth: z
        .boolean()
        .describe(
          "(create, update, login) Whether managed-auth browser sessions use stealth mode. Defaults to true on create; omitted on update or login preserves or inherits the connection setting.",
        )
        .optional(),
      proxy_id: z
        .string()
        .min(1)
        .describe(
          "(create, update, login) Proxy ID to route managed-auth browser sessions through.",
        )
        .optional(),
      proxy_name: z
        .string()
        .min(1)
        .describe(
          "(create, update, login) Proxy name to route managed-auth browser sessions through.",
        )
        .optional(),
      proxy_mode: z
        .enum(["direct", "default"])
        .describe(
          "(create, update, login) Proxy mode. direct disables proxy egress; default restores the stealth-derived default. Cannot be combined with proxy_id or proxy_name.",
        )
        .optional(),
      domain_filter: z.string().describe("(list) Filter by domain.").optional(),
      query: z
        .string()
        .describe("(list) Search by connection ID, domain, or profile name.")
        .optional(),
      ...paginationParams,
      interaction_id: z
        .string()
        .min(1)
        .describe(
          "(submit) Opaque interaction ID returned with canonical fields and choices. Required with field_values or selected_choice_id.",
        )
        .optional(),
      field_values: z
        .record(z.string(), z.string())
        .describe(
          "(submit) Canonical map of field ID to value. Use with interaction_id when `get` returns fields.",
        )
        .optional(),
      selected_choice_id: z
        .string()
        .min(1)
        .describe(
          "(submit) Canonical choice ID. Use with interaction_id when `get` returns choices.",
        )
        .optional(),
      fields: z
        .record(z.string(), z.string())
        .describe(
          "(submit, legacy) Map of discovered field name to value. Prefer interaction_id and field_values when canonical fields are present.",
        )
        .optional(),
      mfa_option_id: z
        .string()
        .describe(
          "(submit) ID of the MFA option to use, from mfa_options on the connection.",
        )
        .optional(),
      sign_in_option_id: z
        .string()
        .min(1)
        .describe(
          "(submit, legacy) Sign-in option ID from sign_in_options. Prefer selected_choice_id when canonical choices are present.",
        )
        .optional(),
      sso_button_selector: z
        .string()
        .describe(
          "(submit, legacy) XPath of an ODA SSO button. Cannot be combined with sso_provider.",
        )
        .optional(),
      sso_provider: z
        .string()
        .describe(
          "(submit, legacy) Provider from pending_sso_buttons for a CUA SSO choice. Cannot be combined with sso_button_selector.",
        )
        .optional(),
      timeline_type: z
        .enum(["login", "reauth", "health_check"])
        .describe("(timeline) Filter events by type.")
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
        projectForOperation(extra.authInfo, params),
      );

      const proxySelectors = [
        params.proxy_id,
        params.proxy_name,
        params.proxy_mode,
      ].filter((value) => value !== undefined);
      const buildProxy = () =>
        proxySelectors.length === 1
          ? {
              ...(params.proxy_id && { id: params.proxy_id }),
              ...(params.proxy_name && { name: params.proxy_name }),
              ...(params.proxy_mode && { mode: params.proxy_mode }),
            }
          : undefined;
      const buildBrowser = () => {
        const proxy = buildProxy();
        return params.browser_stealth !== undefined ||
          params.browser_telemetry !== undefined ||
          proxy
          ? {
              ...(params.browser_stealth !== undefined && {
                stealth: params.browser_stealth,
              }),
              ...(params.browser_telemetry !== undefined && {
                telemetry: params.browser_telemetry,
              }),
              ...(proxy && { proxy }),
            }
          : undefined;
      };
      const buildCredential = () => {
        const hasName = !!params.credential_name;
        const hasProvider = !!params.credential_provider;
        const hasPath = !!params.credential_path;
        const autoTrue = params.credential_auto === true;
        if (hasName && (hasProvider || hasPath || autoTrue)) {
          return {
            error:
              "credential_name cannot be combined with credential_provider, credential_path, or credential_auto. Use one of: { credential_name } for Kernel credentials, { credential_provider, credential_path } for an external provider item, or { credential_provider, credential_auto: true } for provider domain lookup.",
          };
        }
        if ((hasPath || autoTrue) && !hasProvider) {
          return {
            error:
              "credential_path and credential_auto require credential_provider.",
          };
        }
        if (hasPath && autoTrue) {
          return {
            error:
              "credential_path and credential_auto: true are alternatives — provide exactly one.",
          };
        }
        if (hasProvider && !hasPath && !autoTrue) {
          return {
            error:
              "credential_provider requires either credential_path or credential_auto: true.",
          };
        }
        return {
          credential:
            hasName || hasProvider
              ? {
                  ...(hasName && { name: params.credential_name }),
                  ...(hasProvider && { provider: params.credential_provider }),
                  ...(hasPath && { path: params.credential_path }),
                  ...(autoTrue && { auto: true }),
                }
              : undefined,
        };
      };

      try {
        if (proxySelectors.length > 1) {
          return errorResponse(
            "Error: provide exactly one of proxy_id, proxy_name, or proxy_mode.",
          );
        }

        switch (params.action) {
          case "create": {
            if (!params.domain || !params.profile_name) {
              return errorResponse(
                "Error: domain and profile_name are required for create.",
              );
            }
            const { credential, error } = buildCredential();
            if (error) return errorResponse(`Error: ${error}`);
            const browser = buildBrowser();
            const connection = await client.auth.connections.create({
              domain: params.domain,
              profile_name: params.profile_name,
              ...(params.allowed_domains !== undefined && {
                allowed_domains: params.allowed_domains,
              }),
              ...(credential && { credential }),
              ...(params.login_url && { login_url: params.login_url }),
              ...(params.health_check_interval !== undefined && {
                health_check_interval: params.health_check_interval,
              }),
              ...(params.health_checks !== undefined && {
                health_checks: params.health_checks,
              }),
              ...(params.auto_reauth !== undefined && {
                auto_reauth: params.auto_reauth,
              }),
              ...(params.save_credentials !== undefined && {
                save_credentials: params.save_credentials,
              }),
              ...(params.record_session !== undefined && {
                record_session: params.record_session,
              }),
              ...(browser && { browser }),
            });
            if (!connection)
              return errorResponse("Failed to create auth connection");
            return jsonResponse(connection);
          }
          case "list": {
            const page = await client.auth.connections.list({
              ...(params.profile_name && { profile_name: params.profile_name }),
              ...(params.domain_filter && { domain: params.domain_filter }),
              ...(params.query && { query: params.query }),
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
          case "update": {
            if (!params.id)
              return errorResponse("Error: id is required for update.");
            const { credential, error } = buildCredential();
            if (error) return errorResponse(`Error: ${error}`);
            const browser = buildBrowser();
            const hasUpdate =
              params.allowed_domains !== undefined ||
              credential !== undefined ||
              params.login_url !== undefined ||
              params.health_check_interval !== undefined ||
              params.health_checks !== undefined ||
              params.auto_reauth !== undefined ||
              params.save_credentials !== undefined ||
              params.record_session !== undefined ||
              browser !== undefined;
            if (!hasUpdate) {
              return errorResponse(
                "Error: update requires at least one connection setting.",
              );
            }
            const connection = await client.auth.connections.update(params.id, {
              ...(params.allowed_domains !== undefined && {
                allowed_domains: params.allowed_domains,
              }),
              ...(credential && { credential }),
              ...(params.login_url !== undefined && {
                login_url: params.login_url,
              }),
              ...(params.health_check_interval !== undefined && {
                health_check_interval: params.health_check_interval,
              }),
              ...(params.health_checks !== undefined && {
                health_checks: params.health_checks,
              }),
              ...(params.auto_reauth !== undefined && {
                auto_reauth: params.auto_reauth,
              }),
              ...(params.save_credentials !== undefined && {
                save_credentials: params.save_credentials,
              }),
              ...(params.record_session !== undefined && {
                record_session: params.record_session,
              }),
              ...(browser && { browser }),
            });
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
            const browser = buildBrowser();
            const hasOverrides =
              browser !== undefined || params.record_session !== undefined;
            const response = await client.auth.connections.login(
              params.id,
              hasOverrides
                ? {
                    ...(browser && { browser }),
                    ...(params.record_session !== undefined && {
                      record_session: params.record_session,
                    }),
                  }
                : undefined,
            );
            return jsonResponse(response);
          }
          case "submit": {
            if (!params.id)
              return errorResponse("Error: id is required for submit.");
            const hasCanonicalFields =
              !!params.field_values &&
              Object.keys(params.field_values).length > 0;
            const hasLegacyFields =
              !!params.fields && Object.keys(params.fields).length > 0;
            const hasCanonicalSubmission =
              hasCanonicalFields || !!params.selected_choice_id;
            const hasLegacySubmission =
              hasLegacyFields ||
              !!params.mfa_option_id ||
              !!params.sign_in_option_id ||
              !!params.sso_button_selector ||
              !!params.sso_provider;
            if (!hasCanonicalSubmission && !hasLegacySubmission) {
              return errorResponse(
                "Error: submit requires at least one of field_values, selected_choice_id, fields, mfa_option_id, sign_in_option_id, sso_button_selector, or sso_provider.",
              );
            }
            if (params.interaction_id && !hasCanonicalSubmission) {
              return errorResponse(
                "Error: interaction_id requires field_values or selected_choice_id.",
              );
            }
            if (hasCanonicalSubmission && hasLegacySubmission) {
              return errorResponse(
                "Error: field_values and selected_choice_id cannot be combined with legacy input fields.",
              );
            }
            if (hasCanonicalSubmission && !params.interaction_id) {
              return errorResponse(
                "Error: interaction_id is required with field_values or selected_choice_id.",
              );
            }
            if (
              params.sso_button_selector &&
              (params.sso_provider ||
                params.mfa_option_id ||
                params.sign_in_option_id)
            ) {
              return errorResponse(
                "Error: sso_button_selector cannot be combined with other input types.",
              );
            }
            if (
              params.sso_provider &&
              (params.mfa_option_id || params.sign_in_option_id)
            ) {
              return errorResponse(
                "Error: sso_provider cannot be combined with mfa_option_id or sign_in_option_id.",
              );
            }
            if (
              params.sign_in_option_id &&
              (hasLegacyFields || params.mfa_option_id)
            ) {
              return errorResponse(
                "Error: sign_in_option_id cannot be combined with fields or mfa_option_id.",
              );
            }
            const response = await client.auth.connections.submit(params.id, {
              ...(params.interaction_id && {
                interaction_id: params.interaction_id,
              }),
              ...(hasCanonicalFields && { field_values: params.field_values }),
              ...(params.selected_choice_id && {
                selected_choice_id: params.selected_choice_id,
              }),
              ...(hasLegacyFields && { fields: params.fields }),
              ...(params.mfa_option_id && {
                mfa_option_id: params.mfa_option_id,
              }),
              ...(params.sign_in_option_id && {
                sign_in_option_id: params.sign_in_option_id,
              }),
              ...(params.sso_button_selector && {
                sso_button_selector: params.sso_button_selector,
              }),
              ...(params.sso_provider && {
                sso_provider: params.sso_provider,
              }),
            });
            return jsonResponse(response);
          }
          case "timeline": {
            if (!params.id)
              return errorResponse("Error: id is required for timeline.");
            const page = await client.auth.connections.timeline(params.id, {
              ...(params.timeline_type && { type: params.timeline_type }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
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
