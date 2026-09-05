import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@onkernel/sdk";
import { z } from "zod";
import { jsonResponse, throwToolError } from "@/lib/mcp/responses";

type OutputFields = { [key: string]: OutputFields | null };

function fields(names: string): OutputFields {
  return Object.fromEntries(names.split(" ").map((name) => [name, null]));
}

export const vaultFields = fields("id name created_at updated_at");
const operationFields = fields("type description");
const totalFields = fields("type display_text amount");
const paymentMethodFields = {
  ...fields("id provider type is_default"),
  display: fields("label brand last4"),
  capabilities: { single_use_card: fields("eligible reasons") },
};

// Match the CLI's public projection, including future operation names but never
// unknown provider fields, free-form metadata, or opaque event data.
export const vaultItemFields: OutputFields = {
  ...fields("id key type created_at updated_at expires_at"),
  available_operations: operationFields,
  available_expansions: operationFields,
  action: fields("name url"),
  expanded: { payment_methods: paymentMethodFields },
  spec: {
    ...fields(
      "provider wallet user_id payment_method_id card_id amount currency merchant merchant_name merchant_url context expires_at",
    ),
    authorization: { method: null, client: fields("type") },
    totals: totalFields,
    line_items: {
      ...fields(
        "name quantity unit_amount description sku url image_url product_url",
      ),
      totals: totalFields,
    },
  },
  state: {
    ...fields("provider status status_reason user_id domains"),
    masks: fields("brand last4"),
    aliases: fields("number cvc exp_month exp_year"),
    authorization: fields(
      "id status psp merchant amount amount_cents currency created_at expires_at approval_url browser_id reason psp_error_code expected_cents actual_cents amount_authority amount_verified charged_amount_cents charged_currency charged_kind replay_attempted replay_status replay_delivered",
    ),
  },
};

export const vaultEventFields: OutputFields = {
  ...fields("id name created_at browser_id"),
  data: fields(
    "reason status authorization_id vault_session_id request_kind outcome_reason provider_status provider_code provider_request_id provider_payment_status provider_error_type provider_error_code provider_decline_code provider_error_param provider_http_status provider_response_bytes provider_latency_ms payment_intent_id payment_method_id checkout_session_id replay_attempted replay_delivered charged_amount_cents charged_currency charged_kind expected_cents actual_cents currency actual_currency intent_status amount_verified psp_error_code",
  ),
};

const urlFields = new Set([
  "url",
  "approval_url",
  "merchant_url",
  "image_url",
  "product_url",
]);
const secretURLKeys = new Set([
  "code",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "password",
]);

export function isDisplaySafeVaultURL(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return false;
    for (const params of [
      url.searchParams,
      new URLSearchParams(url.hash.slice(1)),
    ]) {
      for (const key of params.keys()) {
        if (secretURLKeys.has(key.toLowerCase())) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function projectVaultOutput(
  value: unknown,
  allowed: OutputFields | null,
): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => projectVaultOutput(item, allowed));
  }
  if (allowed === null) {
    return typeof value === "object" ? null : value;
  }
  if (typeof value !== "object") {
    throw new Error("Invalid vault response shape");
  }
  const result: Record<string, unknown> = {};
  for (const [key, children] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const field = Reflect.get(value, key);
    if (
      urlFields.has(key) &&
      (typeof field !== "string" || !isDisplaySafeVaultURL(field))
    ) {
      continue;
    }
    result[key] = projectVaultOutput(field, children);
  }
  return result;
}

export function vaultItemResponse(item: unknown) {
  return jsonResponse({
    item: projectVaultOutput(item, vaultItemFields),
    guidance: [
      "Ask the user to complete returned provider actions; never send card data or OAuth codes/tokens to MCP. Read operation descriptions and obtain explicit user approval before invoking.",
      "Use returned aliases only in a new browser created with this vault attached, respecting returned permitted domains. Ready does not mean paid.",
      "Observe get/events for outcomes. Do not retry failed, timed-out, rejected, or indeterminate payments or reconfigure a card to retry them.",
    ],
  });
}

function publicErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "Vault request failed";
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (url) =>
    isDisplaySafeVaultURL(url) ? url : "[redacted URL]",
  );
}

export function throwVaultError(
  tool: string,
  action: string,
  error: unknown,
): never {
  if (error instanceof z.ZodError) {
    throwToolError(
      tool,
      action,
      new Error("spec must match the selected provider's documented schema"),
    );
  }
  if (error instanceof APIError && typeof error.status === "number") {
    // SDK errors can stringify the entire provider body when no message is present.
    // Retain only the standard public message/code, never that fallback or headers.
    const body = error.error;
    const message = publicErrorMessage(
      body && typeof body === "object" && "message" in body
        ? body.message
        : undefined,
    );
    const code =
      body &&
      typeof body === "object" &&
      "code" in body &&
      typeof body.code === "string"
        ? body.code
        : undefined;
    throwToolError(
      tool,
      action,
      APIError.generate(
        error.status,
        { message, code },
        undefined,
        new Headers(),
      ),
    );
  }
  if (error instanceof APIConnectionTimeoutError) {
    throwToolError(tool, action, new APIConnectionTimeoutError());
  }
  if (error instanceof APIUserAbortError) {
    throwToolError(tool, action, new APIUserAbortError());
  }
  if (error instanceof APIConnectionError) {
    throwToolError(
      tool,
      action,
      new APIConnectionError({
        message:
          "Vault connection failed; inspect item state/events before taking further action. Do not replay a payment.",
      }),
    );
  }
  throwToolError(
    tool,
    action,
    new Error(
      "Vault request failed; inspect item state/events before taking further action. Do not replay a payment.",
    ),
  );
}
