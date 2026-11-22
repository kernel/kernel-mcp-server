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
  kernelPaymentRequestSpecSchema,
  linkCardSpecSchema,
  topLevelIssueKeys,
  vaultItemSchema,
  vaultKeySchema,
  vaultToolInput,
} from "@/lib/mcp/vault-schemas";

export function registerVaultPaymentRequestTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.registerTool(
    "manage_vault_payment_requests",
    {
      description:
        'create or update one link or KERNEL purchase as a payment_request item, where payment requests are enabled for the organization. the item is parented by its wallet and follows the same authorize, fill, confirmation, recovery, event, and deletion flow as the corresponding link or KERNEL card item; use manage_vault_items for those advertised operations. agentcard reusable cards remain card items managed with manage_vault_cards. "create" creates or retrieves an identical request by immutable key. "update" sends a full replacement specification with the required payment_request type; the api rejects unsupported lifecycle or funding changes. link requests require an explicitly selected payment_method_id, amount of at most 50000 minor units, and context of at least 100 characters; recurring terms make amount the per-period limit. KERNEL requests require an active, eligible payment_method_id from the wallet payment_methods expansion, amount of at most 1000000 minor units, a supported currency, merchant name, and https merchant_url; merchant_country is required for visa, and actual merchant category or four-digit mcc may be supplied when known. the purchase remains bound to that payment method and cannot switch funding; removing it makes the purchase unusable rather than moving it to another card. never accept card numbers, cvc, expiration data, oauth tokens, or provider secrets. creation and update do not authorize or submit a payment, and requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update"]),
        provider: z.enum(["link", "kernel"]),
        spec: z
          .union([linkCardSpecSchema, kernelPaymentRequestSpecSchema])
          .describe(
            "(create, update) full provider specification object, not a {type, spec} envelope. embedded provider must match provider. link requires wallet, payment_method_id, amount, currency, merchant_name, merchant_url, context, and optional line_items, totals, metadata, or recurring terms. KERNEL requires wallet, payment_method_id, amount, supported currency, merchant_name, https merchant_url, and optional merchant_country, merchant_category, or merchant_category_code. no defaults or normalization are applied.",
          ),
      }),
      annotations: {
        title: "manage KERNEL vault payment requests",
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
      const parsed = (
        params.provider === "link"
          ? linkCardSpecSchema.transform((spec) => ({
              ...spec,
              provider: "link" as const,
            }))
          : kernelPaymentRequestSpecSchema.transform((spec) => ({
              ...spec,
              provider: "kernel" as const,
            }))
      ).safeParse(params.spec);
      if (!parsed.success)
        return errorResponse(
          `invalid ${params.provider} payment request spec (${topLevelIssueKeys(parsed.error).join(", ") || "spec"}); no request was sent. correct these fields before creating or updating.`,
        );

      try {
        const item =
          params.action === "create"
            ? await client.vaults.items.upsert(
                params.key,
                {
                  id_or_name: params.vault,
                  type: "payment_request",
                  spec: parsed.data,
                },
                options,
              )
            : await client.vaults.items.update(
                params.key,
                {
                  id_or_name: params.vault,
                  type: "payment_request",
                  spec: parsed.data,
                },
                options,
              );
        return vaultItemResponse(item, target);
      } catch (error) {
        if (params.provider === "kernel")
          throwKernelVaultError(
            "manage_vault_payment_requests",
            params.action,
            error,
          );
        throwVaultError("manage_vault_payment_requests", params.action, error);
      }
    },
  );
}
