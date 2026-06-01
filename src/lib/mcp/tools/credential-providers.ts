import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerCredentialProviderTools(server: McpServer) {
  // manage_credential_providers -- Manage external credential providers
  server.tool(
    "manage_credential_providers",
    'Manage external credential providers (e.g. 1Password). "list" returns configured providers, "get" retrieves one by ID, "create" configures a new provider with a service-account token, "update" changes its name/token/priority/enabled/cache_ttl_seconds, "delete" removes it, "list_items" returns available credential items from the provider (e.g. 1Password login items with their paths), and "test" validates the token and lists accessible vaults.',
    {
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
        .describe("Operation to perform."),
      id: z
        .string()
        .describe(
          "(get, update, delete, list_items, test) Credential provider ID.",
        )
        .optional(),
      name: z
        .string()
        .describe("(create, update) Human-readable name (unique per org).")
        .optional(),
      token: z
        .string()
        .describe(
          "(create) Service-account token for the provider. (update) New token to rotate credentials.",
        )
        .optional(),
      provider_type: z
        .enum(["onepassword"])
        .describe("(create) Type of credential provider.")
        .optional(),
      cache_ttl_seconds: z
        .number()
        .describe(
          "(create, update) How long to cache credential lists (default 300).",
        )
        .optional(),
      enabled: z
        .boolean()
        .describe(
          "(update) Whether the provider is enabled for credential lookups.",
        )
        .optional(),
      priority: z
        .number()
        .describe(
          "(update) Priority order for credential lookups (lower numbers checked first).",
        )
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const providers = await client.credentialProviders.list();
            return {
              content: [
                { type: "text", text: JSON.stringify(providers, null, 2) },
              ],
            };
          }
          case "get": {
            if (!params.id)
              return {
                content: [
                  { type: "text", text: "Error: id is required for get." },
                ],
              };
            const provider = await client.credentialProviders.retrieve(
              params.id,
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(provider, null, 2) },
              ],
            };
          }
          case "create": {
            if (!params.token || !params.name || !params.provider_type) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: token, name, and provider_type are required for create.",
                  },
                ],
              };
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
              return {
                content: [
                  {
                    type: "text",
                    text: "Failed to create credential provider",
                  },
                ],
              };
            return {
              content: [
                { type: "text", text: JSON.stringify(provider, null, 2) },
              ],
            };
          }
          case "update": {
            if (!params.id)
              return {
                content: [
                  { type: "text", text: "Error: id is required for update." },
                ],
              };
            const provider = await client.credentialProviders.update(
              params.id,
              {
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
              },
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(provider, null, 2) },
              ],
            };
          }
          case "delete": {
            if (!params.id)
              return {
                content: [
                  { type: "text", text: "Error: id is required for delete." },
                ],
              };
            await client.credentialProviders.delete(params.id);
            return {
              content: [
                {
                  type: "text",
                  text: `Credential provider ${params.id} deleted.`,
                },
              ],
            };
          }
          case "list_items": {
            if (!params.id)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id is required for list_items.",
                  },
                ],
              };
            const response = await client.credentialProviders.listItems(
              params.id,
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(response, null, 2) },
              ],
            };
          }
          case "test": {
            if (!params.id)
              return {
                content: [
                  { type: "text", text: "Error: id is required for test." },
                ],
              };
            const result = await client.credentialProviders.test(params.id);
            return {
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_credential_providers (${params.action}): ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
