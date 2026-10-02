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
import { registerVaultProviderConfigTools } from "@/lib/mcp/tools/vault-provider-configs";

export function registerVaultCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  registerVaultProviderConfigTools(server, dependencies);
  registerVaultWalletTools(server, dependencies);
  registerVaultCardTools(server, dependencies);
  registerVaultCredentialTools(server, dependencies);
  registerVaultItemTools(server, dependencies);

  server.registerTool(
    "manage_vaults",
    {
      description:
        'manage project-owned vaults for end-user credentials and payment items. use a separate vault per end user, with an immutable name such as user-123; do not mix unrelated users. vaults store credentials, not authenticated browser sessions, and do not submit website forms or merchant payments. "create" creates or retrieves a vault by immutable name; "list" lists the effective project only; "get" reads one; "delete" invalidates the vault and every item credential. confirm deletion with the user first; unresolved payment operations block deletion and require provider/support reconciliation. connect a payment wallet with manage_vault_wallets, configure a card with manage_vault_cards, and inspect credentials or payment items with manage_vault_items. credentials have two paths: KERNEL-hosted collection or 1password brokered approval. reuse an existing credential for the site first; otherwise ask the user which they prefer, meaning where their login lives, before creating credentials with manage_vault_credentials. for KERNEL-hosted collection, create definitions or update values, then use manage_vault_items to collect, observe readiness, and invoke fill with value-free bindings. for 1password, connect the account once per end-user vault, create the credential, create a browser with this vault attached, then request access in that browser; the request returns the link the user approves in their 1password app. for credentials, inspect the website and create the named field definitions in its natural top-to-bottom order because that array order controls the user-facing form. use only the recognizable site name as description and set sensitive:false explicitly for ordinary usernames/emails; passwords and totp seeds must be sensitive. never put credit card data in credential items. attach vaults when creating a browser; bindings cannot change later. requests are not automatically retried.',
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
