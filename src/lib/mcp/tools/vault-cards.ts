import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import {
  throwKernelVaultError,
  throwVaultError,
  vaultItemResponse,
} from "@/lib/mcp/vault-responses";
import { errorResponse } from "@/lib/mcp/responses";
import {
  agentcardCardSpecSchema,
  linkCardSpecSchema,
  kernelCardSpecSchema,
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
        'configure payment card requests in a per-end-user vault, not merchant payments. KERNEL cards use a connected KERNEL wallet, amount in minor units, https merchant_url and optional iso merchant_country (required by visa), actual merchant_category and four-digit merchant_category_code (not 0000); omit categories rather than invent them. "authorize" is only for KERNEL cards: after explicit user approval it invokes the currently advertised authorize operation, returning a visa spend_approval action for the cardholder or an issued mastercard card. give action urls only to the intended user privately; do not open them or include them in logs/traces. KERNEL cards cannot be updated; after user confirmation delete only if the api permits it and create a new item under a new key for a new purchase. reconcile unresolved outcomes first. authorize is equivalent to manage_vault_items invoke authorize. use advertised fill only when ready: number, expiration (format "MM/YY" or "MM/YYYY"), cvc, exp_month, exp_year; billing_* fields fail with 400 field_unavailable before any write. enter billing name/zip on the merchant page. after the user submits checkout and the merchant outcome is observed, use manage_vault_items invoke confirm_transaction only when advertised with status, transaction_type, amount, matching approved uppercase currency, occurred_at. "PENDING" means an explicitly accepted pending merchant transaction; "ERROR" means an explicit merchant transaction error, not transport loss or ambiguous processing. unknown outcomes: ask the user to check merchant orders, email or statement, then report the confirmed outcome even after expiry. on a lost report response re-get and send the identical report once more only if freshly advertised; never repeat checkout. only if a recovery_required KERNEL card advertises restart_verification, invoke it with no inputs after user approval each time and give the new spend_approval url privately to the cardholder; they must verify and approve spending again. if the result is unclear re-get; share a new action if present or invoke once more only if still advertised with renewed user approval. otherwise contact "support@kernel.sh" privately with project, vault, key, status_reason and event timestamps to reconcile; never delete or replace unresolved items or include card data, api keys or capability urls. card enrollment is hosted; never accept card numbers, cvc, or expiration data in tool inputs or credential items. mode is determined by the wallet credentials, not a per-item test flag; never assume a test transaction. "create" creates or retrieves an identical card request by immutable key. "update" replaces requested-card specs. pending issuance updates preserve omitted optional fields and clear explicit empty lists, only for provider-supported edits allowed by the api. wallet/provider binding cannot change after authorization starts. uncertain updates enter recovery_required; do not retry. neither implicitly authorizes link: inspect available_operations with manage_vault_items and obtain explicit user approval before invoking. for agentcard, optional checkout_origin is a caller-declared canonical https origin (or localhost http origin) that KERNEL forwards for eligible autopilot rule matching on non-prepared checkout authorizations. KERNEL does not compare it with the browser page; it does not enable autopilot or ensure payment success. omitting it retains the existing approval flow, and autopilot may fall back to user approval. prepared checkout uses preparation.merchant_origin. eligible unused agentcard cards advertise a checkout-preparation operation for supported tokenization checkout; invoke it through manage_vault_items with the api-required checkout inputs. keep the returned approval page open, poll until ready_to_submit, and submit native pay before preparation.expires_at. preparations are single-use, even after failure or expiry. amounts are integer minor currency units. no card data, oauth tokens, provider secrets, or domain configuration. never reconfigure a card to retry a failed, timed-out, rejected, or indeterminate payment. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update", "authorize"]),
        provider: vaultProviderSchema.optional(),
        spec: z
          .union([
            linkCardSpecSchema,
            agentcardCardSpecSchema,
            kernelCardSpecSchema,
          ])
          .describe(
            "(create/update) full provider specification object, not a {type, spec} envelope. embedded provider must match provider. KERNEL: wallet, amount, currency, merchant_name, https merchant_url, and merchant_country for visa. no defaults or normalization are applied.",
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
        (params.spec !== undefined ||
          (params.provider !== undefined && params.provider !== "kernel"))
      )
        return errorResponse(
          "authorize is only for kernel cards and takes no spec; provider may be omitted.",
        );
      if (params.action !== "authorize" && (!params.provider || !params.spec))
        return errorResponse(
          "provider and spec are required for create/update.",
        );
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
                : kernelCardSpecSchema.transform((spec) => ({
                    ...spec,
                    provider: "kernel" as const,
                  }))
            ).safeParse(params.spec);
      if (parsed && !parsed.success)
        return errorResponse(
          `invalid ${params.provider} card spec (${topLevelIssueKeys(parsed.error).join(", ") || "spec"}); no request was sent. correct these fields before creating or updating.`,
        );
      const spec = parsed?.success ? parsed.data : undefined;
      let authorizationSubmitted = false;
      try {
        if (params.action === "authorize") {
          const current = await client.vaults.items.retrieve(
            params.key,
            { id_or_name: params.vault },
            options,
          );
          if (
            current.type !== "card" ||
            current.spec.provider !== "kernel" ||
            !current.available_operations.some((op) => op.type === "authorize")
          )
            return errorResponse(
              "kernel card does not advertise authorize; inspect item state and events.",
            );
          authorizationSubmitted = true;
          const item = await client.vaults.items.performOperation(
            params.key,
            { id_or_name: params.vault, type: "authorize" },
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
        if (params.provider === "kernel" || params.action === "authorize")
          throwKernelVaultError(
            "manage_vault_cards",
            params.action,
            error,
            authorizationSubmitted ? "authorize" : undefined,
          );
        throwVaultError("manage_vault_cards", params.action, error);
      }
    },
  );
}
