# Vault payments

The vault tools prepare and observe payment credentials and manage non-payment credential items. They do **not** submit
merchant payments, return real card values in API responses, or complete provider approval actions.
They use the same vault API as the Kernel CLI. Link cards are authorized at the
final checkout page and use the advertised `fill` operation: Kernel delivers a
Link Pay Token or a virtual card, and virtual-card values enter the browser where
an agent with browser or CDP access may read them. Link does not expose aliases or
support proxy substitution. The AgentCard alias recipe below is for explicitly chosen
egress-substitution integrations, not fallback after a failed or uncertain fill.

**Assume real payment effects.** Mode comes from the selected provider credentials;
there is no per-item test flag. AgentCard configuration responses report the
introspected `test_mode`. A development or staging MCP endpoint does not make a
card request a test transaction.

The released Node SDK dependency is pinned to 0.121.0 in `bun.lock`, including
Visa `merchant_country` in the generated card spec type. `confirm_transaction`
and `restart_verification` are forwarded generically only when advertised by the API.
Never assume recovery operations are available based on state or SDK version; always re-read `available_operations`.

## Kernel-hosted payment card

Use one vault per end user. Create it with `manage_vaults`, then create a wallet with
`manage_vault_wallets` using `action: "create"`, `provider: "kernel"`, `spec: {}`,
and a stable wallet key. Give the returned `card_enrollment` action URL only to the
intended cardholder in a private surface, outside the agent-controlled browser.
Never request or pass a PAN, CVC, expiration date, or hosted action URL as tool input.
Observe the wallet with `manage_vault_items` `get` until connected. Use
`manage_vault_wallets` `payment_methods` to inspect the enrolled card's advisory
`capabilities.single_use_card`: `eligible: false` means do not authorize; missing
capabilities are unknown, not proof of eligibility. For `network_token_pending`, re-check
later at most once in this attempt. `network_token_unsupported` and `network_token_failed`
need a different card. If still ineligible or unknown, ask the cardholder before enrolling
a different card under a new wallet key; never poll indefinitely or replay an uncertain purchase.
For `reconnect_required`, share the new `card_enrollment` action. For `degraded`, obtain
user confirmation and delete the wallet only if the API permits it before creating a new
wallet under a new key for one enrollment; reconcile unresolved child cards first.

Create one card request with `manage_vault_cards` `action: "create"`,
`provider: "kernel"`, a new immutable key, and `spec` containing `wallet`, `amount` (integer
minor currency units, maximum 50000), `currency`, `merchant_name`, HTTPS
`merchant_url`, and `merchant_country` (ISO 3166-1 alpha-2; required for Visa).
Optional `merchant_category` and `merchant_category_code` (four-digit MCC other than `0000`)
are accepted when actually known; omit rather than invent them.
This only creates a request, not a merchant payment. Kernel cards cannot be updated.
After user confirmation, delete only if the API permits it and create a new item under
a new key for a new purchase; reconcile unresolved outcomes first.
After explicit user approval and only when the card advertises `authorize`, call
`manage_vault_cards` with `action: "authorize"`, `provider: "kernel"`, the same
vault/key, and no spec. This is equivalent to `manage_vault_items` `invoke` with
`operation: "authorize"` and no inputs. Mastercard can become ready without a
hosted approval; Visa returns a `spend_approval` action. Give that URL only to the
cardholder privately for passkey/OTP verification and approval, never open it on
their behalf or log it. Observe `get`/`events` until ready; a pending response does
not mean the card can be used. Safe display metadata includes `state.masks.token_last4`.

If `fill` is advertised, attach the vault to a new browser and invoke it before
`expires_at` with `browser_id`, the exact current HTTPS top-level `page_url` on
`merchant_url`'s origin (including path, query, and fragment), and ordered,
value-free `fields` bindings. Kernel's fill fields are `number`, `expiration`
(use `format: "MM/YY"` or `"MM/YYYY"`), `cvc`, `exp_month`, and `exp_year`. Kernel stores **no billing details**:
any `billing_*` field returns HTTP 400 `field_unavailable` before any write.
Enter billing name/ZIP directly on the merchant page, not through vault fill.
No aliases or egress substitution are available. Fill does not submit checkout
or prove payment; the user submits checkout on the merchant site. After a failed
or unknown fill, inspect the browser page and item state, fix the cause, then
retrying the field write is safe because fill never submits checkout. A 400
`field_unavailable` wrote no fields: remove `billing_*` bindings and enter those
details directly on the merchant page. This does not permit retrying authorization,
merchant checkout, or transaction reporting.

