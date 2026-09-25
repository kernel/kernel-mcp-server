# Vault payments

The vault tools prepare and observe payment credentials and manage non-payment credential items. They do **not** submit
merchant payments, return real card values in API responses, or complete provider approval actions.
They use the same vault API as the Kernel CLI. Link cards are immutable requests
bound to a live browser at final checkout, and use the advertised `fill` operation:
Kernel supplies a Link Pay Token or card values to the page, which may be read by
an agent with browser or CDP access. Link does not expose aliases or support proxy
substitution. The AgentCard alias recipe below is for explicitly chosen
egress-substitution integrations, not fallback after a failed or uncertain fill.

**Assume real payment effects.** Mode comes from the selected provider credentials;
there is no per-item test flag. AgentCard configuration responses report the
introspected `test_mode`. A development or staging MCP endpoint does not make a
card request a test transaction.

The Node SDK dependency is pinned in `bun.lock`.

## Credential collection and observation

Use one vault per end user, such as `user-123`. Create credential definitions with
`manage_vault_credentials`: use only the recognizable site name for `description`, and
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
isolate them from an agent with browser access. Never retry an uncertain fill or
fall back to payment aliases.

### MCP credential flow

1. Create the user's vault with `manage_vaults` (`action: "create"`, `name: "user-123"`).
   Create a browser with `manage_browsers` and `vaults: [{"name":"user-123"}]`.
   Vault bindings cannot be changed later. Navigate to the intended login page and inspect its inputs.
2. Call `manage_vault_credentials` with:

   ```json
   {
     "action": "create",
     "vault": "user-123",
     "key": "login",
     "spec": {
       "description": "Example",
       "fields": {
         "username": { "type": "text", "required": true, "sensitive": false },
         "password": { "type": "password", "required": true, "sensitive": true }
       }
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
   `unknown` are tool errors, not invitations to retry; fields may already be written.
   API validation errors (400/403/404/409) retain HTTP status and recognized error codes,
   with actionable explanations and confirmation that this request wrote no fields.
   Inspect and correct the cause before deciding on a new fill. Transport loss and
   other uncertain failures retain the no-retry warning. Raw upstream error bodies
   are never returned.
   Fill does not navigate or submit. Submit separately only after confirming the fill
   completed and submission is authorized. TOTP bindings send only the field name;
   the API generates each current code immediately before writing, never exposing seeds.

Updates use `action: "update"`, `version`, optional `expected_item_id`, and a `spec`
containing `description` and/or `fields: {"username":{"value":"new-name"}}`.
Definitions cannot be changed. Never solicit secret replacement values in chat;
prefer `collect` for human edits. Requests are not automatically retried.
`prepare_checkout` remains API/CLI-only.

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
| `manage_vault_cards`            | `create`                                    |
| `manage_vault_credentials`      | `create`, `update`                          |
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

Wallet/card writes take a `provider` (`link` or `agentcard`) and a JSON `spec`
**object**, not a string or a `{type, spec}` envelope. The tool injects `provider`;
if present in `spec`, it must match. Tool schemas describe the provider-specific
fields and reject unknown fields, including nested ones. No defaults or currency
normalization are applied. Amounts are integer minor currency units. All integer
inputs, including `expires_at`, must fit JavaScript's safe integer range; unsafe
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

4. Create a new browser with `manage_browsers`, attaching the vault:

   ```json
   {
     "action": "create",
     "vaults": [{ "name": "checkout" }]
   }
   ```

   Keep this vault attached throughout checkout; attachments cannot be added to
   an existing browser. Browser and vault must be in the same project. Navigate
   to the merchant's final checkout page and gather the final amount, currency,
   and merchant name before creating the card.

5. Create the card with `manage_vault_cards`, using the live browser session ID
   (not a reusable browser name), the exact final checkout URL, and the selected
   payment method ID:

   ```json
   {
     "action": "create",
     "vault": "checkout",
     "key": "order-1",
     "provider": "link",
     "spec": {
       "wallet": "wallet-1",
       "browser_id": "browser-session-id",
       "page_url": "https://shop.example/checkout",
       "payment_method_id": "pm_selected",
       "amount": 1234,
       "currency": "usd",
       "merchant_name": "Example Shop",
       "context": "Purchase the selected office supplies from Example Shop for the approved order, with a total spending limit of 1234 minor currency units."
     }
   }
   ```

   Link also supports `line_items`, `totals`, `metadata`, and `expires_at`.
   Never pass a merchant account ID or choose an execution mode. Kernel inspects
   the checkout page at creation: on Stripe Checkout pages that expose Link Pay
   Token tools, it uses a merchant-bound Link Pay Token (up to 500000 minor
   units); otherwise it uses a one-time virtual card (up to 50000 minor units).
   The item does not reveal which mode was chosen.

   Creation starts the Link spend request and approval. There is no separate
   authorize operation. The card returns `state.status: "pending_authorization"`
   and `action: {"name": "spend_approval", "url": ...}`. Give `item.action.url`
   to the user to approve in Link, then observe with `manage_vault_items`,
   `action: "get"`, and `wait: 60` until the card is ready and advertises `fill`.

   Cards are immutable. An identical create returns the existing item without
   repeating discovery or approval; a different spec under the same key returns
   a conflict. To change the payment, delete the card and create a new request
   under a new key. Never create a new card to retry an uncertain payment.

6. Only when the card advertises `fill`, read that operation's description. It
   names the exact inputs to supply. For a Link Pay Token, it asks for only
   `browser_id` and `page_url` exactly as stored in the card's spec, with no
   `fields`:

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

   For a virtual card, it also asks for field/selector bindings verified on the
   page:

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

   `inputs` is the operation's request body without `type`. `page_url` must be
   the exact current top-level page URL (including path, query, and fragment) and
   match exactly one open page. `fields` contains bindings, never card values.
   Each selector must resolve to one unique editable target across all frames.
   For separate expiration inputs, use `exp_month` (MM) and `exp_year` (YYYY)
   without `format`. Only combined `expiration` requires `format` (`MM/YY` or
   `MM/YYYY`). Optional `timeout_ms` is the total operation deadline (1–30000
   milliseconds; default 10000). Request only needed billing fields; a missing
   requested billing value returns `field_unavailable` before any writes.

7. Inspect the value-free `result`: `status` is `completed`, `failed`, or `unknown`,
   with one outcome per binding (`filled`, `failed`, `unknown`, or `not_attempted`).
   `fields` is empty when the fill used no bindings. Filling stops at the first
   failure; prior writes are not rolled back. Failed and unknown results are tool
   errors, not invitations to retry. Transport loss can also leave partial writes.
   Inspect the browser before further action; never automatically retry a failed
   or uncertain fill or fall back to aliases. Pre-write validation errors
   (for example `page_not_found`, `ambiguous_page`, `destination_denied`, or
   `browser_unavailable`) keep their HTTP status and code; correct the cause
   before deciding on a new fill.

   Fill never navigates, clicks Pay, or submits checkout, though input/change
   events may trigger site behavior. `completed` means the credential was
   supplied to the page, not merchant acceptance or payment success. Click Pay
   separately only after confirming completion and the user's authorization;
   reconcile uncertain payment outcomes instead of retrying.

Link wallets expose a read-only `description` with current server-generated
guidance. Link no longer issues or exposes `item.state.aliases`, and proxy swapping
is removed. Do not use aliases from older Link responses: they fail closed on
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
to a user already enrolled in this organization under the same configuration. Once connected, create a card
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
    "currency": "usd"
  }
}
```

