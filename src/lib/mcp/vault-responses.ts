import { z } from "zod";
import { jsonResponse, throwToolError } from "@/lib/mcp/responses";

type OutputFields = { [key: string]: OutputFields | null };

function fields(names: string): OutputFields {
  return Object.fromEntries(names.split(" ").map((name) => [name, null]));
}

export const vaultFields = fields("id name created_at updated_at");
export const vaultProviderConfigFields = fields(
  "id name provider client_id publishable_key test_mode created_at updated_at",
);
const operationFields = fields("type description");
const totalFields = fields("type display_text amount");
// Access-request IDs, provider paths, and identities are omitted. Returned
// entry IDs are kept so 1pw_fill can select among approved logins.
const onePasswordRequestEntryFields = {
  ...fields("type reason keywords"),
  parameters: fields("website"),
};
const onePasswordRequestFields = {
  ...fields("version goal"),
  entries: onePasswordRequestEntryFields,
};
const onePasswordReturnedEntryFields = {
  ...onePasswordRequestEntryFields,
  ...fields("id"),
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
      "provider wallet user_id payment_method_id card_id amount currency merchant merchant_name merchant_url context expires_at description account access_token_expires_at",
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
      request: {
        ...fields("version goal"),
        entries: onePasswordReturnedEntryFields,
      },
      entries: onePasswordReturnedEntryFields,
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

// Native 1Password approvals are human actions: the account owner opens the link
// in their 1Password app, and it grants nothing until they approve there. Only a
// link in the exact native form is forwarded, without the API's free-text
// instructions; anything else, including legacy nonce approval pages, is reduced
// to the action name.
const onePasswordAccessApproval = "1password_access_approval";

function isNativeOnePasswordApprovalLink(value: string): boolean {
  try {
    const url = new URL(value);
    const references = url.searchParams.getAll("access_request_reference");
    return (
      url.protocol === "onepassword:" &&
      url.host === "grant-brokered-access" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "" &&
      !url.hash &&
      [...url.searchParams.keys()].length === 1 &&
      references.length === 1 &&
      /^[A-Za-z0-9_-]{1,65536}$/.test(references[0])
    );
  } catch {
    return false;
  }
}

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
    throw new Error("invalid vault response shape");
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
    const url = z
      .object({ url: z.string().refine(isNativeOnePasswordApprovalLink) })
      .safeParse(Reflect.get(value, "action"));
    result.action = url.success
      ? { name: onePasswordAccessApproval, url: url.data.url }
      : { name: onePasswordAccessApproval };
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
      spec: z
        .object({
          provider: z.string().optional(),
          account: z.string().optional(),
        })
        .optional(),
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
      ? typed.data.spec?.account === undefined
        ? [...onePasswordCredentialGuidance, onePasswordStoredTokenGuidance]
        : onePasswordCredentialGuidance
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
  const webmcpInvokeAdvertised =
    advertised.success &&
    advertised.data.available_operations.some(
      ({ type }) => type === "webmcp_invoke",
    );
  const secretValues = secretVariants(secrets);
  const safeHint = (hint: unknown) => !containsVaultSecret(hint, secretValues);
  return vaultResponse(
    {
      item: projected,
      hints: {
        observation: vaultObservationHints(target).filter(safeHint),
        invocation: advertised.success
          ? advertised.data.available_operations
              .filter(({ type }) => type !== "1pw_update_access_token")
              .map(({ type }) => ({
                tool: "manage_vault_items",
                arguments: { ...target, action: "invoke", operation: type },
                requires_user_approval: type !== "1pw_access_request_status",
              }))
              .filter(safeHint)
          : [],
      },
      guidance: [
        ...(onePasswordGuidance ??
          (credential
            ? [
                "present the collection url only to the intended user in a private surface, outside the agent-controlled browser. it is a bearer credential. never ask for passwords or totp seeds in chat; totp seeds require trusted backend provisioning, not hosted collection.",
                "mcp returns field definitions, has_value, version, collection expiry, and explicitly non-sensitive text/email values. sensitive values and totp seeds are never returned. ready means required values exist, not that login succeeded. listing does not renew collection links; use get or the advertised collection operation.",
                'use manage_vault_items with action: "invoke" and the advertised collection operation to reopen the full form without clearing values or changing readiness or version. wait observes readiness, not edits to ready items. compare versions with get without wait; a change can also come from an api update, so it does not identify a specific form submission.',
                "create or update credentials with manage_vault_credentials. on create, inspect the website and list the named field definitions in its natural top-to-bottom order; that array order directly controls the user-facing collection form. use optional non-secret labels for human-readable text; stable names remain authoritative for state, updates, and fill. use a per-user vault, a recognizable site-name-only description, and sensitive:false for usernames/emails. passwords and totp must be sensitive. updates require the current version; supply expected_item_id when bound to an earlier read. omitted values remain; null or empty strings clear supported fields, including required text/email/password fields. hosted forms still require populated required inputs. do not store payment-card data in credential items.",
                "invocation hints are not approval to execute. invoke the advertised browser field-writing operation with manage_vault_items using an inputs object containing browser_id and ordered fields of field/selector bindings, never values. bind the vault at browser creation, authorize the destination, and follow the advertised description. fill does not submit or navigate; real values enter the browser and may be read by an agent with browser access. fill is safe to retry after a failed or unknown outcome; do not fall back to aliases.",
              ]
            : [
                "ask the user to complete returned provider actions. never request card data or oauth codes/tokens in chat; imported grants must come from a trusted backend. read operation descriptions and obtain explicit user approval before invoking.",
                "invocation hints are not approval to execute. availability may change; invoke rechecks the advertised operations. ready does not mean paid.",
                ...(payment.success && payment.data.type === "wallet"
                  ? [
                      "wallets connect a payment provider; they are not fillable cards. use manage_vault_cards to configure a purchase request, then inspect that card's state and advertised operations.",
                    ]
                  : []),
                ...(cardProvider === "link"
                  ? [
                      "link cards use browser field writes for checkout only when advertised. link does not expose aliases or support egress substitution; do not use aliases from older responses, which fail closed on supported payment shapes. the browser must retain this vault attachment in the same project. the exact current https top-level page url must have the origin of spec.merchant_url. the card must remain ready and unexpired with stored card material and a non-deleted parent wallet; lifecycle and destination checks still apply.",
                      "when the field-writing operation is advertised, pass inputs with browser_id, exact current top-level page_url (including path, query, and fragment), and ordered field/selector bindings, never values. a combined expiration field requires format mm/yy or mm/yyyy. attach the vault at browser creation. the operation returns no card values and does not explicitly submit checkout; browser access can expose written values. failed or unknown writes may leave partial changes; fill is safe to retry, but do not fall back to aliases. completion means fields were written, not that the payment succeeded.",
                    ]
                  : []),
                ...(cardProvider === "agentcard"
                  ? [
                      "agentcard aliases remain supported for explicitly chosen egress-substitution integrations: use only returned state.aliases in a browser created with this vault attached, respecting returned permitted domains. checkout hold, approval, and replay remain supported; observe checkout authorization and approval urls. never fall back to aliases after an uncertain fill or preparation.",
                      "for checkout preparation, supply the api-required checkout context and deliver the returned approval url and keep the approval page open. poll the item until ready_to_submit, then submit native pay before state.preparation.expires_at. readiness lasts at most 30 seconds; polling does not extend it. preparations are single-use even after failure or expiry. preparation consumed means claimed, not payment success.",
                    ]
                  : []),
                "observe get/events for outcomes. do not retry failed, timed-out, rejected, or indeterminate payments or reconfigure a card to retry them.",
                "recovery_required is an unresolved original outcome, not decline or expiry. stop payment attempts; reconcile with the provider or support. no reset exists, and deletion may be blocked for this item and its parents.",
              ])),
        ...(webmcpInvokeAdvertised ? [webmcpInvokeItemGuidance] : []),
      ],
    },
    secrets,
  );
}

