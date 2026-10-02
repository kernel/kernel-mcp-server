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
        'inspect credential and payment vault items and immutable audit events. "list" reads items without renewing collection links; "get" reads state, safe field metadata, version, required user actions, available_operations, and available_expansions. mcp returns explicitly non-sensitive text/email values; sensitive values and totp seeds are omitted. for credentials, present the collection url only to the intended user, outside the agent-controlled browser; never ask for passwords or totp seeds in chat. reopen collection using its advertised operation when available; totp has no hosted input. wait observes readiness, not edits to ready credentials: compare versions using get without wait. use manage_vault_credentials for credential creation and updates; use a per-user vault, site-name-only description, and sensitive:false for ordinary usernames/emails. at a login page, list first and reuse a ready credential for that site; 1password credentials show requested websites in spec.requests. credentials follow one of two user-chosen paths: KERNEL-hosted collection (collect, fill) or 1password brokered approval (1pw_create_access_request, 1pw_access_request_status, 1pw_fill on the credential; 1pw_recover to recover a failed account link on its credential_account). for 1password, approval happens in the account owner\'s 1password app: give the native onepassword:// approval link only to the owner, outside the agent-controlled browser, and never open or approve it yourself. 1pw_create_access_request needs the browser_id of a browser created with this vault attached, so create the browser first. 1pw_access_request_status only reads status and needs no user approval. 1pw_fill can submit the form but does not prove login; when several approved logins share the page origin, ask the owner which to use and pass its entry_id. never retry fill_unknown in the same browser. an uncertain access request stays blocked with no advertised operations; never delete or recreate the item to retry it. only after a confirmed failed status may you, with the end-user\'s approval, delete and recreate the credential for one new request. 1pw_update_access_token takes a secret token and is refused here; the integrating developer uses the KERNEL api. never store credit card data in credential items. "invoke" fetches the item again and submits only an advertised operation; read its description and obtain explicit user approval first, except for 1pw_access_request_status. provider actions (oauth, enrollment, mfa, approval) must be completed by the user, not invoked as operations. "events" observes outcomes; use the last event id as after. "delete" invalidates an item credential; confirm with the user first. unresolved payments can block item and parent deletion; the api decides whether explicit abandonment is allowed, and deletion never proves a payment did not occur. recovery_required is not decline or expiry: stop payment attempts and reconcile with the provider or support; no reset exists. credential ready means required values exist, not that login succeeded; payment ready does not mean paid. for browser field writes, supply operation-specific inputs with browser_id and ordered field/selector bindings; values stay server-side until entering the browser. link cards use the advertised browser field-writing operation, not aliases or egress substitution: inputs.page_url must be the exact current https top-level page url at the approved merchant origin, and the browser must retain its vault attachment. browser field writes return no card values but do not isolate them from browser/cdp access or explicitly submit checkout; failed or unknown writes may leave partial changes. never automatically retry or fall back to aliases. agentcard aliases and checkout hold/approval/replay remain supported. follow each advertised operation\'s api contract for inputs and outcome handling; never substitute another operation or retry an uncertain attempt. requests are never automatically retried. do not retry failed, timed-out, rejected, or indeterminate payments; inspect state/events instead.',
      inputSchema: vaultToolInput({
        ...vaultItemSchema,
        action: z.enum(["list", "get", "invoke", "events", "delete"]),
        key: vaultKeySchema()
          .describe("required except for list. immutable item key, not id.")
          .optional(),
        operation: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0)
          .describe(
            "(invoke) type advertised in available_operations. availability and required inputs are api-controlled, not inferred from provider or state.",
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
            "(invoke) optional operation-specific request body fields. read available_operations and the api contract for required inputs. do not include type or id_or_name; the tool sets those. never supply secret values in chat.",
          ),
        expand: z
          .array(z.enum(["payment_methods"]))
          .describe(
            "(get) advertised live expansion. an unavailable expansion returns an api error, not a partial item.",
          )
          .optional(),
        wait: vaultWaitSchema,
        after: z
          .string()
          .min(1)
          .describe(
            "(events) return events after this event id; preserve the vault and item key.",
          )
          .optional(),
      }),
      annotations: {
        title: "inspect and operate KERNEL vault items",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
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
            if (params.operation === "1pw_update_access_token")
              return errorResponse(
                "1pw_update_access_token takes a secret access token and is not available through mcp. the integrating developer replaces it through the KERNEL api; never ask for tokens in chat.",
              );
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
                "operation is not advertised in available_operations. inspect the item before taking further action.",
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
                "operation returned an unrecognized response. inspect item state and events before acting; do not retry automatically.",
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
                "operation returned an unrecognized response. inspect item state and events before acting; do not retry automatically.",
              );
            return {
              ...jsonResponse({
                result: projected,
                guidance:
                  projected.type === "1pw_fill"
                    ? "fill_submitted means the 1password extension reported submitting the form, not that login succeeded: check the page before continuing. do not automatically retry a failed or uncertain fill."
                    : "inspect item state and events for the outcome. do not automatically retry an uncertain operation.",
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
                "observing events never retries an operation. for edits to ready credentials, compare item versions without wait; a version change does not identify a specific form submission. do not replay an uncertain fill or payment.",
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