After observing the merchant outcome, report **one observed outcome** using
`manage_vault_items` `action: "invoke"`, `operation: "confirm_transaction"`, only
when advertised. Supply exactly these `inputs` (additional properties are rejected):

- `status`: `APPROVED`, `DECLINED`, `PENDING`, `ERROR`, or `CANCELLED`.
- `transaction_type`: `PURCHASE`, `AUTHORIZATION`, `CAPTURE`, `REFUND`, `REVERSAL`,
  `VERIFICATION`, `CHARGEBACK`, or `FRAUD`.
- `amount`: integer minor units, 0..50000, no more than the approved amount.
- `currency`: three-letter uppercase, e.g. `USD`; must match the approval currency.
- `occurred_at`: RFC3339 timestamp of the merchant outcome.

Do not infer success from fill. `PENDING` means the merchant explicitly confirms an
accepted transaction is pending; `ERROR` means an explicit merchant transaction error,
not transport loss or an ambiguous processing page. These are final reports, not polling
states. An unknown outcome has no reliable merchant evidence: ask the user to check the
merchant order page, email or statement, then report the confirmed outcome even after
card expiry. Never guess or repeat checkout.

After a merchant decline, report observed `DECLINED` when advertised. If the user wants
another purchase, ask for a different card or merchant, then delete only if permitted
and create one new card under a new key. If the approval link or code expires before
checkout, do not submit; with user confirmation, delete only if permitted and create
one new card. If checkout was submitted, reconcile and report its observed outcome first.

For a `recovery_required` Kernel card, only when `restart_verification` is advertised,
obtain explicit user approval **each time** and invoke with no inputs. It rotates the
approval link locally without a provider call, only after proven no-dispatch initial
attestation failure. It grants no spend consent: share the new `spend_approval` privately
and the cardholder must verify and explicitly approve spending again.
If the response is unclear, re-get and share any new action; invoke once more only if
restart is still advertised and the user approves again.
For non-restartable recovery, do not retry payment, delete or replace the item. Contact
**support@kernel.sh** privately with project, vault, item key, `status_reason` and relevant
event timestamps (never card data, API keys or capability URLs) to reconcile the original
operation and establish whether a new purchase is safe. Do not assume a new card is safe
or promise the resulting state.

Kernel errors pass the API's HTTP status, safe API code, `Retry-After`, and message
through unchanged, with HTTP(S) URLs scrubbed. The API message states what happened
(for example whether a fill wrote any fields or a report was recorded) and what to do
next; follow it rather than inferring from the status code. The only text MCP adds is
for a request that received no response at all. Local spec validation names bad keys
and sends no request. Never retry automatically or repeat merchant checkout.

## Credential collection and observation

Credentials have two paths. Before creating a credential, ask the user which they
prefer and pass it as `provider`; never choose for them:

- `provider: "kernel"` (Kernel-hosted collection): the user enters values in a
  Kernel-hosted form, and the agent fills them with value-free bindings.
