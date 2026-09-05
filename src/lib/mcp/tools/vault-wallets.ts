import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { errorResponse } from "@/lib/mcp/responses";
import { throwVaultError, vaultItemResponse } from "@/lib/mcp/vault-responses";
import {
  agentcardWalletSpecSchema,
  linkWalletSpecSchema,
  vaultItemSchema,
  vaultKeySchema,
  vaultProviderSchema,
} from "@/lib/mcp/vault-schemas";

export function registerVaultWalletTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.tool(
    "manage_vault_wallets",
    'Connect payment wallets without exposing secrets. "create" creates or retrieves an identical wallet by immutable key and returns a provider connection/enrollment action for the user to complete. "payment_methods" requests the advertised live payment_methods expansion (unavailable expansions return an API error). Select Link payment_method_id explicitly; never automatically choose a default. AgentCard card_id may be omitted for cardholder selection at checkout approval. Capabilities are advisory; absent means unknown. Never provide card data or OAuth codes/tokens. Requests are not automatically retried.',
    {
      ...vaultItemSchema,
      key: vaultKeySchema(),
      action: z.enum(["create", "payment_methods"]),
      provider: vaultProviderSchema
        .describe("(create) Payment provider.")
        .optional(),
      spec: z
        .union([linkWalletSpecSchema, agentcardWalletSpecSchema])
        .describe(
          '(create) Specification object, not a {type, spec} envelope. Embedded provider must match provider. Link: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}. AgentCard: {} to enroll or {"user_id":"usr_..."} for an already enrolled user.',
        )
        .optional(),
    },
    {
      title: "Manage Kernel vault wallets",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = dependencies.createKernelClient(
        extra.authInfo.token,
        projectForOperation(extra.authInfo, params),
      );
      const options = { maxRetries: 0, signal: extra.signal };
      try {
        switch (params.action) {
          case "create": {
            if (!params.provider || !params.spec)
              return errorResponse(
                "provider and spec are required for create.",
              );
            const spec =
              params.provider === "link"
                ? {
                    ...linkWalletSpecSchema.parse(params.spec),
                    provider: params.provider,
                  }
                : {
                    ...agentcardWalletSpecSchema.parse(params.spec),
                    provider: params.provider,
                  };
            const item = await client.vaults.items.upsert(
              params.key,
              {
                id_or_name: params.vault,
                type: "wallet",
                spec,
              },
              options,
            );
            return vaultItemResponse(item);
          }
          case "payment_methods": {
            const item = await client.vaults.items.retrieve(
              params.key,
              {
                id_or_name: params.vault,
                expand: ["payment_methods"],
              },
              { ...longOperationOptions(0), signal: extra.signal },
            );
            return vaultItemResponse(item);
          }
        }
      } catch (error) {
        throwVaultError("manage_vault_wallets", params.action, error);
      }
    },
  );
}
