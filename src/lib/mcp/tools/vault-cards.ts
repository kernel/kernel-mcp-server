import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import {
  throwKernelVaultError,
  linkCheckoutRecovery,
  throwLinkAuthorizeError,
  throwShopPayAuthorizeError,
  throwVaultError,
  vaultItemResponse,
} from "@/lib/mcp/vault-responses";
import { errorResponse } from "@/lib/mcp/responses";
import {
  agentcardCardSpecSchema,
  authorizeInputsIssueMessage,
  authorizeInputsSchema,
  linkCardSpecSchema,
  kernelCardSpecSchema,
  shopPayCardSpecSchema,
  vaultItemSchema,
  vaultKeySchema,
  vaultProviderSchema,
  vaultToolInput,
  topLevelIssueKeys,
} from "@/lib/mcp/vault-schemas";

export function registerVaultCardTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.registerTool(
    "manage_vault_cards",
    {
      description:
        'configure card requests in a per-end-user vault; this tool does not submit merchant payments. link checkout order: reach the final checkout page in a browser with this vault attached; "create" the card; after explicit approval, "authorize" with browser_id (browser session id) and page_url; share the approval url, then get the item until fill is advertised; fill as advertised and submit the checkout yourself. read available_operations descriptions for exact inputs and recovery. "update" can change a link card until it is authorized at a checkout; after that it returns 409: delete the card and create a new one. checkout inspection errors occur before a payment request: ' +
        linkCheckoutRecovery +
        ' declined, expired, or recovery_required cards need state reconciliation or a separately approved replacement; never repeat an unclear payment without checking merchant orders. shop pay follows the same create/authorize/fill/submit order; the card\'s guidance covers billing fill and confirm_transaction. KERNEL cards here are wallet-funded. creating KERNEL cards from caller-supplied single-use card details is intentionally unavailable through mcp; existing single-use cards use manage_vault_items. payment_method_id may explicitly select a method from the wallet\'s payment_methods expansion; omission uses only the legacy default. KERNEL authorize may take browser_id without page_url to name the attached browser that will pay; call it before opening the payment step, then retrieve until fill is advertised. billing_* fields may return field_unavailable before any write. after an observed merchant outcome, invoke advertised confirm_transaction once with status, transaction_type, amount, matching currency, and occurred_at. only an advertised restart_verification may be invoked, with fresh user approval, for recovery_required. do not retry uncertain payment operations; deletion never proves no payment occurred. action urls go only to the intended user and must not be opened or logged. never accept card numbers, cvc, expiration, api keys, or capability urls in inputs. mode is determined by the wallet credentials, not a per-item test flag. "create" is idempotent by immutable key; "update" replaces the requested spec but never authorizes. pending issuance updates preserve omitted optional fields and clear explicit empty lists where the provider permits edits; uncertain updates enter recovery_required and must not be retried. agentcard reusable cards support optional display-only line_items and totals; they do not change the approved or charged amount. optional checkout_origin is forwarded for eligible autopilot matching; KERNEL does not compare it with the browser page, and prepared checkout uses preparation.merchant_origin. vgs cards are provisioned only through a trusted backend api/sdk; existing cards authorize without browser inputs and mcp never returns aliases. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update", "authorize"]),
        provider: vaultProviderSchema.optional(),
        browser_id: z
          .string()
          .min(1)
          .describe(
            "(authorize) browser session id of a browser with this vault attached. link/shop_pay require it with page_url while final checkout is open. KERNEL accepts it without page_url to name the browser that will pay; authorize before that browser opens the payment step.",
          )
          .optional(),
        page_url: z
          .string()
          .describe(
            "(authorize, link/shop_pay) exact current top-level https url of the final checkout page open in browser_id. pass with browser_id, or omit both.",
          )
          .optional(),
        spec: z
          .union([
            linkCardSpecSchema,
            agentcardCardSpecSchema,
            kernelCardSpecSchema,
            shopPayCardSpecSchema,
          ])
          .describe(
            "(create/update) complete provider spec; embedded provider must match. link supports recurring terms and max amount 50000. agentcard supports 1-20 display-only line_items and optional nonnegative totals; updates replace the cart. KERNEL accepts wallet-funded cards, not single_use_card secrets. shop pay requires usd, amount at most 1000000, shopper context, and exactly one positive total no greater than amount. no normalization is applied.",
          )
          .optional(),
      }),
      annotations: {
        title: "configure KERNEL vault cards",
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
        params.action === "authorize" &&
        (params.spec !== undefined || params.provider === "agentcard")
      )
        return errorResponse(
          "authorize is only for link, kernel, shop_pay, and existing api-created vgs cards and takes no spec; provider may be omitted.",
        );
      if (
        params.action !== "authorize" &&
        (params.browser_id !== undefined || params.page_url !== undefined)
      )
        return errorResponse("browser_id and page_url are only for authorize.");
      if (params.action !== "authorize" && (!params.provider || !params.spec))
        return errorResponse(
          "provider and spec are required for create/update.",
        );
      const checkout = authorizeInputsSchema.safeParse({
        browser_id: params.browser_id,
        page_url: params.page_url,
      });
      if (!checkout.success)
        return errorResponse(authorizeInputsIssueMessage(checkout.error));
      if (params.provider === "kernel" && params.action === "update")
        return errorResponse(
          "kernel cards cannot be updated; after user confirmation, delete only if the api permits it and create a new item under a new key for a new purchase. reconcile unresolved outcomes first.",
        );
      const parsed =
        params.action === "authorize"
          ? undefined
          : (params.provider === "link"
              ? linkCardSpecSchema.transform((spec) => ({
                  ...spec,
                  provider: "link" as const,
                }))
              : params.provider === "agentcard"
                ? agentcardCardSpecSchema.transform((spec) => ({
                    ...spec,
                    provider: "agentcard" as const,
                  }))
                : params.provider === "kernel"
                  ? kernelCardSpecSchema.transform((spec) => ({
                      ...spec,
                      provider: "kernel" as const,
                    }))
                  : shopPayCardSpecSchema.transform((spec) => ({
                      ...spec,
                      provider: "shop_pay" as const,
                    }))
            ).safeParse(params.spec);
      if (parsed && !parsed.success)
        return errorResponse(
          `invalid ${params.provider} card spec (${topLevelIssueKeys(parsed.error).join(", ") || "spec"}); no request was sent. correct these fields before creating or updating.`,
        );
      const spec = parsed?.success ? parsed.data : undefined;
      let authorizationSubmitted = false;
      let checkoutProvider =
        params.provider === "link" || params.provider === "shop_pay"
          ? params.provider
          : undefined;
      try {
        if (params.action === "authorize") {
          const current = await client.vaults.items.retrieve(
            params.key,
            { id_or_name: params.vault },
            options,
          );
          const provider = current.type === "card" && current.spec.provider;
          checkoutProvider =
            provider === "link" || provider === "shop_pay"
              ? provider
              : undefined;
          if (
            (provider !== "kernel" &&
              provider !== "link" &&
              provider !== "shop_pay" &&
              provider !== "vgs") ||
            (params.provider !== undefined && params.provider !== provider)
          )
            return errorResponse(
              "authorize is only for link, kernel, shop_pay, and existing api-created vgs cards; the item is not a card from the given provider.",
            );
          if (
            (provider === "link" || provider === "shop_pay") &&
            (checkout.data.browser_id === undefined) !==
              (checkout.data.page_url === undefined)
          )
            return errorResponse(
              `${provider} cards require browser_id and page_url together, or neither.`,
            );
          if (provider === "kernel" && checkout.data.page_url !== undefined)
            return errorResponse(
              "kernel cards accept browser_id but not page_url; authorize before that browser opens the payment step.",
            );
          if (
            provider === "vgs" &&
            (checkout.data.browser_id !== undefined ||
              checkout.data.page_url !== undefined)
          )
            return errorResponse(
              "vgs cards do not accept browser_id or page_url; authorize without them.",
            );
          if (
            !current.available_operations.some((op) => op.type === "authorize")
          )
            return errorResponse(
              `${provider} card does not advertise authorize; inspect item state and events.`,
            );
          authorizationSubmitted = true;
          const item = await client.vaults.items.performOperation(
            params.key,
            { id_or_name: params.vault, type: "authorize", ...checkout.data },
            options,
          );
          return vaultItemResponse(item, target);
        }
        if (!spec) return errorResponse("spec is required for create/update.");
        const item =
          params.action === "create"
            ? await client.vaults.items.upsert(
                params.key,
                { id_or_name: params.vault, type: "card", spec },
                options,
              )
            : await client.vaults.items.update(
                params.key,
                { id_or_name: params.vault, spec },
                options,
              );
        return vaultItemResponse(item, target);
      } catch (error) {
        if (checkoutProvider === "link" && params.action === "authorize")
          throwLinkAuthorizeError(
            "manage_vault_cards",
            params.action,
            error,
            authorizationSubmitted,
          );
        if (checkoutProvider === "shop_pay" && params.action === "authorize")
          throwShopPayAuthorizeError(
            "manage_vault_cards",
            params.action,
            error,
            authorizationSubmitted,
          );
        if (
          params.provider === "kernel" ||
          params.provider === "shop_pay" ||
          params.action === "authorize"
        )
          throwKernelVaultError(
            "manage_vault_cards",
            params.action,
            error,
            authorizationSubmitted,
          );
        throwVaultError("manage_vault_cards", params.action, error);
      }
    },
  );
}
