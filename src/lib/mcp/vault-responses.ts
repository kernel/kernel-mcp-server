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
export const vaultProviderConfigFields = fields(
  "id name provider client_id test_mode created_at updated_at",
);
const operationFields = fields("type description");
const totalFields = fields("type display_text amount");
// Access-request IDs, provider paths, identities, and entry IDs are omitted.
const onePasswordRequestEntryFields = {
  ...fields("type reason keywords"),
  parameters: fields("website"),
};
const onePasswordRequestFields = {
  ...fields("version goal"),
  entries: onePasswordRequestEntryFields,
};
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
      "provider wallet user_id payment_method_id card_id amount currency merchant merchant_name merchant_url context expires_at description account_id",
    ),
    requests: onePasswordRequestFields,
    fields: fields("name label type required sensitive"),
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
    access_request: {
      ...fields("state has_autofill_token granted_count goal"),
      request: onePasswordRequestFields,
      entries: onePasswordRequestEntryFields,
    },
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

export const vaultOperationResultFields: OutputFields = {
  ...fields("type status error_code"),
  fields: fields("index status error_code"),
};

export const vaultEventFields: OutputFields = {
  ...fields("id name created_at browser_id"),
  data: fields(
    "reason status authorization_id preparation_id vault_session_id request_kind outcome_reason provider_status provider_code provider_request_id provider_payment_status provider_error_type provider_error_code provider_decline_code provider_error_param provider_http_status provider_response_bytes provider_latency_ms payment_intent_id payment_method_id checkout_session_id replay_attempted replay_delivered charged_amount_cents charged_currency charged_kind expected_cents actual_cents currency actual_currency intent_status amount_verified psp_error_code",
  ),
};

// Native 1Password approvals are human actions. Their links carry access-request
// references, so only the action name reaches MCP output, whatever the scheme.
const onePasswordAccessApproval = "1password_access_approval";

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