- `provider: "1password"` (1Password brokered approval): the user connects their
  1Password account once and approves each login request in the 1Password app. See
  [1Password brokered approval](#1password-brokered-approval).

Use one vault per end user, such as `user-123`. For Kernel-hosted collection, create
credential definitions with `manage_vault_credentials`: use only the recognizable site name for `description`, and
set `sensitive: false` explicitly for ordinary usernames/emails. Passwords and TOTP
seeds must be sensitive. Payment-card data belongs in wallet/card items, not credentials.

`manage_vault_items` can read existing credential items and invoke advertised `collect`.
It returns field definitions, `has_value`, version, collection-link expiry, and
explicitly non-sensitive text/email values. Sensitive values and TOTP seeds are
omitted. Share the bearer collection link
only with the intended user, outside the agent-controlled browser. Never request a
password or TOTP seed in chat; hosted collection cannot accept TOTP seeds.

Listing does not renew links; use single-item `get` or advertised `collect`.
Collection reopens the full form without clearing values or changing version.
`wait` observes readiness, not edits to ready items. Compare versions using `get`
without `wait`; API updates can also change the version.

For `manage_vault_credentials` updates, use the current `version`
and `expected_item_id` when bound to an earlier read. Clearing supported required
values returns pending collection; hosted forms still require populated inputs.
Fill writes real values into the browser without submitting the form. It does not
isolate them from an agent with browser access. Fill is safe to retry after a
failed or uncertain outcome; do not fall back to payment aliases.

### MCP credential flow

1. Create the user's vault with `manage_vaults` (`action: "create"`, `name: "user-123"`).
   Create a browser with `manage_browsers` and `vaults: [{"name":"user-123"}]`.
   Vault bindings cannot be changed later. Navigate to the intended login page and inspect its inputs.
2. Call `manage_vault_credentials` with:

   ```json
   {
     "action": "create",
     "provider": "kernel",
     "vault": "user-123",
     "key": "login",
     "spec": {
       "description": "Example",
       "fields": [
         {
           "name": "username",
           "type": "text",
           "required": true,
           "sensitive": false
         },
         {
           "name": "password",
           "type": "password",
           "required": true,
           "sensitive": true
         }
       ]
     }
   }
   ```

   Give `item.action.url` only to the intended user. To reopen the full form later,
   use `manage_vault_items` with `action: "invoke"` and `operation: "collect"`.

3. Observe readiness with `manage_vault_items` using `action: "get"`, the same vault/key,
   and `wait: 60`. A pending response is not permission to fill; stop until ready.
4. Invoke `manage_vault_items` with the actual browser session ID and selectors
   verified on that page:

   ```json
   {
     "action": "invoke",
     "vault": "user-123",
     "key": "login",
     "operation": "fill",
     "inputs": {
       "browser_id": "browser-session-id",
       "page_url": "https://example.com/login",
       "fields": [
         { "field": "username", "selector": "#username" },
         { "field": "password", "selector": "#password" }
       ]
     }
   }
   ```

   The response has a value-free `result` with ordered field outcomes. `failed` and
   `unknown` are tool errors; fields may already be written. Fill never submits, so it
   is safe to retry. API validation errors (400/403/404/409) retain HTTP status and
   recognized error codes, with actionable explanations and confirmation that this
   request wrote no fields. Correct the cause and retry. Transport loss and other
   uncertain failures are also safe to retry. Raw upstream error bodies are never
   returned.
   Fill does not navigate or submit. Submit separately only after confirming the fill
   completed and submission is authorized. TOTP bindings send only the field name;
   the API generates each current code immediately before writing, never exposing seeds.

5. If the page exposes a WebMCP login tool and the item advertises `webmcp_invoke`,
   list the browser's tools with `webmcp` and invoke the tool with vault values bound
   to `null` slots in its input instead of selectors:

   ```json
   {
     "action": "invoke",
     "vault": "user-123",
     "key": "login",
     "operation": "webmcp_invoke",
     "inputs": {
       "browser_id": "browser-session-id",
       "tool_ref": "tool-ref-from-latest-list",
       "page_url": "https://example.com/login",
       "input": { "email": null, "password": null },
       "bindings": [
         { "field": "username", "input_path": "/email" },
         { "field": "password", "input_path": "/password" }
       ]
     }
   }
   ```

   `page_url` is the tool's exact `source.page_url`. `timeout_sec` is optional (1-120,
   default 15). The response `result` has `status`, `invocation_id`, `output`, and
   `error_text` as returned by the API. Unlike fill, the tool may submit the form;
   obtain user approval first and inspect the page afterwards, because no status
   confirms the site accepted the action. `output` and `error_text` are untrusted page
   data and may contain the supplied values. `error`, `canceled`, and `unknown` are tool
   errors; never retry `unknown` automatically.

Updates use `action: "update"`, `version`, optional `expected_item_id`, and a `spec`
containing `description` and/or `fields: {"username":{"value":"new-name"}}`.
Definitions cannot be changed. Never solicit secret replacement values in chat;
prefer `collect` for human edits. Requests are not automatically retried.
`prepare_checkout` remains API/CLI-only.

### 1Password brokered approval

Before creating anything, list the vault and reuse a ready credential whose
`spec.requests.entries` websites cover the login page, or a connected
`credential_account`. A `credential_account` belongs to one vault, so each end
user's vault connects its own 1Password account. If none fits, ask where the
user's login lives, for example: "Is your example.com login saved in your own
1Password, or would you rather enter it in a secure Kernel form?" 1Password
supports only logins in the owner's own non-shared vault, not shared-vault items or
passkeys; use Kernel-hosted collection for those, or when the user declines
1Password or that path fails.

