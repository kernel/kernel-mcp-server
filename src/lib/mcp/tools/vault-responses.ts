import { APIError } from "@onkernel/sdk";
import { z } from "zod";
import {
  agentCardCardSpecSchema,
  agentCardWalletSpecSchema,
  linkCardSpecSchema,
  linkWalletSpecSchema,
} from "@/lib/mcp/tools/vault-schemas";

// SDK types alone do not strip unexpected provider fields from JSON responses.
export const vaultOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const aliases = z.object({
  number: z.string(),
  cvc: z.string(),
  exp_month: z.string(),
  exp_year: z.string(),
});
const masks = z.object({
  brand: z.string().optional(),
  last4: z.string().optional(),
});
const authorization = z.object({
  id: z.string(),
  status: z.enum(["awaiting_approval", "approved", "declined", "expired"]),
  psp: z.string(),
  merchant: z.string(),
  amount_cents: z.number(),
  currency: z.string(),
  created_at: z.string(),
  browser_id: z.string().optional(),
  amount: z.string().optional(),
  amount_authority: z.string().optional(),
  approval_url: z.string().optional(),
  expires_at: z.string().optional(),
  psp_error_code: z.string().optional(),
  expected_cents: z.number().optional(),
  actual_cents: z.number().optional(),
  amount_verified: z.boolean().optional(),
  charged_amount_cents: z.number().optional(),
  charged_currency: z.string().optional(),
  charged_kind: z.string().optional(),
  replay_attempted: z.boolean().optional(),
  replay_status: z.number().optional(),
  replay_delivered: z.boolean().optional(),
});
const action = z.discriminatedUnion("name", [
  z.object({ name: z.literal("link_oauth"), url: z.string() }),
  z.object({ name: z.literal("spend_approval"), url: z.string() }),
  z.object({ name: z.literal("card_enrollment"), url: z.string() }),
  z.object({ name: z.literal("push_approval") }),
  z.object({ name: z.literal("collect") }),
  z.object({ name: z.literal("mfa") }),
  z.object({ name: z.literal("embedded_ceremony") }),
]);
const itemFields = {
  id: z.string(),
  key: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().optional(),
  action: action.optional(),
  available_operations: z.array(
    z.object({ type: z.literal("authorize"), description: z.string() }),
  ),
  available_expansions: z.array(
    z.object({ type: z.literal("payment_methods"), description: z.string() }),
  ),
};

export const vaultItemOutputSchema = z.discriminatedUnion("type", [
  z.object({
    ...itemFields,
    type: z.literal("wallet"),
    spec: z.discriminatedUnion("provider", [
      linkWalletSpecSchema().strip(),
      agentCardWalletSpecSchema().strip(),
    ]),
    state: z.discriminatedUnion("provider", [
      z.object({
        provider: z.literal("link"),
        status: z.enum([
          "pending_authorization",
          "connected",
          "declined",
          "reconnect_required",
          "degraded",
        ]),
        status_reason: z.string().optional(),
      }),
      z.object({
        provider: z.literal("agentcard"),
        status: z.enum(["pending_authorization", "connected", "degraded"]),
        status_reason: z.string().optional(),
        user_id: z.string().optional(),
      }),
    ]),
    expanded: z
      .object({
        payment_methods: z
          .array(
            z.object({
              id: z.string(),
              provider: z.string(),
              type: z.string(),
              is_default: z.boolean(),
              display: z.object({
                brand: z.string().optional(),
                label: z.string().optional(),
                last4: z.string().optional(),
              }),
              capabilities: z.object({
                single_use_card: z
                  .object({
                    eligible: z.boolean(),
                    reasons: z.array(z.string()),
                  })
                  .optional(),
              }),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
  z.object({
    ...itemFields,
    type: z.literal("card"),
    spec: z.discriminatedUnion("provider", [
      linkCardSpecSchema().omit({ metadata: true }).strip(),
      agentCardCardSpecSchema().strip(),
    ]),
    state: z.discriminatedUnion("provider", [
      z.object({
        provider: z.literal("link"),
        status: z.enum([
          "requested",
          "pending_authorization",
          "ready",
          "consumed",
          "expired",
          "declined",
        ]),
        status_reason: z.string().optional(),
        aliases: aliases.optional(),
        masks: masks.optional(),
        domains: z.array(z.string()).optional(),
      }),
      z.object({
        provider: z.literal("agentcard"),
        status: z.enum(["requested", "ready", "pending_approval", "degraded"]),
        status_reason: z.string().optional(),
        aliases: aliases.optional(),
        masks: masks.optional(),
        authorization: authorization.optional(),
      }),
    ]),
  }),
]);

// Event data is an untyped provider envelope. Outcomes remain visible through
// event names and the item's typed state/authorization, without raw payloads.
export const vaultEventOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  browser_id: z.string().optional(),
});

export function vaultErrorMessage(error: unknown) {
  const status = error instanceof APIError ? error.status : undefined;
  const detail =
    status === 400
      ? "Invalid vault request. Check the input schema and required fields."
      : status === 401 || status === 403
        ? "Vault access denied. Check connection scope and API availability."
        : status === 404
          ? "Vault or item unavailable. Check the selected project, identifier, and API availability."
          : status === 409
            ? "Vault state conflict. Read the item and its available_operations; ownership, names, keys, and provider are immutable. Card updates require an allowed state."
            : "Vault request did not complete successfully; its outcome may be unknown.";
  return `${status ? `HTTP ${status}. ` : ""}${detail} Do not retry a payment or repeat a mutation. Inspect get_item and item_events to determine the current state. Provider error details are withheld.`;
}
