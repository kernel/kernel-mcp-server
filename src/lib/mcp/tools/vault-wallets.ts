import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ItemUpsertParams } from "@onkernel/sdk/resources/vaults/items";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { errorResponse, jsonResponse } from "@/lib/mcp/responses";
import {
  paymentMethodOperationGuidance,
  projectVaultOutput,
  throwKernelVaultError,
  throwVaultError,
  vaultItemResponse,
  vaultOperationResultFields,
} from "@/lib/mcp/vault-responses";
import {
  agentcardWalletSpecSchema,
  linkWalletSpecSchema,
  kernelWalletSpecSchema,
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
        'connect payment wallets without exposing secrets. KERNEL wallets use spec:{}. a KERNEL wallet holds zero or more cards as payment methods and may be connected with none. when the wallet advertises add_payment_method, create returns it connected and empty, and "add_payment_method" starts enrolling one card: it returns a pending_enrollment payment method with a single-use card_enrollment url that expires in 30 minutes. otherwise create returns the wallet\'s own card_enrollment action for its one default card, card. share enrollment urls only with the intended cardholder in a private surface, never open them for them. embedded card-capture tokens are bearer secrets and are intentionally not returned by mcp. "remove_payment_method" removes one card by payment_method_id, only when advertised and after explicit user confirmation; 409 purchase_unresolved means reconcile its purchases first, 409 provider_revocation_pending or removal_pending means retry later, and removal is not proof that a payment did not occur. add and remove need vaults:write on the vault; 403 insufficient_scope means the api key lacks it. "create" creates or retrieves an identical wallet by immutable key. hosted connection/enrollment actions are for the user; a valid imported link grant creates a connected wallet. "payment_methods" requests the advertised live payment_methods expansion. manage_vault_items get can request any advertised expansion, including live link_user_info and link_shipping_addresses data that KERNEL does not store; unavailable expansions return an api error. select link payment_method_id explicitly; never automatically choose a default. a connected link wallet returns item.description with the checkout flow; follow it. pay with link in this order: reach the final checkout page, choose a payment_method_id with "payment_methods", create the card with manage_vault_cards, then authorize it with browser_id and page_url from that checkout; read the card\'s available_operations descriptions for each next step. agentcard card_id may be omitted for cardholder selection at checkout approval. capabilities are advisory; absent means unknown. KERNEL-managed link oauth remains supported. customer-managed link requires authorization.client.provider_config and a write-only authorization.tokens pair supplied by a trusted backend, never chat; config credentials do not authorize a user. KERNEL owns refresh rotation after import. duplicate create never replaces a grant; bindings cannot change. agentcard spec.provider_config is optional. with a customer-owned config, user_id imports an existing connection after read-only validation with those credentials and does not require prior enrollment in this organization; a failed validation creates nothing and can be corrected and retried. with KERNEL-managed credentials, user_id must already be enrolled in this organization under the same config. no in-place imported reauthorization: obtain a fresh grant under a new wallet key for new payments only; retain unresolved old payments for reconciliation. never provide card data or oauth codes. requests are not automatically retried.',
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
        spec: z
          .union([
            linkWalletSpecSchema,
            agentcardWalletSpecSchema,
            kernelWalletSpecSchema,
          ])
          .describe(
            '(create) specification object, not a {type, spec} envelope. embedded provider must match provider. link: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}, or customer_managed with provider_config (exactly one id/name) and tokens from a trusted backend. agentcard: {} to enroll, optionally provider_config and/or user_id; customer-owned configs validate and import the existing user before creation, while KERNEL-managed credentials require prior enrollment under the same config. KERNEL: {}; cards are enrolled on hosted pages, never through tool input.',
          )
          .optional(),
        payment_method_id: z
          .string()
          .min(1)
          .max(128)
          .describe(
            "(remove_payment_method) id from the wallet's payment_methods expansion.",
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
              : kernelWalletSpecSchema.transform((spec) => ({
                  ...spec,
                  provider: "kernel" as const,
                }))
        ).safeParse(params.spec);
        if (!parsed.success)
          return errorResponse(
            `invalid ${params.provider} wallet spec (${topLevelIssueKeys(parsed.error).join(", ") || "spec"}); no request was sent. correct these fields before creating.`,
          );
        spec = parsed.data;
      }
      if (
        (params.action === "remove_payment_method") !==
        (params.payment_method_id !== undefined)
      )
        return errorResponse(
          "payment_method_id is required for remove_payment_method and only accepted there.",
        );
      const paymentMethodAction =
        params.action === "add_payment_method" ||
        params.action === "remove_payment_method";
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
                `${params.action} is only for KERNEL wallets; the item is not a KERNEL wallet.`,
              );
            if (
              !wallet.available_operations.some(
                (op) => op.type === params.action,
              )
            )
              return errorResponse(
                `the wallet does not advertise ${params.action}. the api offers it only where enabled for the organization and to api keys with vaults:write on this vault; inspect the wallet before acting.`,
              );
            operationSubmitted = true;
            const result = await client.vaults.items.performOperation(
              params.key,
              params.payment_method_id === undefined
                ? { id_or_name: params.vault, type: "add_payment_method" }
                : {
                    id_or_name: params.vault,
                    type: "remove_payment_method",
                    payment_method_id: params.payment_method_id,
                  },
              options,
            );
            if (result.type !== params.action)
              return errorResponse(
                "operation returned an unrecognized response. inspect the wallet's payment_methods before acting; do not retry automatically.",
              );
            return jsonResponse({
              result: projectVaultOutput(result, vaultOperationResultFields),
              hints: {
                observation: [
                  {
                    tool: "manage_vault_wallets",
                    arguments: { ...target, action: "payment_methods" },
                  },
                ],
              },
              guidance: paymentMethodOperationGuidance.get(params.action),
            });
          }
        }
      } catch (error) {
        if (params.provider === "kernel" || paymentMethodAction)
          throwKernelVaultError(
            "manage_vault_wallets",
            params.action,
            error,
            operationSubmitted,
          );
        throwVaultError("manage_vault_wallets", params.action, error);
      }
    },
  );
}
