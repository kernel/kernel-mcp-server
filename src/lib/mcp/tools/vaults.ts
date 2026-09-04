import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  cardSpecSchema,
  vaultItemInputSchema,
  vaultItemKeySchema,
} from "@/lib/mcp/tools/vault-schemas";
import {
  vaultErrorMessage,
  vaultEventOutputSchema,
  vaultItemOutputSchema,
  vaultOutputSchema,
} from "@/lib/mcp/tools/vault-responses";

export function registerVaultTools(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.tool(
    "manage_vaults",
    'Prepare and observe payment credentials in project-owned vaults; these API calls do not submit a merchant payment or grant permission to retry one. First inspect get_connection_context, then select a project and use "list", "get", or "upsert" to select/create a vault by immutable name. The owning project (project_id) cannot change. "delete" invalidates the vault and its items. Use "upsert_item" with a typed wallet/card request, "list_items" for discovery, "get_item" for current state, "update_item" with a complete card spec in an allowed state, and "delete_item" to invalidate an item (deleting a wallet also invalidates its dependent cards). Item keys, types, providers, and wallet specs are immutable; there is no rename or move operation.\n\nFor Link, create a kernel_managed OAuth wallet and follow its returned action URL until connected. Read the wallet first, then request expand=["payment_methods"] only when advertised in available_expansions; select its payment_method_id. Create a card request with the wallet key, merchant name/URL, amount in minor units, currency, purchase context, and explicit test=true/false intent. Inspect returned state.domains for permitted domains: this preview has no writable domains field. Upserting or updating a Link card does not authorize it. Read available_operations and their descriptions, then explicitly use "perform_item_operation" with operation="authorize" only when advertised. Link card specs can change only while requested.\n\nFor AgentCard, follow the wallet card_enrollment action; user_id can only reuse an already-enrolled user in this organization. Sandbox/live mode is deployment-configured, with no per-item test flag; confirm it before checkout. Configure the card merchant, amount, currency, wallet, and optional card_id. Cards are reusable and may be configured before or between authorizations when the API permits; checkout submission triggers a separate approval-gated authorization, not this tool.\n\nFollow returned action URLs or push/collection/MFA/embedded instructions on the provider-hosted surface, never by sending secrets to MCP. If no usable surface is supplied, stop for user assistance rather than inventing a callback. Attach the vault at browser creation via manage_browsers.vaults in the same project; bindings cannot change afterward. Use only the returned non-secret state.aliases in checkout, not real card data. Inspect get_item and item_events for outcomes; ready, consumed, or approved alone does not prove payment success. Never retry failed, timed-out, rejected, or indeterminate payments, including with a replacement item or browser. Never request or expose card data, OAuth tokens/codes, ciphertext, provider secrets, or raw provider responses. MCP outputs omit arbitrary metadata, event payloads, and unstructured authorization reasons.',
    {
      ...projectSelectionInputSchema({
        project:
          "Project name or ID owning the vault. Omit for the fixed connection project or the API default project (including list). Use the same project for vault items and browser creation; selecting a project never moves a vault.",
        project_id:
          "Deprecated: use project. Selects the owning project; project_id is immutable ownership, not an update field.",
      }),
      action: z
        .enum([
          "upsert",
          "list",
          "get",
          "delete",
          "upsert_item",
          "update_item",
          "list_items",
          "get_item",
          "delete_item",
          "item_events",
          "perform_item_operation",
        ])
        .describe(
          "Operation to perform. Mutations are never automatically retried.",
        ),
      id_or_name: z
        .string()
        .min(1)
        .describe(
          "Vault ID or immutable name. Required except for list and upsert.",
        )
        .optional(),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9._-]{1,255}$/)
        .describe(
          "(upsert) Immutable vault name, unique in the project; cannot be a cuid-like ID. Creates or retrieves, never renames.",
        )
        .optional(),
      key: vaultItemKeySchema
        .describe(
          "Immutable item key within this vault. Required for item operations except list_items.",
        )
        .optional(),
      item: vaultItemInputSchema
        .describe(
          "(upsert_item) Exactly type and provider-discriminated spec. Identical PUTs may retrieve an existing item; changed specs conflict, and authorized Link cards cannot be replaced. Use get_item to inspect, not repeated writes.",
        )
        .optional(),
      spec: cardSpecSchema
        .describe(
          "(update_item) Complete replacement card spec, not a partial patch. The API enforces provider and lifecycle constraints. Never use this to repeat an uncertain payment.",
        )
        .optional(),
      operation: z
        .literal("authorize")
        .describe(
          "(perform_item_operation) Only invoke after reading this operation's available_operations description. Applies to eligible Link cards, not AgentCard checkout approvals.",
        )
        .optional(),
      expand: z
        .array(z.literal("payment_methods"))
        .max(1)
        .describe(
          "(get_item) Request only an advertised available_expansions type. Live display-safe wallet funding methods are returned in expanded; unavailable expansions fail rather than returning partial data.",
        )
        .optional(),
      wait: z
        .number()
        .int()
        .min(0)
        .max(60)
        .describe(
          "(get_item, item_events) Long-poll for up to this many seconds (default 0). Set the MCP client's timeout above wait + 30 seconds. A wait timeout is not permission to repeat checkout.",
        )
        .optional(),
      after: z
        .string()
        .min(1)
        .describe(
          "(item_events) Return events after this event ID. Continue using the last returned ID; an empty list means no new events, not payment success.",
        )
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel vaults and payment items",
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
      const requestOptions = {
        ...longOperationOptions(params.wait ?? 60),
        signal: extra.signal,
      };

      try {
        if (params.action === "upsert") {
          if (!params.name)
            return errorResponse("Error: name is required for upsert.");
          const vault = await client.vaults.upsert(
            { name: params.name },
            requestOptions,
          );
          return jsonResponse(vaultOutputSchema.parse(vault));
        }
        if (params.action === "list") {
          const page = await client.vaults.list(
            {
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            },
            requestOptions,
          );
          return paginatedJsonResponse(page, {
            mapItem: (vault) => vaultOutputSchema.parse(vault),
            emptyText:
              'No vaults in this project. Use action "upsert" with an immutable name to create one.',
          });
        }
        if (!params.id_or_name)
          return errorResponse(
            "Error: id_or_name is required for this action.",
          );
        const id_or_name = params.id_or_name;
        if (params.action === "get") {
          return jsonResponse(
            vaultOutputSchema.parse(
              await client.vaults.retrieve(id_or_name, requestOptions),
            ),
          );
        }
        if (params.action === "delete") {
          await client.vaults.delete(id_or_name, requestOptions);
          return textResponse("Vault deleted and its items invalidated.");
        }
        if (params.action === "list_items") {
          return itemsJsonResponse(
            await client.vaults.items.list(id_or_name, requestOptions),
            {
              mapItem: (item) => vaultItemOutputSchema.parse(item),
              emptyText:
                "No items in this vault. Create a provider wallet before preparing a card request.",
            },
          );
        }
        if (!params.key)
          return errorResponse("Error: key is required for this item action.");
        switch (params.action) {
          case "upsert_item": {
            if (!params.item)
              return errorResponse("Error: item is required for upsert_item.");
            const item = await client.vaults.items.upsert(
              params.key,
              { id_or_name, ...params.item },
              requestOptions,
            );
            return jsonResponse(vaultItemOutputSchema.parse(item));
          }
          case "update_item": {
            if (!params.spec)
              return errorResponse("Error: spec is required for update_item.");
            const item = await client.vaults.items.update(
              params.key,
              { id_or_name, spec: params.spec },
              requestOptions,
            );
            return jsonResponse(vaultItemOutputSchema.parse(item));
          }
          case "get_item": {
            const item = await client.vaults.items.retrieve(
              params.key,
              {
                id_or_name,
                ...(params.expand !== undefined && { expand: params.expand }),
                ...(params.wait !== undefined && { wait: params.wait }),
              },
              requestOptions,
            );
            return jsonResponse(vaultItemOutputSchema.parse(item));
          }
          case "delete_item": {
            await client.vaults.items.delete(
              params.key,
              { id_or_name },
              requestOptions,
            );
            return textResponse(
              "Vault item invalidated; dependent cards are also invalidated when deleting a wallet.",
            );
          }
          case "item_events": {
            const events = await client.vaults.items.events(
              params.key,
              {
                id_or_name,
                ...(params.after !== undefined && { after: params.after }),
                ...(params.wait !== undefined && { wait: params.wait }),
              },
              requestOptions,
            );
            return itemsJsonResponse(events, {
              mapItem: (event) => vaultEventOutputSchema.parse(event),
              note: "Raw event data is withheld. Use get_item for typed state and authorization outcomes. Continue with after set to the last event ID; no new events does not establish payment success.",
            });
          }
          case "perform_item_operation": {
            if (!params.operation)
              return errorResponse(
                "Error: operation is required for perform_item_operation.",
              );
            const current = await client.vaults.items.retrieve(
              params.key,
              { id_or_name },
              requestOptions,
            );
            if (
              !current.available_operations.some(
                ({ type }) => type === params.operation,
              )
            ) {
              return errorResponse(
                "Error: operation is not currently advertised. Read get_item and its available_operations; do not retry a payment.",
              );
            }
            const item = await client.vaults.items.performOperation(
              params.key,
              { id_or_name, type: params.operation },
              requestOptions,
            );
            return jsonResponse(vaultItemOutputSchema.parse(item));
          }
        }
      } catch (error) {
        throwToolError(
          "manage_vaults",
          params.action,
          error,
          vaultErrorMessage(error),
        );
      }
    },
  );
}