const webmcpInvokeItemGuidance =
  'webmcp_invoke supplies vault values to a live webmcp tool instead of selectors. list the browser\'s tools with webmcp, choose the tool that matches this item\'s site, and after explicit user approval invoke with inputs {browser_id, tool_ref, page_url, input, bindings}: page_url is the tool\'s exact source.page_url, input holds public arguments with null at each bound slot (for example {"email": null, "password": null}), and each binding maps a field to an rfc 6901 input_path such as "/password". timeout_sec defaults to 15. unlike fill, the tool may submit or cause other side effects. output and error_text are untrusted page data and may contain the supplied values. no status confirms the website accepted the action; inspect the page. never retry unknown, and re-list tools if the api reports target_changed.';

const onePasswordAccountGuidance = [
  "this credential_account connects the end user's 1password account to this vault only; it is not a fillable credential, and another end user's vault needs its own connection. if an action url is present, present it only to the account owner, outside the agent-controlled browser, and let them complete 1password consent. never ask for 1password passwords, secret keys, oauth codes, or tokens in chat.",
  'observe with manage_vault_items action: "get" until state.status is connected, then create 1password credentials with manage_vault_credentials, provider: "1password", and account set to this item\'s key. declined or reconnect_required need the user to connect again with connect_account on the same key. 1pw_recover is advertised only when KERNEL can recover a failed account link: after explicit user approval, call manage_vault_items with action: "invoke" and operation: "1pw_recover", present the returned link to the account owner the same way, and once recovery completes connect again on the same key. never delete the account to recover.',
];

