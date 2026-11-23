import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ItemUpsertParams } from "@onkernel/sdk/resources/vaults/items";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { errorResponse } from "@/lib/mcp/responses";
import {
  linkBalanceSetupOperationResponse,
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
        'connect payment wallets without exposing secrets. "create" upserts by immutable key; duplicates cannot replace grants, bindings, or token_refresh; shop pay returns shop_pay_oauth to be shared unchanged. "payment_methods" reads live methods. "link_balance_setup" gets an eligible connected link wallet\'s user-completed balance page. KERNEL create may return an empty wallet; "add_payment_method" starts enrollment and "remove_payment_method" removes a selected card after explicit confirmation; scoped keys need vaults:write plus vaults:use. share oauth, enrollment, and setup urls privately with the intended user; never open or log them; capture tokens are omitted. call manage_vault_items action "get" for link expansions. a connected link wallet returns item.description with the checkout flow. trusted backends, never chat, supply customer-managed grants and vgs; mcp cannot replace grants, so use a fresh key and retain unresolved payments. never provide card data or oauth codes; calls are not retried automatically.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum([
          "create",
          "payment_methods",
          "link_balance_setup",
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
            "(remove_payment_method) id from the wallet's payment_methods expansion. removes only that card and leaves the wallet connected even when no cards remain. purchase_unresolved means an unresolved purchase blocks removal; an uncertain provider outcome leaves the method removal_pending, refusing payments, until a later advertised retry.",
          )
          .optional(),
        enrollment: z
          .enum(["hosted", "server"])
          .describe(
            "(add_payment_method) hosted (default) returns a single-use 30-minute card_enrollment link for the cardholder. server returns a single-use 5-minute card_ingest url for the issuer's backend and requires organization card-ingest configuration. failed or expired enrollment does not affect other methods.",
          )
          .optional(),
        desired_balance_amount: z
          .number()
          .int()
          .safe()
          .min(100)
          .multipleOf(100)
          .describe(
            "(link_balance_setup) target balance in cents; minimum 100, whole-dollar multiples. link prefills the needed addition, skips it if covered, and refuses adding over $150.",
          )
          .optional(),
        desired_transaction_limit: z
          .number()
          .int()
          .safe()
          .min(100)
          .max(50000)
          .multipleOf(100)
          .describe(
            "(link_balance_setup) approval threshold in cents; 100-50000, whole-dollar multiples. present shows the step; omitted skips it. KERNEL cards still need approval.",
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
            '(create) specification object, not a {type, spec} envelope. embedded provider must match provider. link: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}, or customer_managed with provider_config (exactly one id/name), write-only tokens from a trusted backend, and optional token_refresh. omit token_refresh or use `kernel` with access_token plus refresh_token, then stop refreshing that grant; use `customer` with access_token only when the backend keeps and rotates the refresh token and replaces the access token through the KERNEL api. token_refresh is fixed at creation. agentcard: {} to enroll, optionally provider_config and/or user_id; customer-owned configs validate and import the existing user before creation (a failed validation creates nothing and can be corrected and retried), while KERNEL-managed credentials require prior enrollment under the same config. KERNEL: {}; creation may return an empty connected wallet, then add_payment_method uses enrollment hosted for a cardholder link or server for an issuer card-ingest url. shop pay: {"authorization":{"method":"oauth","client":{"type":"kernel_managed"}}}; creation returns a shop_pay_oauth action and the connected wallet exposes saved cards through payment_methods. no card data in tool input.',
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
        params.action !== "add_payment_method" &&
        params.enrollment !== undefined
      )
        return errorResponse(
          "enrollment is only supported for add_payment_method.",
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
      if (
        params.action !== "link_balance_setup" &&
        (params.desired_balance_amount !== undefined ||
          params.desired_transaction_limit !== undefined)
      )
        return errorResponse(
          "desired_balance_amount and desired_transaction_limit are only supported for link_balance_setup.",
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
          case "link_balance_setup": {
            const wallet = await client.vaults.items.retrieve(
              params.key,
              { id_or_name: params.vault },
              options,
            );
            if (wallet.type !== "wallet" || wallet.spec.provider !== "link")
              return errorResponse(
                "link_balance_setup is only available for a connected Link wallet.",
              );
            if (
              !wallet.available_operations.some(
                ({ type }) => type === "link_balance_setup",
              )
            )
              return errorResponse(
                'link_balance_setup is not advertised in available_operations. call manage_vault_items action "get" with expand ["link_user_info"]; link_user_info.eligible_for_balance depends on both the user and this wallet\'s link client.',
              );
            operationSubmitted = true;
            const result = await client.vaults.items.performOperation(
              params.key,
              {
                id_or_name: params.vault,
                type: "link_balance_setup",
                ...(params.desired_balance_amount !== undefined && {
                  desired_balance_amount: params.desired_balance_amount,
                }),
                ...(params.desired_transaction_limit !== undefined && {
                  desired_transaction_limit: params.desired_transaction_limit,
                }),
              },
              options,
            );
            return linkBalanceSetupOperationResponse(result);
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
                    ...(params.enrollment !== undefined && {
                      enrollment: params.enrollment,
                    }),
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
