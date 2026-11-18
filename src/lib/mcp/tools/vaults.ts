import type { McpServer } from "@modelcontextprotocol/server";
import { APIError } from "@onkernel/sdk";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectVaultOutput,
  throwVaultError,
  vaultFields,
} from "@/lib/mcp/vault-responses";
import {
  vaultProjectSchema,
  vaultSelectorSchema,
  vaultToolInput,
} from "@/lib/mcp/vault-schemas";
import { registerVaultCredentialTools } from "@/lib/mcp/tools/vault-credentials";
import { registerVaultWalletTools } from "@/lib/mcp/tools/vault-wallets";
import { registerVaultCardTools } from "@/lib/mcp/tools/vault-cards";
import { registerVaultItemTools } from "@/lib/mcp/tools/vault-items";
import { registerVaultPaymentRequestTools } from "@/lib/mcp/tools/vault-payment-requests";
import { registerVaultProviderConfigTools } from "@/lib/mcp/tools/vault-provider-configs";

export function registerVaultCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  registerVaultProviderConfigTools(server, dependencies);
  registerVaultWalletTools(server, dependencies);
  registerVaultCardTools(server, dependencies);
  registerVaultPaymentRequestTools(server, dependencies);
  registerVaultCredentialTools(server, dependencies);
  registerVaultItemTools(server, dependencies);

  server.registerTool(
    "manage_vaults",
    {
      description:
        'manage project-owned vaults for end-user credentials and payment items. use a separate vault per end user with an immutable name; do not mix unrelated users. "create" creates or retrieves one by name, "list" searches the effective project, "get" reads one, and "delete" invalidates every item credential. confirm deletion first. unresolved payments can block it; each 1password credential_account stops filling immediately and, when no other vault uses the person\'s connection, is revoked at 1password. provider_revocation_pending keeps the vault while KERNEL finishes the revoke; delete the vault again later. use manage_vault_wallets, manage_vault_cards, manage_vault_payment_requests, manage_vault_credentials, and manage_vault_items for item-specific work. to pay with link: reach the final checkout page in a browser with this vault attached, create the card, authorize it with browser_id and page_url, share the approval url, wait until fill is advertised, fill, then submit the checkout yourself. for credentials, reuse an existing credential for the site first. otherwise ask whether the user prefers KERNEL-hosted collection or 1password brokered approval; managed_auth is a separate reuse path for an existing saved connection. for KERNEL collection, use a recognizable site name, set sensitive:false for ordinary usernames/emails, keep passwords, totp seeds, and passkeys sensitive, and use value-free browser bindings. for 1password, connect the account in this user\'s vault, create the credential, then request access with 1pw_create_access_request, which needs no browser; create a browser with this vault attached only when ready to invoke 1pw_fill. never put card data in credential items. attach the vault when creating a browser; bindings cannot change later. requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultProjectSchema,
        action: z.enum(["create", "list", "get", "delete"]),
        vault: vaultSelectorSchema()
          .describe("(get, delete) vault id or immutable name.")
          .optional(),
        name: vaultSelectorSchema()
          .describe(
            "(create) immutable per-end-user vault name, e.g. user-123. reuse that user's vault; do not mix unrelated users.",
          )
          .optional(),
        query: z
          .string()
          .describe(
            "(list) case-insensitive substring match against vault name; ids match exactly.",
          )
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL vaults",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );
      const options = { maxRetries: 0, signal: ctx.mcpReq.signal };
      try {
        switch (params.action) {
          case "create": {
            if (!params.name)
              return errorResponse("name is required for create.");
            const vault = await client.vaults.upsert(
              { name: params.name },
              options,
            );
            return jsonResponse(projectVaultOutput(vault, vaultFields));
          }
          case "list": {
            const page = await client.vaults.list(
              {
                ...(params.query !== undefined && { query: params.query }),
                ...(params.limit !== undefined && { limit: params.limit }),
                ...(params.offset !== undefined && { offset: params.offset }),
              },
              options,
            );
            return paginatedJsonResponse(page, {
              mapItem: (vault) => projectVaultOutput(vault, vaultFields),
              emptyText: "no vaults found in the effective project.",
            });
          }
          case "get": {
            if (!params.vault)
              return errorResponse("vault is required for get.");
            const vault = await client.vaults.retrieve(params.vault, options);
            return jsonResponse(projectVaultOutput(vault, vaultFields));
          }
          case "delete": {
            if (!params.vault)
              return errorResponse("vault is required for delete.");
            await client.vaults.delete(params.vault, options);
            return jsonResponse({
              status: "deleted_or_not_found",
              vault: params.vault,
            });
          }
        }
      } catch (error) {
        if (
          params.action === "delete" &&
          error instanceof APIError &&
          error.status === 404
        ) {
          return jsonResponse({
            status: "deleted_or_not_found",
            vault: params.vault,
          });
        }
        throwVaultError("manage_vaults", params.action, error);
      }
    },
  );
}
