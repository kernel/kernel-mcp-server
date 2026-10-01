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
        'Configure payment card requests in a per-end-user vault, not merchant payments. Use wallet/card items for credit card numbers, security codes, and expiration dates; never store that data in credential items. Mode is determined by the wallet credentials, not a per-item test flag; never assume a test transaction. "create" creates or retrieves an identical card request by immutable key. "update" replaces requested-card specs. Pending issuance updates preserve omitted optional fields and clear explicit empty lists, only for provider-supported edits allowed by the API. Wallet/provider binding cannot change after authorization starts. Uncertain updates enter recovery_required; do not retry. Neither implicitly authorizes Link: inspect available_operations with manage_vault_items and obtain explicit user approval before invoking. Eligible unused AgentCard cards advertise a checkout-preparation operation for supported tokenization checkout; invoke it through manage_vault_items with the API-required checkout inputs. Keep the returned approval page open, poll until ready_to_submit, and submit native Pay before preparation.expires_at. Preparations are single-use, even after failure or expiry. Amounts are integer minor currency units. No card data, OAuth tokens, provider secrets, or domain configuration. Never reconfigure a card to retry a failed, timed-out, rejected, or indeterminate payment. Requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create", "update"]),
        provider: vaultProviderSchema,
        spec: z
          .union([linkCardSpecSchema, agentcardCardSpecSchema])
          .describe(
            "Full provider specification object, not a {type, spec} envelope. Embedded provider must match provider. No defaults or normalization are applied. Integers must be within JavaScript's safe range, including expires_at.",
          ),
      }),
      annotations: {
        title: "Configure Kernel vault cards",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
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
