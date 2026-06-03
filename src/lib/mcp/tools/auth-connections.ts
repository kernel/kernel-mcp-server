import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

export function registerAuthConnectionTools(server: McpServer) {
  // manage_auth_connections -- Manage Kernel managed auth connections
  server.tool(
    "manage_auth_connections",
    'Manage Kernel managed auth connections for keeping a profile logged into a third-party site. Use "create" to start managing auth for a profile + domain (optionally referencing a stored credential), "login" to begin a login flow (returns a hosted_url to share with the user, plus live_view_url to watch), "submit" to provide field values or pick an MFA option when a flow is awaiting input, "get" to poll flow state, "list" to see connections, or "delete" to remove one.',
    {
      action: z
        .enum(["create", "list", "get", "delete", "login", "submit"])
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
      proxy_id: z
        .string()
        .describe("(create, login) Proxy ID to route the auth flow through.")
        .optional(),
      proxy_name: z
        .string()
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
            const response = await client.auth.connections.login(
              params.id,
              proxy ? { proxy } : undefined,
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
        }
      } catch (error) {
        return toolErrorResponse(
          "manage_auth_connections",
          params.action,
          error,
        );
      }
    },
  );
}
