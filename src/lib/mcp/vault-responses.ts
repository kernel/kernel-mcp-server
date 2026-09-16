import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@onkernel/sdk";
import { z } from "zod";
import { jsonResponse, throwToolError } from "@/lib/mcp/responses";
import { vaultOperationRequiresInputs } from "@/lib/mcp/vault-schemas";

type OutputFields = { [key: string]: OutputFields | null };

function fields(names: string): OutputFields {
  return Object.fromEntries(names.split(" ").map((name) => [name, null]));
}

export const vaultFields = fields("id name created_at updated_at");
export const vaultProviderConfigFields = fields(
  "id name provider client_id test_mode created_at updated_at",
);
const operationFields = fields("type description");
const totalFields = fields("type display_text amount");
const paymentMethodFields = {
  ...fields("id provider type is_default"),
  display: fields("label brand last4"),
  capabilities: { single_use_card: fields("eligible reasons") },
};

// Allow public metadata, including future operation names, but never unknown
// provider fields, free-form metadata, or opaque event data.
export const vaultItemFields: OutputFields = {
  ...fields("id key type version created_at updated_at expires_at"),
  available_operations: operationFields,
  available_expansions: operationFields,
  action: fields("name url expires_at"),
  expanded: { payment_methods: paymentMethodFields },
  spec: {
    ...fields(
      "provider wallet user_id payment_method_id card_id amount currency merchant merchant_name merchant_url context expires_at description",
    ),
    fields: { "*": fields("type required sensitive") },
    provider_config: fields("id name"),
    authorization: {
      method: null,
      client: { type: null, provider_config: fields("id name") },
    },
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
    fields: { "*": fields("has_value") },
    preparation: fields(
      "id status browser_id merchant_origin environment created_at expires_at approval_url",
    ),
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
    "reason status authorization_id preparation_id vault_session_id request_kind outcome_reason provider_status provider_code provider_request_id provider_payment_status provider_error_type provider_error_code provider_decline_code provider_error_param provider_http_status provider_response_bytes provider_latency_ms payment_intent_id payment_method_id checkout_session_id replay_attempted replay_delivered charged_amount_cents charged_currency charged_kind expected_cents actual_cents currency actual_currency intent_status amount_verified psp_error_code",
  ),
};

const urlFields = new Set([
  "url",
  "approval_url",
  "merchant_url",
  "merchant_origin",
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

export function isPublicCredentialField(
  field: { type?: string; sensitive?: boolean } | undefined,
): boolean {
  return (
    field?.sensitive === false &&
    (field.type === "text" || field.type === "email")
  );
}

const credentialValuesSchema = z.object({
  type: z.literal("credential"),
  spec: z.object({
    fields: z.record(z.object({ type: z.string(), sensitive: z.boolean() })),
  }),
  state: z.object({
    fields: z.record(
      z.object({ has_value: z.boolean(), value: z.string().optional() }),
    ),
  }),
});

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
  if (Object.prototype.hasOwnProperty.call(allowed, "*")) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        projectVaultOutput(field, allowed["*"]),
      ]),
    );
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
  if (allowed === vaultItemFields && result.type === "credential") {
    const credential = credentialValuesSchema.safeParse(value);
    if (credential.success) {
      const { spec, state } = credential.data;
      result.state = {
        ...z.record(z.unknown()).parse(result.state),
        fields: Object.fromEntries(
          Object.entries(state.fields).map(([name, field]) => [
            name,
            {
              has_value: field.has_value,
              ...(isPublicCredentialField(spec.fields[name]) &&
                field.has_value &&
                field.value !== undefined && { value: field.value }),
            },
          ]),
        ),
      };
    }
  }
  return result;
}

function secretVariants(secrets: (string | undefined)[]) {
  return secrets
    .filter((secret): secret is string => !!secret)
    .flatMap((secret) => [secret, encodeURIComponent(secret)]);
}

function containsVaultSecret(value: unknown, secrets: string[]): boolean {
  if (typeof value === "string")
    return secrets.some((secret) => value.includes(secret));
  if (value && typeof value === "object") {
    return Object.values(value).some((field) =>
      containsVaultSecret(field, secrets),
    );
  }
  return false;
}

function redactVaultSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    return text;
  }
  if (Array.isArray(value))
    return value.map((field) => redactVaultSecrets(field, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        redactVaultSecrets(field, secrets),
      ]),
    );
  }
  return value;
}

export function vaultResponse(
  value: unknown,
  secrets: (string | undefined)[] = [],
) {
  return jsonResponse(redactVaultSecrets(value, secretVariants(secrets)));
}

type VaultItemTarget = {
  project?: string;
  vault: string;
  key: string;
};

const advertisedOperationsSchema = z.object({
  available_operations: z.array(
    z.object({
      type: z
        .string()
        .min(1)
        .refine((value) => value.trim().length > 0),
    }),
  ),
});

export function vaultObservationHints(target: VaultItemTarget, after?: string) {
  return [
    {
      tool: "manage_vault_items",
      arguments: { ...target, action: "get", wait: 0 },
    },
    {
      tool: "manage_vault_items",
      arguments: {
        ...target,
        action: "events",
        wait: 0,
        ...(after !== undefined && { after }),
      },
    },
  ];
}