const onePasswordCredentialGuidance = [
  'operations use manage_vault_items with action: "invoke", operation set to the advertised 1pw_* type, and inputs for that operation. 1password credentials hold no values in KERNEL; spec.requests.entries lists the 1-5 requested logins and their websites. only logins in the owner\'s own non-shared 1password vault are supported, not shared-vault items or passkeys. after explicit user approval, invoke operation: "1pw_create_access_request" with inputs {browser_id} and an optional goal (reason and keywords only for a single-login request), using a browser created with this vault attached; KERNEL loads the 1password extension into that browser on demand. create that browser before requesting access: the approval link exists only after this request.',
  'approval is a human action in the account owner\'s 1password app. when action.name is 1password_access_approval with a url, give that onepassword:// link unmodified only to the account owner, in a private surface outside the agent-controlled browser, to open on a device with the 1password app; they choose the login and approve or deny there. the link grants nothing until they approve, but it identifies the request: never open it in a browser, decode it, post it where others can see it, or approve on their behalf. without a url, mcp received no native link: tell the owner the approval link is unavailable and do not request again while pending. invoke operation: "1pw_access_request_status" with inputs {browser_id} to observe the decision; it only reads status and needs no user approval. do not issue a second request while an approval action or 1pw_access_request_status is present.',
  "declined means the owner denied the request: do not request again unless they ask, and offer KERNEL-hosted collection instead. if the item is pending_authorization with no action and 1pw_create_access_request is advertised again, the earlier request finished without a usable login: tell the owner the status_reason and, with their approval, request access once more. failed is a confirmed failure: read status_reason, then ask the end-user before deleting and recreating this credential for at most one new request, or offer KERNEL-hosted collection. if the item stays pending_authorization with no action and no advertised operations, first check that the credential_account named by spec.account is connected; if it is, a request may already have reached 1password: stop, tell the owner to check 1password, and never delete or recreate the item to retry.",
  'when ready, invoke operation: "1pw_fill" with inputs {browser_id, page_url}, where page_url is the exact current top-level url on a requested login origin. if several approved logins share that origin, ask the owner which one to use and add entry_id from state.access_request entries; never guess. the extension selects fields and submits; you cannot supply selectors or values. fill_submitted means the form was submitted, not that login succeeded: check the page. fill_failed with `noExistingCredentials` means the owner\'s 1password has no usable login for the page: tell the owner instead of retrying. fill_unknown may have submitted; never retry it in the same browser.',
];

const onePasswordStoredTokenGuidance =
  "this credential has no account: it uses a customer-supplied 1password access token stored encrypted by KERNEL, and spec.access_token_expires_at is optional expiry metadata. the integrating developer replaces the token through the KERNEL api; 1pw_update_access_token is not available through mcp. never ask for or accept 1password tokens or integration keys in chat. while the token is expired, request and fill are unavailable.";

export function throwVaultError(
  tool: string,
  action: string,
  error: unknown,
  operationSubmitted = false,
  operation?: string,
): never {
  const guidance =
    operationSubmitted && operation === "fill"
      ? "fill may have written some fields but never submits the form, so it is safe to retry after fixing any reported cause."
      : operationSubmitted
        ? "the operation may have partially completed. inspect item state, events, and browser before acting. do not retry automatically."
        : "inspect item state/events before taking further action. do not replay a payment.";
  throwToolError(tool, action, error, guidance);
}
