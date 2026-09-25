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
        'Create immutable payment card requests in a per-end-user vault, not merchant payments. Use wallet/card items for credit card numbers, security codes, and expiration dates; never store that data in credential items. Mode is determined by the wallet credentials, not a per-item test flag; never assume a test transaction. "create" creates or retrieves an identical card request by immutable key; an identical create returns the existing item without repeating checkout discovery or approval. Cards are immutable and cannot be updated: to change a payment, delete the item and create a new request under a new key. Link: create only after the vault-attached browser reaches final checkout, with its live browser_id session ID and the exact final HTTPS checkout page_url. Kernel inspects that page and uses a merchant-bound Link Pay Token on Stripe Checkout pages that expose one, otherwise a one-time virtual card; callers never choose or see the mode. Creation starts the Link spend request: the item returns pending_authorization with an action URL the user opens to approve in Link. There is no separate authorize step. An uncertain creation enters recovery_required; do not retry or replace it. After approval the card becomes ready and advertises fill; read that operation\'s description for its required inputs. Eligible unused AgentCard cards advertise a checkout-preparation operation for supported tokenization checkout; invoke it through manage_vault_items with the API-required checkout inputs. Keep the returned approval page open, poll until ready_to_submit, and submit native Pay before preparation.expires_at. Preparations are single-use, even after failure or expiry. Amounts are integer minor currency units. No card data, OAuth tokens, provider secrets, or domain configuration. Never create a new card to retry a failed, timed-out, rejected, or indeterminate payment. Requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        key: vaultKeySchema(),
        action: z.enum(["create"]),
        provider: vaultProviderSchema,
        spec: z
          .union([linkCardSpecSchema, agentcardCardSpecSchema])
          .describe(
            "Full provider specification object, not a {type, spec} envelope. Embedded provider must match provider. No defaults or normalization are applied. Integers must be within JavaScript's safe range, including expires_at.",
          ),
      }),
      annotations: {
        title: "Create Kernel vault cards",
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
        const item = await client.vaults.items.upsert(
          params.key,
          { id_or_name: params.vault, type: "card", spec },
          options,
        );
        return vaultItemResponse(item, target);
      } catch (error) {
        throwVaultError("manage_vault_cards", params.action, error);
      }
    },
  );
}