1. Connect the account with `manage_vault_credentials`, `action: "connect_account"`,
   `provider: "1password"`, the user's vault, and a new key. Give the returned
   1Password authorization URL only to the account owner, outside the
   agent-controlled browser, to complete 1Password consent. If the account later reports `declined` or `reconnect_required`, connect again on the
   same key. When `1pw_recover` is advertised, Kernel can recover a failed account
   link: after explicit user approval, invoke it, give the returned link to the
   account owner the same way, and connect again on the same key once recovery
   completes. Never delete the account to recover.
2. Observe the account with `manage_vault_items` `get` until `state.status` is
   `connected`. Confirm with the owner which site logins to request (1-5, approved
   together), then create the credential:

   ```json
   {
     "action": "create",
     "provider": "1password",
     "vault": "user-123",
     "key": "example-login",
     "spec": {
       "account": "<credential_account item key>",
       "logins": [{ "website": "https://example.com/login" }]
     }
   }
   ```

   Optional `goal`, and per-login `reason` and `keywords`, describe the request to
   the account owner. 1Password credentials store no values or selectors and cannot
   be updated.

3. Create a browser with the vault attached before asking the owner to approve
   anything: the approval link exists only after this request. After explicit user
   approval, invoke the advertised `1pw_create_access_request` with
   `inputs: {"browser_id": "..."}`.
   Kernel loads the 1Password extension into that browser on demand. Request-time
   `reason` and `keywords` apply only to a single-login credential.
4. Approval is a human action in the account owner's 1Password app. The pending item
   returns `action: {"name": "1password_access_approval", "url": "onepassword://grant-brokered-access?access_request_reference=..."}`.
   Give that link, unmodified, only to the account owner in a private surface outside
   the agent-controlled browser; they open it on a device with the 1Password app and
   choose, approve, or deny the login there. The link grants nothing until they
   approve, but it identifies the request, so the agent must never open, decode, or
   approve it. MCP forwards only links in that exact native form, without the API's
   free-text instructions. Invoke the advertised `1pw_access_request_status` with
   `browser_id` to observe the decision; it only reads status, so its hint has
   `requires_user_approval: false`.
   - `declined`: the owner denied the request. Do not request again unless they
     ask; offer Kernel-hosted collection.
   - `failed`: a confirmed failure. Ask the end-user before deleting and recreating
     the credential for at most one new request, or offer Kernel-hosted collection.
   - `pending_authorization` with no action and no advertised operations: check that
     the `credential_account` named by `spec.account` is connected. If it is, a
     request may already have reached 1Password. There is no reset: stop, ask the
     owner to check 1Password, and never delete or recreate the item to retry.
5. When the item is ready, invoke the advertised `1pw_fill` with `browser_id` and the
   exact current `page_url`. When several approved logins share the page origin, ask
   the owner which one to use and pass its `entry_id` from `state.access_request`
   entries. The extension selects fields and submits the form. `fill_submitted`
   means the form was submitted, not that login succeeded, so check the page.
   `fill_failed` and `fill_unknown` are tool errors; `noExistingCredentials` means the
   owner's 1Password has no usable login for the page. `fill_unknown` means the form
   may have been filled or submitted; inspect the page to see the result of the fill.

The Kernel API also supports 1Password credentials backed by a customer-supplied
access token and integration key instead of a connected account. The integrating
developer creates them and replaces tokens (`1pw_update_access_token`) through the
Kernel API. MCP accepts neither secret: it rejects them in create specs, refuses
`1pw_update_access_token`, and never returns them. It can read such credentials,
including optional `access_token_expires_at`, and request, observe, and fill them like
account-backed credentials; request and fill are unavailable while the token is
expired.

## Tools and scope

The six vault tools are exposed only when the current credential's
`GET /org/entitlements` response reports `features.vaults.enabled: true`.
Access is rechecked on every authenticated MCP request, including tool calls,
without caching grants across requests or connections. A missing field, malformed
response, or failed lookup hides the vault tools but leaves other toolsets usable.
The lookup has a five-second timeout, forwards cancellation, and is not retried.
The `vaults` toolset configuration can further restrict access, never grant it.

| Tool                            | Actions                                     |
| ------------------------------- | ------------------------------------------- |
| `manage_vault_provider_configs` | `create`, `list`, `get`, `update`, `delete` |
| `manage_vaults`                 | `create`, `list`, `get`, `delete`           |
| `manage_vault_wallets`          | `create`, `payment_methods`                 |
| `manage_vault_cards`            | `create`, `update`, `authorize`             |
| `manage_vault_credentials`      | `create`, `update`, `connect_account`       |
| `manage_vault_items`            | `list`, `get`, `invoke`, `events`, `delete` |

