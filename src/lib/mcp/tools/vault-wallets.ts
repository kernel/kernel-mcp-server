import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ItemUpsertParams } from "@onkernel/sdk/resources/vaults/items";
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
  vaultToolInput,
} from "@/lib/mcp/vault-schemas";

export function registerVaultWalletTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.tool(
    "manage_vault_wallets",
    'Connect payment wallets without exposing secrets. "create" creates or retrieves an identical wallet by immutable key. Hosted connection/enrollment actions are for the user; a valid imported Link grant creates a connected wallet. "payment_methods" requests the advertised live payment_methods expansion (unavailable expansions return an API error). Select Link payment_method_id explicitly; never automatically choose a default. AgentCard card_id may be omitted for cardholder selection at checkout approval. Capabilities are advisory; absent means unknown. Kernel-managed Link OAuth remains supported. Customer-managed Link requires authorization.client.provider_config and a write-only authorization.tokens pair supplied by a trusted backend, never chat; config credentials do not authorize a user. Kernel owns refresh rotation after import. Duplicate create never replaces a grant; bindings cannot change. AgentCard spec.provider_config is optional; omit for Kernel-managed credentials, and reuse user_id only within the same config. No in-place imported reauthorization: obtain a fresh grant under a new wallet key for new payments only; retain unresolved old payments for reconciliation. Never provide card data or OAuth codes. Requests are not automatically retried.',
    vaultToolInput({
      ...vaultItemSchema,
      key: vaultKeySchema(),
      action: z.enum(["create", "payment_methods"]),
      provider: vaultProviderSchema
        .describe("(create) Payment provider.")
        .optional(),
      spec: z
        .union([linkWalletSpecSchema, agentcardWalletSpecSchema])
        .describe(
          '(create) Specification object, not a {type, spec} envelope. Embedded provider must match provider. Link: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}, or customer_managed with provider_config (exactly one id/name) and tokens from a trusted backend. AgentCard: {} to enroll, optionally provider_config or user_id from the same configuration.',
        )
        .optional(),
    }),
    {
      title: "Manage Kernel vault wallets",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const project = projectForOperation(extra.authInfo, params);
      const target = { project, vault: params.vault, key: params.key };
      const client = dependencies.createKernelClient(
        extra.authInfo.token,
        project,
      );
      const options = { maxRetries: 0, signal: extra.signal };
      try {
        switch (params.action) {
          case "create": {
            if (!params.provider || !params.spec)
              return errorResponse(
                "provider and spec are required for create.",
              );
            const spec: ItemUpsertParams.WalletVaultItemRequest["spec"] =
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
            const tokens =
              spec.provider === "link" && "tokens" in spec.authorization
                ? spec.authorization.tokens
                : undefined;
            return vaultItemResponse(item, target, [
              tokens?.access_token,
              tokens?.refresh_token,
            ]);
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
            return vaultItemResponse(item, target);
          }
        }
      } catch (error) {
        throwVaultError("manage_vault_wallets", params.action, error);
      }
    },
  );
}
