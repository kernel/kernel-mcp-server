import type { McpServer } from "@modelcontextprotocol/server";
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
  server.registerTool(
    "manage_vault_wallets",
    {
      description:
        'connect payment wallets without exposing secrets. "create" creates or retrieves an identical wallet by immutable key. hosted connection/enrollment actions are for the user; a valid imported link grant creates a connected wallet. "payment_methods" requests the advertised live payment_methods expansion (unavailable expansions return an api error). select link payment_method_id explicitly; never automatically choose a default. agentcard card_id may be omitted for cardholder selection at checkout approval. capabilities are advisory; absent means unknown. KERNEL-managed link oauth remains supported. customer-managed link requires authorization.client.provider_config and a write-only authorization.tokens pair supplied by a trusted backend, never chat; config credentials do not authorize a user. KERNEL owns refresh rotation after import. duplicate create never replaces a grant; bindings cannot change. agentcard spec.provider_config is optional; omit for KERNEL-managed credentials, and reuse user_id only within the same config. no in-place imported reauthorization: obtain a fresh grant under a new wallet key for new payments only; retain unresolved old payments for reconciliation. never provide card data or oauth codes. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "payment_methods"]),
        provider: vaultProviderSchema
          .describe("(create) payment provider.")
          .optional(),
        spec: z
          .union([linkWalletSpecSchema, agentcardWalletSpecSchema])
          .describe(
            '(create) specification object, not a {type, spec} envelope. embedded provider must match provider. link: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}, or customer_managed with provider_config (exactly one id/name) and tokens from a trusted backend. agentcard: {} to enroll, optionally provider_config or user_id from the same configuration.',
          )
          .optional(),
      }),
      annotations: {
        title: "manage KERNEL vault wallets",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const project = projectForOperation(ctx.http.authInfo, params);
      const target = { project, vault: params.vault, key: params.key };
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        project,
      );
      const options = { maxRetries: 0, signal: ctx.mcpReq.signal };
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
              { ...longOperationOptions(0), signal: ctx.mcpReq.signal },
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