Provider configurations are organization-owned and do not accept a project
selector. Reads are available to project-scoped credentials; writes require an
organization-scoped connection. The API remains the authorization authority.

The other five tools accept an optional `project` name or ID. Vaults are project-owned;
omitting `project` uses the API's effective default project, **not** all projects.
Project-scoped connections cannot switch projects. Use `get_connection_context`
to inspect the connection's scope.

`vault` accepts an ID or immutable name. `key` is an immutable item key within that
vault, not the item ID. Vault names, item keys, and project ownership cannot be renamed.

Wallet/card writes take a `provider` (`link`, `agentcard`, or `kernel`) and a JSON `spec`
**object**, not a string or a `{type, spec}` envelope. The tool injects `provider`;
if present in `spec`, it must match. Tool schemas describe the provider-specific
fields and reject unknown fields, including nested ones. No defaults or currency
normalization are applied. Amounts are integer minor currency units. All integer
inputs, including `amount`, must fit JavaScript's safe integer range; unsafe
numbers are rejected, not silently rounded. The API enforces provider/state rules.

These capabilities use the existing MCP authentication and deployment. To expose
only payment tools on a self-hosted server, set:

```sh
KERNEL_MCP_ENABLED_TOOLSETS=vaults
```

For browser checkout automation too, use `vaults browsers playwright computer`.
To hide the payment tools, set `KERNEL_MCP_DISABLED_TOOLSETS=vaults`.
This filters discovery; API authorization still enforces resource access.

## Provider configurations and imported grants

`manage_vault_provider_configs` supports both `link` and `agentcard`:

- `create`: `name`, `provider`, and `credentials: {client_id, client_secret}`.
  Duplicate names return a conflict, never a credential replacement.
- `get` / `delete`: `config` selects an ID or name. Deletion requires confirmation
  and is blocked while any non-deleted item references the config.
- `list`: optional `limit` (1–100) and `offset` (0 or greater); returns one page
  with `items`, `has_more`, and `next_offset`.
- `update`: `config` plus `name` and/or `credentials: {client_secret}`. Omitted
  fields stay unchanged. Provider, client ID, and credential mode cannot change.
  Secret rotation affects all wallets bound to the configuration.

Client secrets and imported tokens are write-only inputs for a **trusted backend
or client**. Do not ask users to paste them into chat. Do not use a client that logs
MCP arguments. The server disables SDK payload logging and omits credentials from
output and analytics; validation and API failures do not return raw secret bodies.
Public configuration responses contain ID, name, provider, non-secret client ID,
timestamps, and AgentCard's introspected mode only.

Configuration credentials identify an application; **they are not user grants**.
A customer-managed Link wallet requires the backend to complete Link OAuth first,
then call `manage_vault_wallets` with the following specification (placeholders are
not real credentials):

```json
{
  "action": "create",
  "vault": "checkout",
  "key": "imported-wallet",
  "provider": "link",
  "spec": {
    "authorization": {
      "method": "oauth",
      "client": {
        "type": "customer_managed",
        "provider_config": { "name": "my-link-client" }
      },
      "tokens": {
        "access_token": "<valid-access-token-from-backend>",
        "refresh_token": "<same-grant-refresh-token-from-backend>"
      }
    }
  }
}
```

Both tokens must belong to the referenced client and the same grant. Import
requires a valid access token; refresh expired access in the backend first.
After import, **Kernel owns refresh-token rotation**; stop refreshing that grant
in the backend. Configuration selection alone does not start hosted Link OAuth.

Use exactly one config `id` or `name`. Responses preserve the resolved config ID;
renaming does not rebind wallets. An identical wallet create never replaces its
grant, even after rotation or degradation. Changing config requires a new wallet.
There is no in-place imported reauthorization: obtain a fresh grant and use a new
wallet key for **new payments only**. Existing cards remain bound to the old wallet;
retain unresolved attempts for provider/support reconciliation, not retries.

For AgentCard, add `"provider_config": {"name": "my-agentcard"}` to the wallet
`spec`; no user OAuth tokens are accepted. Omit it to retain Kernel-managed
credentials. A reused `user_id` must belong to the same organization and config.

## Link flow

Link cards pay at a merchant checkout. Follow this order:

1. Reach the final checkout page.
2. Create the card.
3. Authorize it with `browser_id` and `page_url`.
4. Share the approval URL.
5. Wait until `fill` is advertised.
6. Fill.
7. Submit the checkout yourself.

