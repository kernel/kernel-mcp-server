# Vault payments

The vault tools prepare and observe payment credentials and read existing non-payment credential items. They do **not** submit
merchant payments, expose real card values, or complete provider approval actions.
They use the same vault API as the Kernel CLI. When advertised, API fill is the
preferred browser-checkout path. The alias recipes below are for explicitly chosen
egress-substitution integrations, not fallback after a failed or uncertain fill.

**Assume real payment effects.** Mode comes from the selected provider credentials;
there is no per-item test flag. AgentCard configuration responses report the
introspected `test_mode`. A development or staging MCP endpoint does not make a
card request a test transaction.

The released Node SDK dependency is pinned in `bun.lock`.

## Credential collection and observation

Use one vault per end user, such as `user-123`. Create credential definitions through
the Kernel API or CLI: use only the recognizable site name for `description`, and
set `sensitive: false` explicitly for ordinary usernames/emails. Passwords and TOTP
seeds must be sensitive. Payment-card data belongs in wallet/card items, not credentials.

`manage_vault_items` can read existing credential items and invoke advertised `collect`.
It returns field definitions, `has_value`, version, and collection-link expiry, but
omits all stored values, even non-sensitive ones. Share the bearer collection link
only with the intended user, outside the agent-controlled browser. Never request a
password or TOTP seed in chat; hosted collection cannot accept TOTP seeds.

Listing does not renew links; use single-item `get` or advertised `collect`.
Collection reopens the full form without clearing values or changing version.
`wait` observes readiness, not edits to ready items. Compare versions using `get`
without `wait`; API updates can also change the version.

Credential creation/updates, `fill`, and `prepare_checkout` remain API/CLI-only;
MCP does not accept their write inputs. For API updates, use the current version
and `expected_item_id` when bound to an earlier read. Clearing supported required
values returns pending collection; hosted forms still require populated inputs.
Fill writes real values into the browser without submitting the form. It does not
isolate them from an agent with browser access. Never retry an uncertain fill or
fall back to payment aliases.

## Tools and scope

The five vault tools are exposed only when the current credential's
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
| `manage_vault_cards`            | `create`, `update`                          |
| `manage_vault_items`            | `list`, `get`, `invoke`, `events`, `delete` |

Provider configurations are organization-owned and do not accept a project
selector. Reads are available to project-scoped credentials; writes require an
organization-scoped connection. The API remains the authorization authority.

The other four tools accept an optional `project` name or ID. Vaults are project-owned;
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

4. Create the purchase request with `manage_vault_cards`, replacing
   `pm_selected` with the selected returned ID:

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

   Link also supports `line_items`, `totals`, `metadata`, and `expires_at`.
   Creating or updating the card does **not** implicitly authorize it.

5. Read `available_operations` with `manage_vault_items`, `action: "get"`.
   Read the operation description and obtain explicit user approval before
   invoking an advertised operation:

   ```json
   {
     "action": "invoke",
     "vault": "checkout",
     "key": "order-1",
     "operation": "authorize"
   }
   ```

   The tool fetches the item again and submits only a currently advertised
   operation. The current API accepts only `{"type":"authorize"}`; there are no
   operation parameters. New parameterless operation names can be forwarded when
   the API advertises them. Follow any returned provider action and observe state.
   OAuth, enrollment, MFA, and approval actions are for the user, not operation names.

6. When ready, create a new browser with `manage_browsers`:

   ```json
   {
     "action": "create",
     "vaults": [{ "name": "checkout" }]
   }
   ```

   Use only returned `item.state.aliases` through the browser tools in **that
   browser**, respecting returned permitted domains. Merchant checkout submission
   is a separate browser action and requires the user's authorization.

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
    "currency": "usd"
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

For an explicitly chosen alias-based integration, attach the vault to a new browser
and use returned aliases. Observe checkout authorization and approval URLs. Never
switch to aliases after an uncertain fill or preparation.
A reusable card remaining `ready` does not establish that the last payment succeeded.

## Observation, updates, and safety

- Single-item responses are JSON text containing `{item, hints, guidance}`. They preserve
  public state, non-secret aliases, masks, safe action/approval URLs, advertised
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
- Requested-card `update` replaces the spec. Pending issuance updates preserve
  omitted optional fields and clear explicit empty lists; only provider-supported
  changes are allowed. Provider/wallet bindings cannot change after authorization
  starts. The tool forwards omissions and empty values without normalization.
  The API decides which edits are allowed; an uncertain update enters
  `recovery_required` and must not be retried.
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
