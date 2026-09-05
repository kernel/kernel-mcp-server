import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
} from "@/lib/mcp/vault-schemas";

export function registerVaultCardTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.tool(
    "manage_vault_cards",
    'Configure payment card requests, not merchant payments. "create" creates or retrieves an identical card request by immutable key. "update" replaces the ENTIRE spec, removing omitted optional fields, only when the API permits it. Neither implicitly authorizes Link: inspect available_operations with manage_vault_items and obtain explicit user approval before invoking. AgentCard authorizes at checkout. Amounts are integer minor currency units. No card data, OAuth tokens, provider secrets, or domain configuration. Never reconfigure a card to retry a failed, timed-out, rejected, or indeterminate payment. Requests are not automatically retried.',
    {
      ...vaultItemSchema,
      key: vaultKeySchema,
      action: z.enum(["create", "update"]),
      provider: vaultProviderSchema,
      spec: z
        .union([linkCardSpecSchema, agentcardCardSpecSchema])
        .describe(
          "Full provider specification object, not a {type, spec} envelope. Embedded provider must match provider. No defaults or normalization are applied. Integers must be within JavaScript's safe range, including expires_at.",
        ),
    },
    {
      title: "Configure Kernel vault cards",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = dependencies.createKernelClient(
        extra.authInfo.token,
        projectForOperation(extra.authInfo, params),
      );
      const options = { maxRetries: 0, signal: extra.signal };
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
        return vaultItemResponse(item);
      } catch (error) {
        throwVaultError("manage_vault_cards", params.action, error);
      }
    },
  );
}