AgentCard uses `merchant`, not Link's `merchant_name`. Optionally inspect wallet
payment methods and provide a returned `card_id`; otherwise the cardholder selects
one at approval. AgentCard authorization happens at checkout. Eligible unused cards may instead advertise `prepare_checkout`;
invoke it through the API or CLI with the advertised checkout context. Keep the approval
page open, poll until `ready_to_submit`, and submit native Pay before
`state.preparation.expires_at` (at most 30 seconds after readiness). Polling does not
extend the deadline. Each preparation is single-use even after failure or expiry.
MCP preserves preparation metadata but does not expose an invocation hint for it.

For an explicitly chosen alias-based integration, attach the vault to a new browser
and use returned `item.state.aliases`, respecting returned permitted domains.
AgentCard checkout hold, approval, and replay remain supported. Observe checkout
authorization and approval URLs. Never
switch to aliases after an uncertain fill or preparation.
A reusable card remaining `ready` does not establish that the last payment succeeded.

## Observation and safety

- Single-item responses are JSON text containing `{item, hints, guidance}`. They preserve
  public state, supported AgentCard aliases, masks, safe action/approval URLs, advertised
  operations/expansions, and payment outcomes. Unknown provider fields, opaque
  event data, free-form metadata, and URLs carrying OAuth codes/tokens are omitted.
  API errors retain the HTTP status but use curated messages for recognized error
  codes. Unknown codes use a generic fallback; upstream error text is never returned.
  There is no raw-output or raw-card tool.
- `hints.observation` contains `{tool, arguments}` entries for non-blocking `get`
  and `events` calls. `hints.invocation` contains only currently advertised
  operations, each with `requires_user_approval: true`. Hints preserve the resolved
  project selector (when present), vault, and item key. Pass `tool` as the MCP
  call's `name` and `arguments` unchanged. Provider-hosted actions remain separate
  in `item.action` and approval URLs; they are not callable operation hints.
  **A hint is not user approval or a recommendation to retry a payment.**
  Availability can change; `invoke` still fetches the item and rechecks it.
- Vault lists return `{items, has_more, next_offset}`. Item lists return `{items}`.
  `get` with `expand: ["payment_methods"]` is equivalent to the wallet
  `payment_methods` action. An unavailable expansion returns an API error.
- Only `get` and `events` accept `wait: 0..60`; other actions reject it.
  `invoke` does not wait for approval. Each observation is bounded,
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
  again, or create a new card to retry it.
- Cards are immutable; there is no card update. The tool forwards omissions and
  empty values without normalization. An uncertain creation enters
  `recovery_required` and must not be retried or replaced.
- `recovery_required` is preserved in responses and ends the API's bounded wait.
  It is neither decline nor expiry. Stop payment attempts and reconcile with the
  provider or support. There is no reset or caller-asserted reconciliation tool.
  Unresolved cards can also block deletion of their wallet and vault.
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
