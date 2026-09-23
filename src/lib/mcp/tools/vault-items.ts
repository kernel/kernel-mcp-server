import type { McpServer } from "@modelcontextprotocol/server";
import { APIError } from "@onkernel/sdk";
import { z } from "zod";
import {
  vaultFillSchema,
  vaultFillResponse,
  throwVaultFillError,
} from "@/lib/mcp/vault-fill";
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
  vaultObservationHints,
} from "@/lib/mcp/vault-responses";
import {
  vaultItemSchema,
  vaultKeySchema,
  vaultOperationRequiresInputs,
  vaultWaitSchema,
  vaultToolInput,
} from "@/lib/mcp/vault-schemas";

export function registerVaultItemTools(
  server: McpServer,
  dependencies: McpDependencies,
) {
  server.registerTool(
    "manage_vault_items",
    {
      description:
        'Inspect credential and payment vault items and immutable audit events. "list" reads items without renewing collection links; "get" reads state, safe field metadata, version, required user actions, available_operations, and available_expansions. MCP returns explicitly non-sensitive text/email values; sensitive values and TOTP seeds are omitted. For credentials, present the collection URL only to the intended user, outside the agent-controlled browser; never ask for passwords or TOTP seeds in chat. Use action: "invoke" with operation: "collect" to reopen the full form without clearing values or changing version; TOTP has no hosted input. wait observes readiness, not edits to ready credentials: compare versions using get without wait. Use manage_vault_credentials for credential creation and updates; use a per-user vault, site-name-only description, and sensitive:false for ordinary usernames/emails. Never store credit card data in credential items. "invoke" fetches the item again and submits only an advertised operation; read its description and obtain explicit user approval first. Provider actions (OAuth, enrollment, MFA, approval) must be completed by the user, not invoked as operations. "events" observes outcomes; use the last event ID as after. "delete" invalidates an item credential; confirm with the user first. Unresolved payments can block item and parent deletion; the API decides whether explicit abandonment is allowed, and deletion never proves a payment did not occur. recovery_required is not decline or expiry: stop payment attempts and reconcile with the provider or support; no reset exists. Credential ready means required values exist, not that login succeeded; payment ready does not mean paid. For fill, supply the fill object with browser_id and ordered field/selector bindings; values stay server-side until entering the browser. Link cards use advertised fill, not aliases or egress substitution: fill.page_url must be the exact current HTTPS top-level page URL at the approved merchant origin, and the browser must retain its vault attachment. Fill returns no card values but does not isolate them from browser/CDP access or explicitly submit checkout; failed or unknown fills may leave partial writes. Never automatically retry or fall back to aliases. AgentCard aliases and checkout hold/approval/replay remain supported. prepare_checkout remains API-only here; never substitute another operation or retry an uncertain attempt. Requests are never automatically retried. Do not retry failed, timed-out, rejected, or indeterminate payments; inspect state/events instead.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        action: z.enum(["list", "get", "invoke", "events", "delete"]),
        key: vaultKeySchema()
          .describe("Required except for list. Immutable item key, not ID.")
          .optional(),
        operation: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0)
          .describe(
            "(invoke) Type advertised in available_operations. For fill, supply the fill object. prepare_checkout still requires the Kernel API. Availability is API-controlled, not inferred from provider or state.",
          )
          .optional(),
        fill: vaultFillSchema
          .optional()
          .describe(
            "(invoke fill only) Value-free field bindings. Authorize the destination; each selector must resolve uniquely across all frames. Credentials forbid format; cards require HTTPS page_url. No navigation, submission, rollback, or automatic retry.",
          ),
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
      }),
      annotations: {
        title: "Inspect and operate Kernel vault items",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("Authentication required");
      const project = projectForOperation(ctx.http.authInfo, params);
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        project,
      );
      const options = { maxRetries: 0, signal: ctx.mcpReq.signal };
      let fillRequested = false;
      try {
        if (
          params.wait !== undefined &&
          params.action !== "get" &&
          params.action !== "events"
        ) {
          return errorResponse(
            "wait is only supported for get and events; invoke does not wait for collection or authorization.",
          );
        }
        if (
          params.fill !== undefined &&
          (params.action !== "invoke" || params.operation !== "fill")
        )
          return errorResponse(
            "fill parameters are only supported for invoke fill.",
          );
        if (
          params.action === "invoke" &&
          params.operation === "fill" &&
          params.fill === undefined
        )
          return errorResponse("fill parameters are required for invoke fill.");
        if (params.action === "list") {
          const items = await client.vaults.items.list(params.vault, options);
          return jsonResponse({
            items: projectVaultOutput(items, vaultItemFields),
          });
        }
        if (!params.key)
          return errorResponse("key is required except for list.");
        const target = { project, vault: params.vault, key: params.key };
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
                signal: ctx.mcpReq.signal,
              },
            );
            return vaultItemResponse(item, target);
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
            if (operation.type === "fill" && params.fill) {
              fillRequested = true;
              const result = await client.vaults.items.performOperation(
                params.key,
                { id_or_name: params.vault, type: "fill", ...params.fill },
                options,
              );
              return vaultFillResponse(result, params.fill.fields.length);
            }
            if (vaultOperationRequiresInputs(operation.type)) {
              return errorResponse(
                `${operation.type} requires additional inputs not supported by this tool. Use the Kernel API for this operation.`,
              );
            }
            const updated = await client.vaults.items.performOperation(
              params.key,
              {
                id_or_name: params.vault,
                type: operation.type,
              },
              options,
            );
            return vaultItemResponse(updated, target);
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
                signal: ctx.mcpReq.signal,
              },
            );
            const lastEventID = events.at(-1)?.id;
            if (lastEventID !== undefined && typeof lastEventID !== "string") {
              throw new Error("Invalid vault event cursor");
            }
            const nextAfter = lastEventID ?? params.after;
            return jsonResponse({
              events: projectVaultOutput(events, vaultEventFields),
              next_after: nextAfter ?? null,
              hints: { observation: vaultObservationHints(target, nextAfter) },
              guidance:
                "Observing events never retries an operation. For edits to ready credentials, compare item versions without wait; a version change does not identify a specific form submission. Do not replay an uncertain fill or payment.",
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
        if (fillRequested) throwVaultFillError(error);
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
