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
} from "@/lib/mcp/vault-schemas";

export function registerVaultCardTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.registerTool(
    "manage_vault_cards",
    {
      description:
        'configure payment card requests in a per-end-user vault, not merchant payments. KERNEL cards use a connected KERNEL wallet, amount in minor units, https merchant_url and optional iso merchant_country (required by visa). "authorize" is only for KERNEL cards: after explicit user approval it invokes the currently advertised authorize operation, returning a visa spend_approval action for the cardholder or an issued mastercard card. give action urls only to the intended user privately; do not open them or include them in logs/traces. KERNEL cards cannot be updated; inspect with manage_vault_items get/events, and use advertised fill only when ready. card enrollment is hosted; never accept card numbers, cvc, or expiration data in tool inputs or credential items. mode is determined by the wallet credentials, not a per-item test flag; never assume a test transaction. "create" creates or retrieves an identical card request by immutable key. "update" replaces requested-card specs. pending issuance updates preserve omitted optional fields and clear explicit empty lists, only for provider-supported edits allowed by the api. wallet/provider binding cannot change after authorization starts. uncertain updates enter recovery_required; do not retry. neither implicitly authorizes link: inspect available_operations with manage_vault_items and obtain explicit user approval before invoking. for agentcard, optional checkout_origin is a caller-declared canonical https origin (or localhost http origin) that KERNEL forwards for eligible autopilot rule matching on non-prepared checkout authorizations. KERNEL does not compare it with the browser page; it does not enable autopilot or ensure payment success. omitting it retains the existing approval flow, and autopilot may fall back to user approval. prepared checkout uses preparation.merchant_origin. eligible unused agentcard cards advertise a checkout-preparation operation for supported tokenization checkout; invoke it through manage_vault_items with the api-required checkout inputs. keep the returned approval page open, poll until ready_to_submit, and submit native pay before preparation.expires_at. preparations are single-use, even after failure or expiry. amounts are integer minor currency units. no card data, oauth tokens, provider secrets, or domain configuration. never reconfigure a card to retry a failed, timed-out, rejected, or indeterminate payment. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update", "authorize"]),
        provider: vaultProviderSchema,
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
      try {
        if (params.action === "authorize") {
          if (params.provider !== "kernel" || params.spec !== undefined)
            return errorResponse(
              "authorize requires provider kernel and no spec.",
            );
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
          const item = await client.vaults.items.performOperation(
            params.key,
            { id_or_name: params.vault, type: "authorize" },
            options,
          );
          return vaultItemResponse(item, target);
        }
        if (params.provider === "kernel" && params.action === "update")
          return errorResponse(
            "kernel card updates are not supported; inspect the existing item.",
          );
        if (!params.spec)
          return errorResponse("spec is required for create/update.");
        const spec =
          params.provider === "link"
            ? {
                ...linkCardSpecSchema.parse(params.spec),
                provider: params.provider,
              }
            : params.provider === "agentcard"
              ? {
                  ...agentcardCardSpecSchema.parse(params.spec),
                  provider: params.provider,
                }
              : {
                  ...kernelCardSpecSchema.parse(params.spec),
                  provider: params.provider,
                };
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
        if (params.provider === "kernel")
          throwKernelVaultError("manage_vault_cards", params.action);
        throwVaultError("manage_vault_cards", params.action, error);
      }
    },
  );
}
