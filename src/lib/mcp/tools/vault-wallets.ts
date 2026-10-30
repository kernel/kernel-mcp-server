import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ItemUpsertParams } from "@onkernel/sdk/resources/vaults/items";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { errorResponse } from "@/lib/mcp/responses";
import {
  paymentMethodOperationResponse,
  throwKernelVaultError,
  throwVaultError,
  vaultItemResponse,
} from "@/lib/mcp/vault-responses";
import {
  agentcardWalletSpecSchema,
  linkWalletSpecSchema,
  kernelWalletSpecSchema,
  shopPayWalletSpecSchema,
  vaultItemSchema,
  vaultKeySchema,
  vaultProviderSchema,
  vaultToolInput,
  topLevelIssueKeys,
} from "@/lib/mcp/vault-schemas";

export function registerVaultWalletTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.registerTool(
    "manage_vault_wallets",
    {
      description:
        'connect payment wallets without exposing secrets. shop pay wallets use spec:{authorization:{method:"oauth",client:{type:"kernel_managed"}}}; creation returns a shop_pay_oauth action whose url must be shared unchanged with the shopper so they can sign in to shop and approve the connection. once connected, payment_methods lists their saved shop pay cards. KERNEL wallets use spec:{}. where add_payment_method is enabled, creation returns an empty connected wallet and "add_payment_method" starts each hosted card enrollment, including the first; otherwise creation returns the legacy default card\'s card_enrollment action. share oauth and enrollment urls only with the intended user in a private surface, never open, alter, or log them. embedded card-capture tokens are bearer secrets and are intentionally not returned by mcp. "create" creates or retrieves an identical wallet by immutable key. hosted connection/enrollment actions are for the user; a valid imported link grant creates a connected wallet. "payment_methods" requests the advertised live payment_methods expansion. "add_payment_method" takes no payment details and returns one pending_enrollment method with a separate single-use link that expires after 30 minutes; failed or expired enrollment does not affect the other methods. "remove_payment_method" requires explicit user confirmation and a payment_method_id; it removes only that card, leaves the wallet connected even when no cards remain, and is not proof that a payment did not occur. an unresolved purchase can block removal with purchase_unresolved. if removal has an uncertain provider outcome, the method remains removal_pending and refuses payments; inspect payment_methods and retry removal later only as the advertised operation and status_reason direct. both operations must be advertised and require vaults:write plus vaults:use for scoped api keys. manage_vault_items get can request any advertised expansion, including live link_user_info and link_shipping_addresses data that KERNEL does not store; unavailable expansions return an api error. select link payment_method_id explicitly. for KERNEL card items, omitting payment_method_id selects only the legacy default card (is_default:true), never another method; wallets created with payment methods enabled have no default. KERNEL payment_request items always require an explicit active, eligible method. a connected link wallet returns item.description with the checkout flow; follow it. pay with link in this order: reach the final checkout page, choose a payment_method_id with "payment_methods", create the card with manage_vault_cards, then authorize it with browser_id and page_url from that checkout; read the card\'s available_operations descriptions for each next step. agentcard card_id may be omitted for cardholder selection at checkout approval. capabilities are advisory; absent means unknown. KERNEL-managed link oauth remains supported. customer-managed link requires authorization.client.provider_config and a write-only authorization.tokens pair supplied by a trusted backend, never chat; config credentials do not authorize a user. KERNEL owns refresh rotation after import. duplicate create never replaces a grant; bindings cannot change. agentcard spec.provider_config is optional. with a customer-owned config, user_id imports an existing connection after read-only validation with those credentials and does not require prior enrollment in this organization; a failed validation creates nothing and can be corrected and retried. with KERNEL-managed credentials, user_id must already be enrolled in this organization under the same config. no in-place imported reauthorization: obtain a fresh grant under a new wallet key for new payments only; retain unresolved old payments for reconciliation. never provide card data or oauth codes. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum([
          "create",
          "payment_methods",
          "add_payment_method",
          "remove_payment_method",
        ]),
        provider: vaultProviderSchema
          .describe("(create) payment provider.")
          .optional(),
        payment_method_id: z
          .string()
          .min(1)
          .max(128)
          .describe(
            "(remove_payment_method) id from the wallet's payment_methods expansion.",
          )
          .optional(),
        spec: z
          .union([
            linkWalletSpecSchema,
            agentcardWalletSpecSchema,
            kernelWalletSpecSchema,
            shopPayWalletSpecSchema,
          ])
          .describe(
            '(create) specification object, not a {type, spec} envelope. embedded provider must match provider. link: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}, or customer_managed with provider_config (exactly one id/name) and tokens from a trusted backend. agentcard: {} to enroll, optionally provider_config and/or user_id; customer-owned configs validate and import the existing user before creation, while KERNEL-managed credentials require prior enrollment under the same config. KERNEL: {}; creation may return an empty connected wallet, then add_payment_method supplies each hosted card-enrollment link. shop pay: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}; creation returns a shop_pay_oauth action and the connected wallet exposes saved cards through payment_methods. no card data in tool input.',
          )
          .optional(),
      }),
      annotations: {
        title: "manage KERNEL vault wallets",
        readOnlyHint: false,
        destructiveHint: true,
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
      if (
        params.action !== "create" &&
        (params.provider !== undefined || params.spec !== undefined)
      )
        return errorResponse(
          "provider and spec are only supported for create.",
        );
      if (
        params.action !== "remove_payment_method" &&
        params.payment_method_id !== undefined
      )
        return errorResponse(
          "payment_method_id is only supported for remove_payment_method.",
        );
      if (
        params.action === "remove_payment_method" &&
        params.payment_method_id === undefined
      )
        return errorResponse(
          "payment_method_id is required for remove_payment_method.",
        );
      let spec: ItemUpsertParams.WalletVaultItemRequest["spec"] | undefined;
      if (params.action === "create") {
        if (!params.provider || !params.spec)
          return errorResponse("provider and spec are required for create.");
        const parsed = (
          params.provider === "link"
            ? linkWalletSpecSchema.transform((spec) => ({
                ...spec,
                provider: "link" as const,
              }))
            : params.provider === "agentcard"
              ? agentcardWalletSpecSchema.transform((spec) => ({
                  ...spec,
                  provider: "agentcard" as const,
                }))
              : params.provider === "kernel"
                ? kernelWalletSpecSchema.transform((spec) => ({
                    ...spec,
                    provider: "kernel" as const,
                  }))
                : shopPayWalletSpecSchema.transform((spec) => ({
                    ...spec,
                    provider: "shop_pay" as const,
                  }))
        ).safeParse(params.spec);
        if (!parsed.success)
          return errorResponse(
            `invalid ${params.provider} wallet spec (${topLevelIssueKeys(parsed.error).join(", ") || "spec"}); no request was sent. correct these fields before creating.`,
          );
        spec = parsed.data;
      }
      let operationSubmitted = false;
      try {
        switch (params.action) {
          case "create": {
            if (!spec)
              return errorResponse(
                "provider and spec are required for create.",
              );
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
          case "add_payment_method":
          case "remove_payment_method": {
            const wallet = await client.vaults.items.retrieve(
              params.key,
              { id_or_name: params.vault },
              options,
            );
            if (wallet.type !== "wallet" || wallet.spec.provider !== "kernel")
              return errorResponse(
                `${params.action} is only available for a KERNEL wallet.`,
              );
            if (
              !wallet.available_operations.some(
                ({ type }) => type === params.action,
              )
            )
              return errorResponse(
                `${params.action} is not advertised in available_operations. inspect the wallet and payment_methods before taking further action.`,
              );
            operationSubmitted = true;
            const result = await client.vaults.items.performOperation(
              params.key,
              params.action === "add_payment_method"
                ? {
                    id_or_name: params.vault,
                    type: "add_payment_method",
                  }
                : {
                    id_or_name: params.vault,
                    type: "remove_payment_method",
                    payment_method_id: params.payment_method_id!,
                  },
              options,
            );
            return paymentMethodOperationResponse(result);
          }
        }
      } catch (error) {
        if (
          params.provider === "kernel" ||
          params.provider === "shop_pay" ||
          params.action === "add_payment_method" ||
          params.action === "remove_payment_method"
        )
          throwKernelVaultError(
            "manage_vault_wallets",
            params.action,
            error,
            operationSubmitted,
          );
        throwVaultError(
          "manage_vault_wallets",
          params.action,
          error,
          operationSubmitted,
        );
      }
    },
  );
}
