import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APIError } from "@onkernel/sdk";
import type {
  VaultProviderConfigCreateParams,
  VaultProviderConfigUpdateParams,
} from "@onkernel/sdk/resources/vault-provider-configs";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { connectionContextFromAuthInfo } from "@/lib/mcp/project-selection";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectVaultOutput,
  redactVaultSecrets,
  throwVaultError,
  vaultProviderConfigFields,
} from "@/lib/mcp/vault-responses";
import {
  providerCredentialsSchema,
  vaultProviderSchema,
  vaultSelectorSchema,
} from "@/lib/mcp/vault-schemas";

export function registerVaultProviderConfigTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.tool(
    "manage_vault_provider_configs",
    'Manage organization-owned Link and AgentCard application credentials, not user OAuth grants. "create" requires name, provider, and credentials (client_id/client_secret); duplicate names conflict without replacing secrets. "list" and "get" return public configuration metadata only. "update" renames or rotates client_secret across all bound wallets; omitted fields stay unchanged. Provider, client_id, mode, and wallet bindings are immutable. "delete" requires user confirmation and fails while any non-deleted item references the config; it does not revoke unrelated grants. Writes require an organization-scoped connection. Supply write-only secrets through a trusted client, never chat. No automatic retries.',
    {
      action: z.enum(["create", "list", "get", "update", "delete"]),
      config: vaultSelectorSchema()
        .describe(
          "(get, update, delete) Configuration ID or name within the organization.",
        )
        .optional(),
      name: vaultSelectorSchema()
        .describe("(create, update) Unique organization-wide name.")
        .optional(),
      provider: vaultProviderSchema
        .describe("(create only) Immutable provider.")
        .optional(),
      credentials: providerCredentialsSchema
        .describe(
          "(create) client_id and client_secret. (update) client_secret only. Never user access/refresh tokens.",
        )
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel vault provider configurations",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const write = ["create", "update", "delete"].includes(params.action);
      if (
        write &&
        connectionContextFromAuthInfo(extra.authInfo).scope.kind !==
          "organization"
      ) {
        return errorResponse(
          "Provider configuration writes require an organization-scoped connection.",
        );
      }
      if (params.action !== "create" && params.provider !== undefined) {
        return errorResponse(
          "provider is only accepted for create; configuration identity is immutable.",
        );
      }
      if (
        !["create", "update"].includes(params.action) &&
        (params.credentials !== undefined || params.name !== undefined)
      ) {
        return errorResponse(
          "name and credentials are only accepted for create or update.",
        );
      }
      if (
        params.action === "update" &&
        params.credentials?.client_id !== undefined
      ) {
        return errorResponse(
          "client_id is immutable; create a new configuration to change clients.",
        );
      }
      const client = dependencies
        .createKernelClient(extra.authInfo.token)
        .withOptions({
          project: null,
          projectID: null,
          logLevel: "off",
        });
      const options = { maxRetries: 0, signal: extra.signal };
      const project = (value: unknown) =>
        redactVaultSecrets(
          projectVaultOutput(value, vaultProviderConfigFields),
          [params.credentials?.client_secret],
        );
      try {
        switch (params.action) {
          case "create": {
            if (
              !params.name ||
              !params.provider ||
              !params.credentials?.client_id
            ) {
              return errorResponse(
                "name, provider, and credentials with client_id and client_secret are required for create.",
              );
            }
            const body: VaultProviderConfigCreateParams = {
              name: params.name,
              provider: params.provider,
              credentials: {
                client_id: params.credentials.client_id,
                client_secret: params.credentials.client_secret,
              },
            };
            return jsonResponse(
              project(await client.vaultProviderConfigs.create(body, options)),
            );
          }
          case "list": {
            const page = await client.vaultProviderConfigs.list(
              {
                ...(params.limit !== undefined && { limit: params.limit }),
                ...(params.offset !== undefined && { offset: params.offset }),
              },
              options,
            );
            return paginatedJsonResponse(page, {
              mapItem: project,
              emptyText:
                "No provider configurations found in the organization.",
            });
          }
          case "get":
            if (!params.config)
              return errorResponse("config is required for get.");
            return jsonResponse(
              project(
                await client.vaultProviderConfigs.retrieve(
                  params.config,
                  options,
                ),
              ),
            );
          case "update": {
            if (!params.config)
              return errorResponse("config is required for update.");
            if (params.name === undefined && params.credentials === undefined)
              return errorResponse(
                "name or credentials is required for update.",
              );
            const body: VaultProviderConfigUpdateParams = {
              ...(params.name !== undefined && { name: params.name }),
              ...(params.credentials !== undefined && {
                credentials: {
                  client_secret: params.credentials.client_secret,
                },
              }),
            };
            return jsonResponse(
              project(
                await client.vaultProviderConfigs.update(
                  params.config,
                  body,
                  options,
                ),
              ),
            );
          }
          case "delete":
            if (!params.config)
              return errorResponse("config is required for delete.");
            await client.vaultProviderConfigs.delete(params.config, options);
            return jsonResponse({
              status: "deleted_or_not_found",
              config: params.config,
            });
        }
      } catch (error) {
        if (
          params.action === "delete" &&
          error instanceof APIError &&
          error.status === 404
        ) {
          return jsonResponse({
            status: "deleted_or_not_found",
            config: params.config,
          });
        }
        throwVaultError("manage_vault_provider_configs", params.action, error);
      }
    },
  );
}