export function vaultItemResponse(
  item: unknown,
  target: VaultItemTarget,
  secrets: (string | undefined)[] = [],
) {
  const projected = projectVaultOutput(item, vaultItemFields);
  const credential =
    projected !== null &&
    typeof projected === "object" &&
    "type" in projected &&
    projected.type === "credential";
  const advertised = advertisedOperationsSchema.safeParse(projected);
  const secretValues = secretVariants(secrets);
  const safeHint = (hint: unknown) => !containsVaultSecret(hint, secretValues);
  return vaultResponse(
    {
      item: projected,
      hints: {
        observation: vaultObservationHints(target).filter(safeHint),
        invocation: advertised.success
          ? advertised.data.available_operations
              .filter(({ type }) => !vaultOperationRequiresInputs(type))
              .map(({ type }) => ({
                tool: "manage_vault_items",
                arguments: { ...target, action: "invoke", operation: type },
                requires_user_approval: true,
              }))
              .filter(safeHint)
          : [],
      },
      guidance: credential
        ? [
            "Present the collection URL only to the intended user in a private surface, outside the agent-controlled browser. It is a bearer credential. Never ask for passwords or TOTP seeds in chat; TOTP seeds require trusted backend provisioning, not hosted collection.",
            "MCP returns field definitions, has_value, version, collection expiry, and explicitly non-sensitive text/email values. Sensitive values and TOTP seeds are never returned. Ready means required values exist, not that login succeeded. Listing does not renew collection links; use get or the advertised collect operation.",
            "collect reopens the full form without clearing values or changing readiness or version. wait observes readiness, not edits to ready items. Compare versions with get without wait; a change can also come from an API update, so it does not identify a specific form submission.",
            "Create or update credentials with manage_vault_credentials. Use a per-user vault, a recognizable site-name-only description, and sensitive:false for usernames/emails. Passwords and TOTP must be sensitive. Updates require the current version; supply expected_item_id when bound to an earlier read. Omitted values remain; null or empty strings clear supported fields, including required text/email/password fields. Hosted forms still require populated required inputs. Do not store payment-card data in credential items.",
            "Invocation hints are not approval to execute. Invoke fill with manage_vault_items using a fill object containing browser_id and ordered fields of field/selector bindings, never values. Bind the vault at browser creation, authorize the destination, and follow the advertised description. Fill does not submit or navigate; real values enter the browser and may be read by an agent with browser access. Never retry an uncertain fill or fall back to aliases.",
          ]
        : [
            "Ask the user to complete returned provider actions. Never request card data or OAuth codes/tokens in chat; imported grants must come from a trusted backend. Read operation descriptions and obtain explicit user approval before invoking.",
            "Fill is the preferred browser-checkout path when advertised: use manage_vault_items invoke with operation fill and a fill object containing browser_id, exact HTTPS page_url, and ordered field/selector bindings. Aliases are an alternative only for explicitly chosen egress-substitution integrations in a browser created with this vault attached, respecting returned permitted domains. Never fall back to aliases after an uncertain fill. Ready does not mean paid.",
            "Observe get/events for outcomes. Do not retry failed, timed-out, rejected, or indeterminate payments or reconfigure a card to retry them.",
            "Invocation hints are not approval to execute. Availability may change; invoke rechecks the advertised operations. Fill requires caller-chosen bindings in the fill object, so no ready-to-run invocation hint is emitted. prepare_checkout still requires the Kernel API.",
            "For API-only prepare_checkout, deliver the returned approval URL and keep the approval page open. Poll the item until ready_to_submit, then submit native Pay before state.preparation.expires_at. Readiness lasts at most 30 seconds; polling does not extend it. Preparations are single-use even after failure or expiry. Preparation consumed means claimed, not payment success.",
            "recovery_required is an unresolved original outcome, not decline or expiry. Stop payment attempts; reconcile with the provider or support. No reset exists, and deletion may be blocked for this item and its parents.",
          ],
    },
    secrets,
  );
}

const vaultErrorMessages = new Map([
  [
    "invalid_request",
    "Invalid vault request. Check the tool's documented inputs.",
  ],
  [
    "not_found",
    "Vault, item, provider configuration, or project not found or unavailable.",
  ],
  [
    "forbidden",
    "This credential cannot perform the vault operation. Check connection scope and permissions.",
  ],
  [
    "conflict",
    "The vault request conflicts with the current configuration or state. Inspect the item and its advertised operations and expansions.",
  ],
  [
    "project_error",
    "Unable to resolve the vault's project. Check connection scope and project selection.",
  ],
  ["db_error", "The vault storage request could not be completed."],
  [
    "provider_error",
    "The payment provider could not complete the vault request.",
  ],
  [
    "provider_rate_limited",
    "The payment provider has rate limited requests. Stop and wait before taking further action.",
  ],
  [
    "spend_request_rate_limited",
    "The payment provider has rate limited spend requests. Stop and wait before taking further action.",
  ],
]);
const vaultErrorGuidance =
  "Inspect item state/events before taking further action. Do not replay a payment.";

export function throwVaultError(
  tool: string,
  action: string,
  error: unknown,
): never {
  if (error instanceof z.ZodError) {
    throwToolError(
      tool,
      action,
      new Error("spec must match the selected action's documented schema"),
    );
  }
  if (error instanceof APIError && typeof error.status === "number") {
    // Neither provider messages nor unknown codes are safe to return, even as strings.
    const body = error.error;
    const code =
      body &&
      typeof body === "object" &&
      "code" in body &&
      typeof body.code === "string"
        ? body.code
        : undefined;
    const message =
      code === undefined ? undefined : vaultErrorMessages.get(code);
    throwToolError(
      tool,
      action,
      APIError.generate(
        error.status,
        {
          message: `${message ?? "Vault request failed."} ${vaultErrorGuidance}`,
          ...(message !== undefined && { code }),
        },
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
