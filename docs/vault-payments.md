# Vault payments

The vault tools prepare and observe payment credentials. They do **not** submit
merchant payments, expose real card values, or complete provider approval actions.
They use the same vault API as the Kernel CLI.

**These are live payment cards. Test-mode creation is unsupported.** Do not assume
that a development or staging MCP endpoint makes a card request a test transaction.

## Tools and scope

| Tool                   | Actions                                     |
| ---------------------- | ------------------------------------------- |
| `manage_vaults`        | `create`, `list`, `get`, `delete`           |
| `manage_vault_wallets` | `create`, `payment_methods`                 |
| `manage_vault_cards`   | `create`, `update`                          |
| `manage_vault_items`   | `list`, `get`, `invoke`, `events`, `delete` |

Every tool accepts an optional `project` name or ID. Vaults are project-owned;
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
to a user already enrolled in this organization. Once connected, configure a card
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
happens at checkout. Attach the vault to a new browser and use returned aliases.
Observe the card for its checkout authorization and any approval URL for the user.
A reusable card remaining `ready` does not establish that the last payment succeeded.

## Observation, updates, and safety

- Single-item responses are JSON text containing `{item, guidance}`. They preserve
  public state, non-secret aliases, masks, safe action/approval URLs, advertised
  operations/expansions, and payment outcomes. Unknown provider fields, opaque
  event data, free-form metadata, and URLs carrying OAuth codes/tokens are omitted.
  API errors retain the HTTP status but use curated messages for recognized error
  codes. Unknown codes use a generic fallback; upstream error text is never returned.
  There is no raw-output or raw-card tool.
- Vault lists return `{items, has_more, next_offset}`. Item lists return `{items}`.
  `get` with `expand: ["payment_methods"]` is equivalent to the wallet
  `payment_methods` action. An unavailable expansion returns an API error.
- Only `get` and `events` accept `wait: 0..60`; other actions reject it.
  `invoke` does not wait for authorization. Each observation is bounded,
  not a background polling loop or readiness guarantee. The SDK timeout is the
  wait plus 30 seconds; configure the MCP client's timeout accordingly, or use
  shorter waits. Request cancellation is propagated to the SDK.
- `events` accepts `after` and returns `{events, next_after, guidance}`. Pass
  `next_after` on the next call for the same vault/key. An empty result preserves
  the input cursor (or returns `null` without one).
- **Ready does not mean paid.** Inspect state and immutable events for outcomes.
  No vault request is automatically retried. After a failed, timed-out, rejected,
  or indeterminate payment, inspect state/events; do not replay checkout, invoke
  again, or reconfigure a card to retry it.
- Card `update` replaces the **entire spec**; omitted optional fields are removed.
  The API decides when a card can be reconfigured.
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
