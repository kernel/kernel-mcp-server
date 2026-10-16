import type { McpServer } from "@modelcontextprotocol/server";
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
  DEPRECATED_TOOL_PARAMS,
  deprecatedParamConflict,
} from "@/lib/mcp/deprecated-params";
import { proxyConfigError, proxyConfigSchema } from "@/lib/mcp/proxy-config";
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
  server.registerTool(
    "manage_auth_connections",
    {
      description:
        'manage reusable authenticated profiles for third-party websites. before a browser task that needs a user account, call "list" with the exact domain_filter and inspect every page. if one relevant connection is authenticated, create the browser with its profile_name. if multiple relevant accounts exist, ask the user which one to use. if authentication is needed and open_auth_login is available, prefer that secure app so credentials and mfa never enter chat: a direct user request to log in is already consent; if login is only discovered incidentally, ask first. for a new app login, choose a concise stable profile name derived from the service unless the user specified one. the programmatic actions remain available for every client: "create" or "update" a connection, "login" to start a hosted flow, "submit" fields or choices, "get" status, inspect the "timeline", "delete", or "wait" for completion. prefer interaction_id with canonical field_values or selected_choice_id when the connection returns fields or choices. after authentication, resume the original task with manage_browsers using the verified profile_name.',
      inputSchema: z.object({
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
          .describe("operation to perform."),
        id: z
          .string()
          .describe(
            "auth connection id. required for get, update, delete, login, submit, and timeline.",
          )
          .optional(),
        domain: z
          .string()
          .describe("(create) target domain (e.g. 'netflix.com').")
          .optional(),
        profile_name: z
          .string()
          .describe(
            "(create) profile to manage auth for. (list) filter by profile_name.",
          )
          .optional(),
        allowed_domains: z
          .array(z.string())
          .describe(
            "(create, update) additional hostname roots valid for credential entry. exact hostnames and their subdomains are allowed; leading www. and *. are normalized away. an omitted or empty list leaves credential entry unrestricted.",
          )
          .optional(),
        credential_name: z
          .string()
          .describe(
            "(create, update) name of a pre-stored KERNEL credential to use for automatic login.",
          )
          .optional(),
        credential_provider: z
          .string()
          .describe(
            "(create, update) external credential provider name (e.g. '1password'). use with credential_path or credential_auto.",
          )
          .optional(),
        credential_path: z
          .string()
          .describe(
            "(create, update) provider-specific item path (e.g. `VaultName/ItemName`).",
          )
          .optional(),
        credential_auto: z
          .boolean()
          .describe(
            "(create, update) if true, the provider auto-looks up credentials by domain.",
          )
          .optional(),
        login_url: z
          .string()
          .describe(
            "(create, update) optional explicit login page url to skip discovery. on update, use an empty string to clear it.",
          )
          .optional(),
        health_check_interval: z
          .number()
          .int()
          .min(300)
          .max(86400)
          .describe(
            "(create, update) seconds between automatic health checks. plan-dependent minimum, max 86400.",
          )
          .optional(),
        health_checks: z
          .boolean()
          .describe(
            "(create, update) enable scheduled authentication health checks. defaults to true on create.",
          )
          .optional(),
        auto_reauth: z
          .boolean()
          .describe(
            "(create, update) permit automatic re-authentication after a scheduled health check detects an expired session. defaults to true on create and has no effect when health_checks is false.",
          )
          .optional(),
        save_credentials: z
          .boolean()
          .describe(
            "(create, update) save credentials after each successful login. defaults to true on create.",
          )
          .optional(),
        record_session: z
          .boolean()
          .describe(
            "(create, update) set the connection default for recording replay video of future login, reauth, and health-check browser sessions. (login) override that default for this login only. omitted preserves the api default or inherited value.",
          )
          .optional(),
        browser: z
          .object({
            proxy: proxyConfigSchema()
              .describe(
                "proxy egress, set with exactly one of id, name, or mode. id or name selects that proxy; mode direct forces direct egress; mode default restores the default egress. omitted on create derives the default; omitted on update or login preserves or inherits the connection setting.",
              )
              .optional(),
            region: z
              .enum(["us-east", "eu-west", "ap-southeast"])
              .describe(
                "region for managed-auth browser sessions. defaults to us-east on create; omitted on update or login preserves or inherits the connection setting.",
              )
              .optional(),
            stealth: z
              .boolean()
              .describe(
                "whether managed-auth browser sessions use site-compatibility settings. defaults to true on create; omitted on update or login preserves or inherits the connection setting.",
              )
              .optional(),
            telemetry: managedAuthBrowserTelemetrySchema
              .describe(
                "use { enabled: true } for the default operational categories (control, connection, system, captcha); browser category settings can opt into console, network, page, interaction, screenshot, or platform capture, tune control cdp exclusions, and configure otlp export. omitted preserves the api default or inherited value.",
              )
              .optional(),
          })
          .describe(
            "(create, update) set the connection defaults for future managed-auth browser sessions. (login) override them for this login only. cannot be combined with the deprecated browser_*, proxy_id, proxy_name, or proxy_mode fields.",
          )
          .optional(),
        browser_telemetry: managedAuthBrowserTelemetrySchema
          .describe(
            "deprecated: use `browser.telemetry` instead. (create, update) set the connection default for browser telemetry. (login) override it for this login only. use { enabled: true } for the default operational categories (control, connection, system, captcha); browser category settings can opt into console, network, page, interaction, screenshot, or platform capture, tune control cdp exclusions, and configure otlp export. omitted preserves the api default or inherited value.",
          )
          .optional(),
        browser_region: z
          .enum(["us-east", "eu-west", "ap-southeast"])
          .describe(
            "deprecated: use `browser.region` instead. (create, update) set the region for future managed-auth browser sessions. (login) override the region for this login only. defaults to us-east on create; omitted on update or login preserves or inherits the connection setting.",
          )
          .optional(),
        browser_stealth: z
          .boolean()
          .describe(
            "deprecated: use the site-compatibility setting in `browser` instead. (create, update, login) whether managed-auth browser sessions use site-compatibility settings. defaults to true on create; omitted on update or login preserves or inherits the connection setting.",
          )
          .optional(),
        proxy_id: z
          .string()
          .min(1)
          .describe(
            "deprecated: use `browser.proxy.id` instead. (create, update, login) proxy id to route managed-auth browser sessions through.",
          )
          .optional(),
        proxy_name: z
          .string()
          .min(1)
          .describe(
            "deprecated: use `browser.proxy.name` instead. (create, update, login) proxy name to route managed-auth browser sessions through.",
          )
          .optional(),
        proxy_mode: z
          .enum(["direct", "default"])
          .describe(
            "deprecated: use `browser.proxy.mode` instead. (create, update, login) proxy mode. direct disables proxy egress; default restores the session's default proxy setting. cannot be combined with proxy_id or proxy_name.",
          )
          .optional(),
        domain_filter: z
          .string()
          .describe("(list) filter by domain.")
          .optional(),
        query: z
          .string()
          .describe("(list) search by connection id, domain, or profile name.")
          .optional(),
        ...paginationParams,
        interaction_id: z
          .string()
          .min(1)
          .describe(
            "(submit) opaque interaction id returned with canonical fields and choices. required with field_values or selected_choice_id.",
          )
          .optional(),
        field_values: z
          .record(z.string(), z.string())
          .describe(
            "(submit) canonical map of field id to value. use with interaction_id when `get` returns fields.",
          )
          .optional(),
        selected_choice_id: z
          .string()
          .min(1)
          .describe(
            "(submit) canonical choice id. use with interaction_id when `get` returns choices.",
          )
          .optional(),
        fields: z
          .record(z.string(), z.string())
          .describe(
            "(submit, legacy) map of discovered field name to value. prefer interaction_id and field_values when canonical fields are present.",
          )
          .optional(),
        mfa_option_id: z
          .string()
          .describe(
            "(submit) id of the mfa option to use, from mfa_options on the connection.",
          )
          .optional(),
        sign_in_option_id: z
          .string()
          .min(1)
          .describe(
            "(submit, legacy) sign-in option id from sign_in_options. prefer selected_choice_id when canonical choices are present.",
          )
          .optional(),
        sso_button_selector: z
          .string()
          .describe(
            "(submit, legacy) xpath of an oda sso button. cannot be combined with sso_provider.",
          )
          .optional(),
        sso_provider: z
          .string()
          .describe(
            "(submit, legacy) provider from pending_sso_buttons for a cua sso choice. cannot be combined with sso_button_selector.",
          )
          .optional(),
        timeline_type: z
          .enum(["login", "reauth", "health_check"])
          .describe("(timeline) filter events by type.")
          .optional(),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(30)
          .describe("(wait) long-poll duration. defaults to 25 seconds.")
          .optional(),
        required_flow_type: z
          .enum(["LOGIN", "REAUTH"])
          .describe("(wait) require this newly completed flow type.")
          .optional(),
        flow_checkpoint: z
          .string()
          .min(1)
          .describe(
            "(wait) signed flow checkpoint supplied by open_auth_login or begin_auth_login; forward it unchanged.",
          )
          .optional(),
      }),
      annotations: {
        title: "manage KERNEL managed auth connections",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
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
        if (params.browser !== undefined) {
          return Object.keys(params.browser).length > 0
            ? params.browser
            : undefined;
        }
        const proxy = buildProxy();
        return params.browser_region !== undefined ||
          params.browser_stealth !== undefined ||
          params.browser_telemetry !== undefined ||
          proxy
          ? {
              ...(params.browser_region !== undefined && {
                region: params.browser_region,
              }),
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
              "credential_name cannot be combined with credential_provider, credential_path, or credential_auto. use one of: { credential_name } for KERNEL credentials, { credential_provider, credential_path } for an external provider item, or { credential_provider, credential_auto: true } for provider domain lookup.",
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
        if (params.browser !== undefined) {
          const error =
            deprecatedParamConflict(
              "browser",
              params,
              DEPRECATED_TOOL_PARAMS.manage_auth_connections,
            ) ??
            (params.browser.proxy &&
              proxyConfigError("browser.proxy", params.browser.proxy));
          if (error) return errorResponse(`error: ${error}`);
        }
        if (proxySelectors.length > 1) {
          return errorResponse(
            "error: provide exactly one of proxy_id, proxy_name, or proxy_mode.",
          );
        }

        switch (params.action) {
          case "create": {
            if (!params.domain || !params.profile_name) {
              return errorResponse(
                "error: domain and profile_name are required for create.",
              );
            }
            const { credential, error } = buildCredential();
            if (error) return errorResponse(`error: ${error}`);
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
              return errorResponse("failed to create auth connection");
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
              return errorResponse("error: id is required for get.");
            const connection = await client.auth.connections.retrieve(
              params.id,
            );
            return jsonResponse(connection);
          }
          case "update": {
            if (!params.id)
              return errorResponse("error: id is required for update.");
            const { credential, error } = buildCredential();
            if (error) return errorResponse(`error: ${error}`);
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
                "error: update requires at least one connection setting.",
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
              return errorResponse("error: id is required for delete.");
            await client.auth.connections.delete(params.id);
            return textResponse("auth connection deleted successfully");
          }
          case "login": {
            if (!params.id)
              return errorResponse("error: id is required for login.");
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
              return errorResponse("error: id is required for submit.");
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
                "error: submit requires at least one of field_values, selected_choice_id, fields, mfa_option_id, sign_in_option_id, sso_button_selector, or sso_provider.",
              );
            }
            if (params.interaction_id && !hasCanonicalSubmission) {
              return errorResponse(
                "error: interaction_id requires field_values or selected_choice_id.",
              );
            }
            if (hasCanonicalSubmission && hasLegacySubmission) {
              return errorResponse(
                "error: field_values and selected_choice_id cannot be combined with legacy input fields.",
              );
            }
            if (hasCanonicalSubmission && !params.interaction_id) {
              return errorResponse(
                "error: interaction_id is required with field_values or selected_choice_id.",
              );
            }
            if (
              params.sso_button_selector &&
              (params.sso_provider ||
                params.mfa_option_id ||
                params.sign_in_option_id)
            ) {
              return errorResponse(
                "error: sso_button_selector cannot be combined with other input types.",
              );
            }
            if (
              params.sso_provider &&
              (params.mfa_option_id || params.sign_in_option_id)
            ) {
              return errorResponse(
                "error: sso_provider cannot be combined with mfa_option_id or sign_in_option_id.",
              );
            }
            if (
              params.sign_in_option_id &&
              (hasLegacyFields || params.mfa_option_id)
            ) {
              return errorResponse(
                "error: sign_in_option_id cannot be combined with fields or mfa_option_id.",
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
              return errorResponse("error: id is required for timeline.");
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
                "error: wait requires id, or both domain_filter and profile_name.",
              );
            }
            if (params.flow_checkpoint && !params.id) {
              return errorResponse(
                "error: a flow_checkpoint wait requires its connection id.",
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
                signal: ctx.mcpReq.signal,
              },
            );
            return safeJsonResponse({
              ...result,
              instruction:
                result.state === "authenticated"
                  ? "authentication is verified. continue the pending task now, using this profile_name when creating the browser."
                  : result.state === "failed"
                    ? "authentication did not complete. explain the safe error and ask whether to retry the login flow."
                    : "authentication is still pending. immediately call manage_auth_connections with action=wait and the same selector again. do not ask the user to report completion.",
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
