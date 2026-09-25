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
        'Manage project-owned vaults for end-user credentials and payment items. Use a separate vault per end user, with an immutable name such as user-123; do not mix unrelated users. Vaults store credentials, not authenticated browser sessions, and do not submit website forms or merchant payments. "create" creates or retrieves a vault by immutable name; "list" lists the effective project only; "get" reads one; "delete" invalidates the vault and every item credential. Confirm deletion with the user first; unresolved payment operations block deletion and require provider/support reconciliation. Connect a payment wallet with manage_vault_wallets, create a card with manage_vault_cards once the browser reaches final checkout, and inspect credentials or payment items with manage_vault_items. Use manage_vault_credentials to create definitions or update values, then manage_vault_items to collect, observe readiness, and invoke fill with value-free bindings. For credentials, inspect the website and create the named field definitions in its natural top-to-bottom order because that array order controls the user-facing form. Use only the recognizable site name as description and set sensitive:false explicitly for ordinary usernames/emails; passwords and TOTP seeds must be sensitive. Never put credit card data in credential items. Attach vaults when creating a browser; bindings cannot change later. Requests are not automatically retried.',
      inputSchema: vaultToolInput({
        ...vaultProjectSchema,
        action: z.enum(["create", "list", "get", "delete"]),
        vault: vaultSelectorSchema()
          .describe("(get, delete) Vault ID or immutable name.")
          .optional(),
        name: vaultSelectorSchema()
          .describe(
            "(create) Immutable per-end-user vault name, e.g. user-123. Reuse that user's vault; do not mix unrelated users.",
          )
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "Manage Kernel vaults",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
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
              emptyText: "No vaults found in the effective project.",
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