The card item's `available_operations` descriptions are the API's current
instructions for each step, including inputs and recovery. Read them before
invoking an operation. A connected Link wallet also returns a read-only
`description` with the same flow.

1. Create or retrieve a vault with `manage_vaults`:

   ```json
   { "action": "create", "name": "checkout" }
   ```

2. Connect a wallet with `manage_vault_wallets`:

   ```json
   {
     "action": "create",
     "vault": "checkout",
     "key": "wallet-1",
     "provider": "link",
     "spec": {
       "authorization": {
         "method": "oauth",
         "client": { "type": "kernel_managed" }
       }
     }
   }
   ```

   Give the returned `item.action.url` to the user to complete with the provider.
   Do not ask for card details or OAuth codes/tokens in chat. Observe the wallet
   with `manage_vault_items`, `action: "get"`, the same vault/key, and `wait: 30`.

3. Once connected, call `manage_vault_wallets` with `action: "payment_methods"`
   and the same vault/key. Explicitly select a returned method ID with the user;
   do not automatically choose the default. Capabilities are advisory: absent
   means unknown, not ineligible.

4. Create a browser with the vault attached, then navigate to the merchant's
   final checkout page. Gather the amount, currency, and merchant name and URL
   there.

   ```json
   {
     "action": "create",
     "vaults": [{ "name": "checkout" }]
   }
   ```

   Keep this vault attached throughout checkout; attachments cannot be added to
   an existing browser. Browser and vault must be in the same project.

5. Create the card with `manage_vault_cards`, replacing `pm_selected` with the
   selected returned ID:

   ```json
   {
     "action": "create",
     "vault": "checkout",
     "key": "order-1",
     "provider": "link",
     "spec": {
       "wallet": "wallet-1",
       "payment_method_id": "pm_selected",
       "amount": 1234,
       "currency": "usd",
       "merchant_name": "Example Shop",
       "merchant_url": "https://shop.example",
       "context": "Purchase the selected office supplies from Example Shop for the approved order, with a total spending limit of 1234 minor currency units."
     }
   }
   ```

   Link also supports `line_items`, `totals`, and `metadata`. The card's
   `expires_at` comes from Link and can't be set.
   Creating the card does not contact Link: the card is `requested` and advertises
   `authorize`. Until the card is authorized at a checkout, change it with
   `action: "update"` and the full `spec`. Once it has been authorized with
   `browser_id` and `page_url`, update returns 409: delete the card and create a
   new one.

6. After explicit user approval, authorize with the browser session ID and the
   exact current top-level checkout URL, through either tool:

   ```json
   {
     "action": "authorize",
     "vault": "checkout",
     "key": "order-1",
     "browser_id": "browser-session-id",
     "page_url": "https://shop.example/checkout"
   }
   ```

   ```json
   {
     "action": "invoke",
     "vault": "checkout",
     "key": "order-1",
     "operation": "authorize",
     "inputs": {
       "browser_id": "browser-session-id",
       "page_url": "https://shop.example/checkout"
     }
   }
   ```

   Pass `browser_id` and `page_url` together; the tools reject one without the
   other. Kernel confirms exactly
   one tab is open at `page_url`, inspects the checkout, and chooses how the
   credential is delivered: a merchant-bound Link Pay Token on supported checkouts,
   otherwise a virtual card. You never choose or pass this. Fill is then limited
   to that checkout's origin, in any browser with the vault attached. Do not
   inspect or invoke the checkout's WebMCP tools yourself; Kernel does that.

   Authorize sends the user an approval request. Share the approval URL from
   `item.action` with the user, then `get` the item until `fill` is advertised.
   To re-check, authorize again without `browser_id` and `page_url`; checkout
   context is ignored at this point.

   Authorize errors `page_not_found`, `ambiguous_page`, `browser_not_found`,
   `browser_unavailable`, `destination_denied`, `timeout`, and `browser_error`
   happen before any payment request. The tools return the API's status, code,
   and message, followed by the recovery step: make sure the checkout is open in
   exactly one tab at `page_url`, then authorize again. If checkout inspection
   keeps failing, authorize without `browser_id` and `page_url` to issue a
   virtual card for the `merchant_url` origin. If the user declines, read the
   item's `status_reason`, then delete the card and create a new one. If the
   request expires, delete the card and create a new one. If the amount exceeds
   the virtual card limit (50000 minor units) on a checkout without Link Pay
   Token support, delete the card and tell the user.

