import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

export function registerCredentialProviderTools(server: McpServer) {
  // manage_credential_providers -- Manage external credential providers
  server.registerTool(
    "manage_credential_providers",
    {
      description:
        'manage external credential providers (e.g. 1password). "list" returns configured providers, "get" retrieves one by id, "create" configures a new provider with a service-account token, "update" changes its name/token/priority/enabled/cache_ttl_seconds, "delete" removes it, "list_items" returns available credential items from the provider (e.g. 1password login items with their paths), and "test" validates the token and lists accessible vaults.',
      inputSchema: z.object({
        action: z
          .enum([
            "list",
            "get",
            "create",
            "update",
            "delete",
            "list_items",
            "test",
          ])
          .describe("operation to perform."),
        id: z
          .string()
          .describe(
            "(get, update, delete, list_items, test) credential provider id.",
          )
          .optional(),
        ...paginationParams,
        name: z
          .string()
          .describe("(create, update) human-readable name (unique per org).")
          .optional(),
        token: z
          .string()
          .describe(
            "(create) service-account token for the provider. (update) new token to rotate credentials.",
          )
          .optional(),
        provider_type: z
          .enum(["onepassword"])
          .describe("(create) type of credential provider.")
          .optional(),
        cache_ttl_seconds: z
          .number()
          .int()
          .describe(
            "(create, update) how long to cache credential lists (default 300).",
          )
          .optional(),
        enabled: z
          .boolean()
          .describe(
            "(update) whether the provider is enabled for credential lookups.",
          )
          .optional(),
        priority: z
          .number()
          .int()
          .describe(
            "(update) priority order for credential lookups (lower numbers checked first).",
          )
          .optional(),
      }),
      annotations: {
        title: "manage KERNEL credential providers",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(ctx.http.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const page = await client.credentialProviders.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.id)
              return errorResponse("error: id is required for get.");
            const provider = await client.credentialProviders.retrieve(
              params.id,
            );
            return jsonResponse(provider);
          }
          case "create": {
            if (!params.token || !params.name || !params.provider_type) {
              return errorResponse(
                "error: token, name, and provider_type are required for create.",
              );
            }
            const provider = await client.credentialProviders.create({
              token: params.token,
              name: params.name,
              provider_type: params.provider_type,
              ...(params.cache_ttl_seconds !== undefined && {
                cache_ttl_seconds: params.cache_ttl_seconds,
              }),
            });
            if (!provider)
              return errorResponse("failed to create credential provider");
            return jsonResponse(provider);
          }
          case "update": {
            if (!params.id)
              return errorResponse("error: id is required for update.");
            const updateParams = {
              ...(params.name !== undefined && { name: params.name }),
              ...(params.token !== undefined && { token: params.token }),
              ...(params.cache_ttl_seconds !== undefined && {
                cache_ttl_seconds: params.cache_ttl_seconds,
              }),
              ...(params.enabled !== undefined && {
                enabled: params.enabled,
              }),
              ...(params.priority !== undefined && {
                priority: params.priority,
              }),
            };
            if (Object.keys(updateParams).length === 0) {
              return errorResponse(
                "error: at least one update field is required.",
              );
            }
            const provider = await client.credentialProviders.update(
              params.id,
              updateParams,
            );
            return jsonResponse(provider);
          }
          case "delete": {
            if (!params.id)
              return errorResponse("error: id is required for delete.");
            await client.credentialProviders.delete(params.id);
            return textResponse(`credential provider ${params.id} deleted.`);
          }
          case "list_items": {
            if (!params.id)
              return errorResponse("error: id is required for list_items.");
            const response = await client.credentialProviders.listItems(
              params.id,
            );
            return jsonResponse(response);
          }
          case "test": {
            if (!params.id)
              return errorResponse("error: id is required for test.");
            const result = await client.credentialProviders.test(params.id);
            return jsonResponse(result);
          }
        }
      } catch (error) {
        throwToolError("manage_credential_providers", params.action, error);
      }
    },
  );
}
