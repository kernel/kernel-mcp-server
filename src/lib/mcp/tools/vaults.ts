import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
} from "@/lib/mcp/vault-schemas";
import { registerVaultWalletTools } from "@/lib/mcp/tools/vault-wallets";
import { registerVaultCardTools } from "@/lib/mcp/tools/vault-cards";
import { registerVaultItemTools } from "@/lib/mcp/tools/vault-items";

export function registerVaultCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  registerVaultWalletTools(server, dependencies);
  registerVaultCardTools(server, dependencies);
  registerVaultItemTools(server, dependencies);

  server.tool(
    "manage_vaults",
    'Manage project-owned payment vaults, not merchant payments. "create" creates or retrieves a vault by immutable name; "list" lists the effective project only; "get" reads one; "delete" invalidates the vault and every item credential. Confirm deletion with the user first. Connect a wallet with manage_vault_wallets, configure a card with manage_vault_cards, and observe actions/outcomes with manage_vault_items. Requests are not automatically retried.',
    {
      ...vaultProjectSchema,
      action: z.enum(["create", "list", "get", "delete"]),
      vault: vaultSelectorSchema()
        .describe("(get, delete) Vault ID or immutable name.")
        .optional(),
      name: vaultSelectorSchema()
        .describe("(create) Immutable vault name.")
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel payment vaults",
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
