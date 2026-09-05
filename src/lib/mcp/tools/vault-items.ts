import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APIError } from "@onkernel/sdk";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { errorResponse, jsonResponse } from "@/lib/mcp/responses";
import {
  projectVaultOutput,
  throwVaultError,
  vaultEventFields,
  vaultItemFields,
  vaultItemResponse,
} from "@/lib/mcp/vault-responses";
import {
  vaultItemSchema,
  vaultKeySchema,
  vaultWaitSchema,
} from "@/lib/mcp/vault-schemas";

export function registerVaultItemTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.tool(
    "manage_vault_items",
    'Inspect payment vault items and immutable audit events. "list" reads items; "get" reads state, public aliases, required user actions, available_operations, and available_expansions. "invoke" fetches the item again and submits only an advertised operation; read its description and obtain explicit user approval first. Provider actions (OAuth, enrollment, MFA, approval) must be completed by the user, not invoked as operations. "events" observes outcomes; use the last event ID as after. "delete" invalidates an item credential; confirm with the user first. Ready does not mean paid. Requests are never automatically retried. Do not retry failed, timed-out, rejected, or indeterminate payments; inspect state/events instead.',
    {
      ...vaultItemSchema,
      action: z.enum(["list", "get", "invoke", "events", "delete"]),
      key: vaultKeySchema
        .describe("Required except for list. Immutable item key, not ID.")
        .optional(),
      operation: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0)
        .describe(
          '(invoke) Type advertised in available_operations. The current API accepts "authorize", with no extra operation parameters. Availability is API-controlled, not inferred from provider or state.',
        )
        .optional(),
      expand: z
        .array(z.enum(["payment_methods"]))
        .describe(
          "(get) Advertised live expansion. An unavailable expansion returns an API error, not a partial item.",
        )
        .optional(),
      wait: vaultWaitSchema,
      after: z
        .string()
        .min(1)
        .describe(
          "(events) Return events after this event ID; preserve the vault and item key.",
        )
        .optional(),
    },
    {
      title: "Inspect and operate Kernel vault items",
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
        if (params.action === "list") {
          const items = await client.vaults.items.list(params.vault, options);
          return jsonResponse({
            items: projectVaultOutput(items, vaultItemFields),
          });
        }
        if (!params.key)
          return errorResponse("key is required except for list.");
        switch (params.action) {
          case "get": {
            const item = await client.vaults.items.retrieve(
              params.key,
              {
                id_or_name: params.vault,
                ...(params.wait !== undefined && { wait: params.wait }),
                ...(params.expand !== undefined && { expand: params.expand }),
              },
              {
                ...longOperationOptions(params.wait ?? 0),
                signal: extra.signal,
              },
            );
            return vaultItemResponse(item);
          }
          case "invoke": {
            if (!params.operation)
              return errorResponse("operation is required for invoke.");
            const item = await client.vaults.items.retrieve(
              params.key,
              { id_or_name: params.vault },
              options,
            );
            const operation = item.available_operations.find(
              (op) => op.type === params.operation,
            );
            if (!operation)
              return errorResponse(
                "Operation is not advertised in available_operations. Inspect the item before taking further action.",
              );
            const updated = await client.vaults.items.performOperation(
              params.key,
              {
                id_or_name: params.vault,
                type: operation.type,
              },
              options,
            );
            return vaultItemResponse(updated);
          }
          case "events": {
            const events = await client.vaults.items.events(
              params.key,
              {
                id_or_name: params.vault,
                ...(params.wait !== undefined && { wait: params.wait }),
                ...(params.after !== undefined && { after: params.after }),
              },
              {
                ...longOperationOptions(params.wait ?? 0),
                signal: extra.signal,
              },
            );
            const lastEventID = events.at(-1)?.id;
            if (lastEventID !== undefined && typeof lastEventID !== "string") {
              throw new Error("Invalid vault event cursor");
            }
            return jsonResponse({
              events: projectVaultOutput(events, vaultEventFields),
              next_after: lastEventID ?? params.after ?? null,
              guidance:
                "Observing events never retries a payment. Do not retry failed, timed-out, rejected, or indeterminate payments.",
            });
          }
          case "delete": {
            await client.vaults.items.delete(
              params.key,
              { id_or_name: params.vault },
              options,
            );
            return jsonResponse({
              status: "deleted_or_not_found",
              vault: params.vault,
              key: params.key,
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
            key: params.key,
          });
        }
        throwVaultError("manage_vault_items", params.action, error);
      }
    },
  );
}