const credentialValuesSchema = z
  .object({
    type: z.literal("credential"),
    spec: z.object({
      fields: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          sensitive: z.boolean().optional(),
        }),
      ),
    }),
    state: z.object({
      fields: z.record(
        z.string(),
        z.object({ has_value: z.boolean(), value: z.string().optional() }),
      ),
    }),
  })
  .refine(
    ({ spec }) =>
      new Set(spec.fields.map((field) => field.name)).size ===
      spec.fields.length,
  );

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
  if (
    allowed === vaultItemFields &&
    z
      .object({ name: z.literal(onePasswordAccessApproval) })
      .safeParse(result.action).success
  ) {
    result.action = { name: onePasswordAccessApproval };
  }
  if (allowed === vaultItemFields && result.type === "credential") {
    const credential = credentialValuesSchema.safeParse(value);
    if (credential.success) {
      const { spec, state } = credential.data;
      result.state = {
        ...z.record(z.string(), z.unknown()).parse(result.state),
        fields: Object.fromEntries(
          Object.entries(state.fields).map(([name, field]) => [
            name,
            {
              has_value: field.has_value,
              ...(isPublicCredentialField(
                spec.fields.find((definition) => definition.name === name),
              ) &&
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
  const typed = z
    .object({
      type: z.string(),
      spec: z.object({ provider: z.string().optional() }).optional(),
    })
    .safeParse(projected);
  const onePasswordAccount =
    typed.success && typed.data.type === "credential_account";
  const onePasswordCredential =
    typed.success &&
    typed.data.type === "credential" &&
    typed.data.spec?.provider === "1password";
  const credential =
    typed.success && typed.data.type === "credential" && !onePasswordCredential;
  const onePasswordGuidance = onePasswordAccount
    ? onePasswordAccountGuidance
    : onePasswordCredential
      ? onePasswordCredentialGuidance
      : undefined;
  const advertised = advertisedOperationsSchema.safeParse(projected);
  const payment = z
    .object({
      type: z.enum(["card", "wallet"]),
      spec: z.object({ provider: z.enum(["link", "agentcard"]) }),
    })
    .safeParse(projected);
  const cardProvider =
    payment.success && payment.data.type === "card"
      ? payment.data.spec.provider
      : undefined;
  const secretValues = secretVariants(secrets);
  const safeHint = (hint: unknown) => !containsVaultSecret(hint, secretValues);
  return vaultResponse(
    {
      item: projected,
      hints: {
        observation: vaultObservationHints(target).filter(safeHint),
        invocation: advertised.success
          ? advertised.data.available_operations
              .map(({ type }) => ({
                tool: "manage_vault_items",
                arguments: { ...target, action: "invoke", operation: type },
                requires_user_approval: true,
              }))
              .filter(safeHint)
          : [],
      },
      guidance:
        onePasswordGuidance ??
        (credential
          ? [
              "Present the collection URL only to the intended user in a private surface, outside the agent-controlled browser. It is a bearer credential. Never ask for passwords or TOTP seeds in chat; TOTP seeds require trusted backend provisioning, not hosted collection.",
              "MCP returns field definitions, has_value, version, collection expiry, and explicitly non-sensitive text/email values. Sensitive values and TOTP seeds are never returned. Ready means required values exist, not that login succeeded. Listing does not renew collection links; use get or the advertised collection operation.",
              'Use manage_vault_items with action: "invoke" and the advertised collection operation to reopen the full form without clearing values or changing readiness or version. wait observes readiness, not edits to ready items. Compare versions with get without wait; a change can also come from an API update, so it does not identify a specific form submission.',
              "Create or update credentials with manage_vault_credentials. On create, inspect the website and list the named field definitions in its natural top-to-bottom order; that array order directly controls the user-facing collection form. Use optional non-secret labels for human-readable text; stable names remain authoritative for state, updates, and fill. Use a per-user vault, a recognizable site-name-only description, and sensitive:false for usernames/emails. Passwords and TOTP must be sensitive. Updates require the current version; supply expected_item_id when bound to an earlier read. Omitted values remain; null or empty strings clear supported fields, including required text/email/password fields. Hosted forms still require populated required inputs. Do not store payment-card data in credential items.",
              "Invocation hints are not approval to execute. Invoke the advertised browser field-writing operation with manage_vault_items using an inputs object containing browser_id and ordered fields of field/selector bindings, never values. Bind the vault at browser creation, authorize the destination, and follow the advertised description. Fill does not submit or navigate; real values enter the browser and may be read by an agent with browser access. Never retry an uncertain fill or fall back to aliases.",
            ]
          : [
              "Ask the user to complete returned provider actions. Never request card data or OAuth codes/tokens in chat; imported grants must come from a trusted backend. Read operation descriptions and obtain explicit user approval before invoking.",
              "Invocation hints are not approval to execute. Availability may change; invoke rechecks the advertised operations. Ready does not mean paid.",
              ...(payment.success && payment.data.type === "wallet"
                ? [
                    "Wallets connect a payment provider; they are not fillable cards. Use manage_vault_cards to configure a purchase request, then inspect that card's state and advertised operations.",
                  ]
                : []),
              ...(cardProvider === "link"
                ? [
                    "Link cards use browser field writes for checkout only when advertised. Link does not expose aliases or support egress substitution; do not use aliases from older responses, which fail closed on supported payment shapes. The browser must retain this vault attachment in the same project. The exact current HTTPS top-level page URL must have the origin of spec.merchant_url. The card must remain ready and unexpired with stored card material and a non-deleted parent wallet; lifecycle and destination checks still apply.",
                    "When the field-writing operation is advertised, pass inputs with browser_id, exact current top-level page_url (including path, query, and fragment), and ordered field/selector bindings, never values. A combined expiration field requires format MM/YY or MM/YYYY. Attach the vault at browser creation. The operation returns no card values and does not explicitly submit checkout; browser access can expose written values. Failed or unknown writes may leave partial changes. Never automatically retry or fall back to aliases. Completion means fields were written, not that the payment succeeded.",
                  ]
                : []),
              ...(cardProvider === "agentcard"
                ? [
                    "AgentCard aliases remain supported for explicitly chosen egress-substitution integrations: use only returned state.aliases in a browser created with this vault attached, respecting returned permitted domains. Checkout hold, approval, and replay remain supported; observe checkout authorization and approval URLs. Never fall back to aliases after an uncertain fill or preparation.",
                    "For checkout preparation, supply the API-required checkout context and deliver the returned approval URL and keep the approval page open. Poll the item until ready_to_submit, then submit native Pay before state.preparation.expires_at. Readiness lasts at most 30 seconds; polling does not extend it. Preparations are single-use even after failure or expiry. Preparation consumed means claimed, not payment success.",
                  ]
                : []),
              "Observe get/events for outcomes. Do not retry failed, timed-out, rejected, or indeterminate payments or reconfigure a card to retry them.",
              "recovery_required is an unresolved original outcome, not decline or expiry. Stop payment attempts; reconcile with the provider or support. No reset exists, and deletion may be blocked for this item and its parents.",
            ]),
    },
    secrets,
  );
}

const onePasswordAccountGuidance = [
  "This credential_account connects a 1Password account; it is not a fillable credential. If an action URL is present, present it only to the account owner, outside the agent-controlled browser, and let them complete 1Password consent and verify the account shown there. Never ask for 1Password passwords, Secret Keys, OAuth codes, tokens, or integration keys in chat.",
  'Observe with manage_vault_items action: "get" until state.status is connected, then create 1Password credentials with manage_vault_credentials, provider: "1password", and account_id set to this item\'s id. declined or reconnect_required need the user to connect again. Only when 1pw_recover is advertised and after explicit user approval, call manage_vault_items with action: "invoke" and operation: "1pw_recover"; never delete the account to recover.',
];

const onePasswordCredentialGuidance = [
  'Operations use manage_vault_items with action: "invoke", operation set to the advertised 1pw_* type, and inputs for that operation. 1Password credentials hold no values in Kernel. After explicit user approval, invoke operation: "1pw_request_access" with inputs {browser_id} and optional goal, reason, and keywords, using a browser created with this vault attached.',
  'Approval is a human action in the account owner\'s 1Password app. MCP withholds the native approval link and access-request references; never open, approve, or relay an approval yourself. Tell the owner a request is waiting in 1Password, then invoke operation: "1pw_poll_access" with inputs {browser_id} to observe the decision. Do not issue a second request while one is pending.',
  'When ready, invoke operation: "1pw_fill" with inputs {browser_id, page_url}, where page_url is the exact current top-level URL on the requested login origin. The extension selects fields and submits; you cannot supply selectors or values. fill_submitted does not confirm login. fill_unknown may have submitted; never retry it in the same browser. operation: "1pw_reconcile_access" only abandons an unconfirmed request after the user checks 1Password for an existing one, requires inputs {acknowledge_unconfirmed: true}, and can lead to duplicate requests.',
];

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
  operationSubmitted = false,
): never {
  const guidance = operationSubmitted
    ? "The operation may have partially completed. Inspect item state, events, and browser before acting. Do not retry automatically."
    : vaultErrorGuidance;
  if (error instanceof z.ZodError) {
    throwToolError(
      tool,
      action,
      new Error("Vault request must match the documented schema."),
    );
  }
  if (error instanceof APIError && typeof error.status === "number") {
    const body = error.error;
    const code =
      body &&
      typeof body === "object" &&
      "code" in body &&
      typeof body.code === "string"
        ? body.code
        : undefined;
    const providerReason = z
      .object({
        inner_error: z.object({
          code: z.literal("provider_rejection_reason"),
          message: z.string().min(1),
        }),
      })
      .safeParse(body);
    if (
      operationSubmitted &&
      error.status >= 400 &&
      error.status < 500 &&
      providerReason.success
    ) {
      throwToolError(
        tool,
        action,
        APIError.generate(
          error.status,
          {
            message: `${providerReason.data.inner_error.message} Inspect item state and events before acting. Do not retry automatically.`,
            ...(code !== undefined &&
              /^[a-zA-Z0-9_.-]{1,128}$/.test(code) && { code }),
          },
          undefined,
          new Headers(),
        ),
      );
    }
    const message =
      code === undefined ? undefined : vaultErrorMessages.get(code);
    throwToolError(
      tool,
      action,
      APIError.generate(
        error.status,
        {
          message: `${message ?? "Vault request failed."} ${guidance}`,
          ...(message !== undefined && { code }),
        },
        undefined,
        new Headers(),
      ),
    );
  }
  if (error instanceof APIConnectionTimeoutError) {
    throwToolError(
      tool,
      action,
      new APIConnectionTimeoutError({ message: guidance }),
    );
  }
  if (error instanceof APIUserAbortError) {
    throwToolError(tool, action, new APIUserAbortError({ message: guidance }));
  }
  if (error instanceof APIConnectionError) {
    throwToolError(tool, action, new APIConnectionError({ message: guidance }));
  }
  throwToolError(tool, action, new Error(`Vault request failed; ${guidance}`));
}