7. When `fill` is advertised, follow its description. For a Link Pay Token,
   pass `browser_id` and `page_url` and omit `fields`; Kernel supplies the token
   through the checkout's WebMCP tool, so do not invoke it yourself:

   ```json
   {
     "action": "invoke",
     "vault": "checkout",
     "key": "order-1",
     "operation": "fill",
     "inputs": {
       "browser_id": "browser-session-id",
       "page_url": "https://shop.example/checkout"
     }
   }
   ```

   For a virtual card, also pass ordered, value-free field/selector bindings
   verified on that page:

   ```json
   {
     "action": "invoke",
     "vault": "checkout",
     "key": "order-1",
     "operation": "fill",
     "inputs": {
       "browser_id": "browser-session-id",
       "page_url": "https://shop.example/checkout",
       "fields": [
         { "field": "number", "selector": "#card-number" },
         { "field": "expiration", "selector": "#expiry", "format": "MM/YY" },
         { "field": "cvc", "selector": "#security-code" }
       ],
       "timeout_ms": 10000
     }
   }
   ```

   A virtual card may also advertise `webmcp_invoke`; it follows the same
   contract as in the [credential flow](#mcp-credential-flow) and, unlike fill,
   may submit the checkout.

   Each selector must resolve to one unique editable target across all frames.
   For separate expiration inputs, use `exp_month` (MM) and `exp_year` (YYYY)
   without `format`. Only combined `expiration` requires `format` (`MM/YY` or
   `MM/YYYY`). Optional `timeout_ms` is the total operation deadline (1–30000
   milliseconds; default 10000).

8. Inspect the value-free `result`: `status` is `completed`, `failed`, or
   `unknown`. Failed and unknown results are tool errors. Fill never submits
   payment, so failed or unknown fills are safe to retry. `completed` means the
   credential was supplied to the page, not that the merchant accepted payment.
   Fill does not isolate written values from browser/CDP access.

9. Submit the checkout yourself. If the payment result is unclear, check the
   merchant's order confirmation or order history before paying again.

Link does not issue or expose `item.state.aliases` and does not support proxy
swapping. Do not use aliases from older Link responses: they fail closed on
supported payment shapes.

## AgentCard flow

Use a separate vault or different immutable item keys. Create the vault as above,
then connect a wallet with `manage_vault_wallets`:

```json
{
  "action": "create",
  "vault": "checkout",
  "key": "agentcard-wallet",
  "provider": "agentcard",
  "spec": {}
}
```

Complete the returned enrollment action. Alternatively, `spec.user_id` may refer
to a user already enrolled in this organization under the same configuration. Once connected, configure a card
with `manage_vault_cards`:

```json
{
  "action": "create",
  "vault": "checkout",
  "key": "agentcard-order",
  "provider": "agentcard",
  "spec": {
    "wallet": "agentcard-wallet",
    "merchant": "Example Shop",
    "amount": 1234,
    "currency": "usd",
    "checkout_origin": "https://shop.example"
  }
}
```

AgentCard uses `merchant`, not Link's `merchant_name`. Optionally inspect wallet
payment methods and provide a returned `card_id`; otherwise the cardholder selects
one at approval. AgentCard currently does not advertise `authorize`: authorization
happens at checkout. Eligible unused cards may instead advertise `prepare_checkout`;
invoke it through the API or CLI with the advertised checkout context. Keep the approval
page open, poll until `ready_to_submit`, and submit native Pay before
`state.preparation.expires_at` (at most 30 seconds after readiness). Polling does not
extend the deadline. Each preparation is single-use even after failure or expiry.
MCP preserves preparation metadata but does not expose an invocation hint for it.

For non-prepared checkout authorizations, `spec.checkout_origin` is an optional
caller-declared origin used for eligible AgentCard autopilot rule matching. Supply
only a canonical HTTPS origin with a lowercase hostname, no explicit default port
443, and no path (for example, `https://shop.example`), or a localhost HTTP origin
for local test pages (for example, `http://localhost:3000`). Kernel forwards this
value to AgentCard and does not compare it with the browser page. Omitting it keeps
the existing approval flow; autopilot may also fall back to user approval. Prepared
checkout uses `preparation.merchant_origin` instead. Providing this origin does not
enable autopilot or ensure payment success.

For an explicitly chosen alias-based integration, attach the vault to a new browser
and use returned `item.state.aliases`, respecting returned permitted domains.
AgentCard checkout hold, approval, and replay remain supported. Observe checkout
authorization and approval URLs. Never
switch to aliases after an uncertain fill or preparation.
A reusable card remaining `ready` does not establish that the last payment succeeded.

## Observation, updates, and safety

- Single-item responses are JSON text containing `{item, hints, guidance}`. They preserve
  public state, supported AgentCard aliases, masks, safe action/approval URLs, advertised
  operations/expansions, and payment outcomes. Unknown provider fields, opaque
  event data, free-form metadata, and URLs carrying OAuth codes/tokens are omitted.
  API errors retain the HTTP status, error code, and message. Link authorize
  errors from checkout inspection also name the recovery step.
  There is no raw-output or raw-card tool.
- `hints.observation` contains `{tool, arguments}` entries for non-blocking `get`
  and `events` calls. `hints.invocation` contains only currently advertised
  operations, each with `requires_user_approval: true` except the read-only
  `1pw_access_request_status`. A requested Link card's `authorize` hint also
  lists `required_inputs: ["browser_id", "page_url"]`; add them under `inputs`
  from the final checkout page. Hints preserve the resolved
  project selector (when present), vault, and item key. Pass `tool` as the MCP
  call's `name` and `arguments` unchanged. Provider-hosted actions remain separate
  in `item.action` and approval URLs; they are not callable operation hints.
  **A hint is not user approval or a recommendation to retry a payment.**
  Availability can change; `invoke` still fetches the item and rechecks it.
- Vault lists return `{items, has_more, next_offset}`. Item lists return `{items}`.
  `get` with `expand: ["payment_methods"]` is equivalent to the wallet
  `payment_methods` action. An unavailable expansion returns an API error.
- Only `get` and `events` accept `wait: 0..60`; other actions reject it.
  `invoke` does not wait for authorization. Each observation is bounded,
  not a background polling loop or readiness guarantee. The SDK timeout is the
  wait plus 30 seconds; configure the MCP client's timeout accordingly, or use
  shorter waits. Request cancellation is propagated to the SDK.
- `events` accepts `after` and returns `{events, next_after, hints, guidance}`.
  Its observation hints include the next events cursor, preserving the input
  cursor on an empty result (or omitting `after` when there is no cursor).
  Event responses do not include invocation hints because they do not establish
  current operation availability.
- **Ready does not mean paid.** Inspect state and immutable events for outcomes.
  No vault request is automatically retried. After a failed, timed-out, rejected,
  or indeterminate payment, inspect state/events; do not replay checkout, invoke
  again, or reconfigure a card to retry it.
- Requested-card `update` replaces the spec. A Link card can be updated until it
  is authorized with `browser_id` and `page_url`; after that the API returns 409,
  so delete it and create a new card. Pending issuance updates preserve
  omitted optional fields and clear explicit empty lists; only provider-supported
  changes are allowed. Provider/wallet bindings cannot change after authorization
  starts. The tool forwards omissions and empty values without normalization.
  The API decides which edits are allowed; an uncertain update enters
  `recovery_required` and must not be retried.
- `recovery_required` is preserved in responses and ends the API's bounded wait.
  It is neither decline nor expiry. Stop payment attempts and reconcile with the
  provider or support. The sole exception is an advertised `restart_verification`
  on a Kernel card: after explicit user approval each time, invoke with no inputs
  and privately deliver the new `spend_approval` link for new verification and
  spend consent. Re-get after a lost response; invoke once more only if still
  advertised with renewed user approval. This only recovers proven no-dispatch
  attestation failure, not an uncertain payment. Otherwise contact support@kernel.sh
  privately with project, vault, key, status_reason and event timestamps (no card
  data, API keys or capability URLs); do not delete or replace unresolved items.
  There is no general reset or caller-asserted reconciliation tool. Unresolved
  cards can also block deletion of their wallet and vault.
- Browser attachments accept at most 20 references, each containing exactly one
  `id` or `name`. They are creation-only and unavailable for browser pools. You
  cannot add vaults to an existing browser. Vault-bound browser creation also
  disables automatic SDK retries.
- Provider-assigned permitted domains are not configurable through these tools.
- Vault/item deletion invalidates the affected credentials. Confirm with the user
  first. Any HTTP 404 returns `deleted_or_not_found`, including a missing project;
  other errors fail. Non-delete 404s remain errors.
- The existing analytics filter omits tool inputs, outputs, and error messages;
  do not add payment payloads or action URLs to application logs.
