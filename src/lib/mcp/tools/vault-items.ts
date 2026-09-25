import type { McpServer } from "@modelcontextprotocol/server";
import { APIError } from "@onkernel/sdk";
import { z } from "zod";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import { projectForOperation } from "@/lib/mcp/project-selection";
import { longOperationOptions } from "@/lib/mcp/request-options";
import { errorResponse, jsonResponse } from "@/lib/mcp/responses";
import {
  projectVaultOutput,
  throwVaultError,
  vaultOperationResultFields,
  vaultEventFields,
  vaultItemFields,
  vaultItemResponse,
  vaultObservationHints,
} from "@/lib/mcp/vault-responses";
import {
  vaultItemSchema,
  vaultKeySchema,
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
        'Inspect credential and payment vault items and immutable audit events. "list" reads items without renewing collection links; "get" reads state, safe field metadata, version, required user actions, available_operations, and available_expansions. MCP returns explicitly non-sensitive text/email values; sensitive values and TOTP seeds are omitted. For credentials, present the collection URL only to the intended user, outside the agent-controlled browser; never ask for passwords or TOTP seeds in chat. Reopen collection using its advertised operation when available; TOTP has no hosted input. wait observes readiness, not edits to ready credentials: compare versions using get without wait. Use manage_vault_credentials for credential creation and updates; use a per-user vault, site-name-only description, and sensitive:false for ordinary usernames/emails. Credentials follow one of two user-chosen paths: Kernel-hosted collection (collect, fill) or 1Password brokered approval (1pw_create_access_request, 1pw_access_request_status, 1pw_fill on the credential; 1pw_recover to recover a failed account link on its credential_account). For 1Password, approval happens in the account owner\'s 1Password app: give the native onepassword:// approval link only to the owner, outside the agent-controlled browser, and never open or approve it yourself; MCP never returns access-request IDs. 1pw_fill can submit the form but does not prove login; never retry fill_unknown in the same browser. An uncertain access request stays blocked with no advertised operations; never delete or recreate the item to retry it. Never store credit card data in credential items. "invoke" fetches the item again and submits only an advertised operation; read its description and obtain explicit user approval first. Provider actions (OAuth, enrollment, MFA, approval) must be completed by the user, not invoked as operations. "events" observes outcomes; use the last event ID as after. "delete" invalidates an item credential; confirm with the user first. Unresolved payments can block item and parent deletion; the API decides whether explicit abandonment is allowed, and deletion never proves a payment did not occur. recovery_required is not decline or expiry: stop payment attempts and reconcile with the provider or support; no reset exists. Credential ready means required values exist, not that login succeeded; payment ready does not mean paid. For browser field writes, supply operation-specific inputs with browser_id and ordered field/selector bindings; values stay server-side until entering the browser. Link cards use the advertised browser field-writing operation, not aliases or egress substitution: inputs.page_url must be the exact current HTTPS top-level page URL at the approved merchant origin, and the browser must retain its vault attachment. Browser field writes return no card values but do not isolate them from browser/CDP access or explicitly submit checkout; failed or unknown writes may leave partial changes. Never automatically retry or fall back to aliases. AgentCard aliases and checkout hold/approval/replay remain supported. Follow each advertised operation\'s API contract for inputs and outcome handling; never substitute another operation or retry an uncertain attempt. Requests are never automatically retried. Do not retry failed, timed-out, rejected, or indeterminate payments; inspect state/events instead.',
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
            "(invoke) Type advertised in available_operations. Availability and required inputs are API-controlled, not inferred from provider or state.",
          )
          .optional(),
        inputs: z
          .record(z.string(), z.unknown())
          .refine(
            (value) =>
              !("type" in value) &&
              !("id_or_name" in value) &&
              Buffer.byteLength(JSON.stringify(value), "utf8") <= 128 * 1024,
          )
          .optional()
          .describe(
            "(invoke) Optional operation-specific request body fields. Read available_operations and the API contract for required inputs. Do not include type or id_or_name; the tool sets those. Never supply secret values in chat.",
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
      let operationSubmitted = false;
      try {
        if (
          params.wait !== undefined &&
          params.action !== "get" &&
          params.action !== "events"
        ) {
          return errorResponse(
            "wait is only supported for get and events; invoke does not wait for operation outcomes.",
          );
        }
        if (params.inputs !== undefined && params.action !== "invoke")
          return errorResponse("inputs are only supported for invoke.");
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
            operationSubmitted = true;
            // The generated SDK union is closed; the API advertises types at runtime.
            const result = await client.vaults.items.performOperation(
              params.key,
              {
                id_or_name: params.vault,
                type: operation.type,
                ...params.inputs,
              } as Parameters<typeof client.vaults.items.performOperation>[1],
              options,
            );
            if (!result || typeof result !== "object" || Array.isArray(result))
              return errorResponse(
                "Operation returned an unrecognized response. Inspect item state and events before acting; do not retry automatically.",
              );
            if ("available_operations" in result)
              return vaultItemResponse(result, target);
            const projected = projectVaultOutput(
              result,
              vaultOperationResultFields,
            );
            if (
              !projected ||
              typeof projected !== "object" ||
              !("type" in projected) ||
              typeof projected.type !== "string"
            )
              return errorResponse(
                "Operation returned an unrecognized response. Inspect item state and events before acting; do not retry automatically.",
              );
            return {
              ...jsonResponse({
                result: projected,
                guidance:
                  "Inspect item state and events for the outcome. Do not automatically retry an uncertain operation.",
              }),
              ...(typeof projected === "object" &&
                projected !== null &&
                "status" in projected &&
                (projected.status === "failed" ||
                  projected.status === "unknown" ||
                  projected.status === "fill_failed" ||
                  projected.status === "fill_unknown") && {
                  isError: true as const,
                }),
            };
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
        throwVaultError(
          "manage_vault_items",
          params.action,
          error,
          operationSubmitted,
        );
      }
    },
  );
}
