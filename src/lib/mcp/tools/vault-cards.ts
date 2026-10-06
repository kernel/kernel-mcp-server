import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { throwVaultError, vaultItemResponse } from "@/lib/mcp/vault-responses";
import {
  agentcardCardSpecSchema,
  linkCardSpecSchema,
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
        'configure payment card requests in a per-end-user vault, not merchant payments. use wallet/card items for credit card numbers, security codes, and expiration dates; never store that data in credential items. mode is determined by the wallet credentials, not a per-item test flag; never assume a test transaction. "create" creates or retrieves an identical card request by immutable key. "update" replaces requested-card specs. pending issuance updates preserve omitted optional fields and clear explicit empty lists, only for provider-supported edits allowed by the api. wallet/provider binding cannot change after authorization starts. uncertain updates enter recovery_required; do not retry. neither implicitly authorizes link: inspect available_operations with manage_vault_items and obtain explicit user approval before invoking. for agentcard, optional checkout_origin is a caller-declared canonical https origin (or localhost http origin) that KERNEL forwards for eligible autopilot rule matching on non-prepared checkout authorizations. KERNEL does not compare it with the browser page; it does not enable autopilot or ensure payment success. omitting it retains the existing approval flow, and autopilot may fall back to user approval. prepared checkout uses preparation.merchant_origin. eligible unused agentcard cards advertise a checkout-preparation operation for supported tokenization checkout; invoke it through manage_vault_items with the api-required checkout inputs. keep the returned approval page open, poll until ready_to_submit, and submit native pay before preparation.expires_at. preparations are single-use, even after failure or expiry. amounts are integer minor currency units. no card data, oauth tokens, provider secrets, or domain configuration. never reconfigure a card to retry a failed, timed-out, rejected, or indeterminate payment. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update"]),
        provider: vaultProviderSchema,
        spec: z
          .union([linkCardSpecSchema, agentcardCardSpecSchema])
          .describe(
            "full provider specification object, not a {type, spec} envelope. embedded provider must match provider. no defaults or normalization are applied. integers must be within javascript's safe range, including expires_at.",
          ),
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
        const spec =
          params.provider === "link"
            ? {
                ...linkCardSpecSchema.parse(params.spec),
                provider: params.provider,
              }
            : {
                ...agentcardCardSpecSchema.parse(params.spec),
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
        throwVaultError("manage_vault_cards", params.action, error);
      }
    },
  );
}
