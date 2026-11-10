# Kernel-issued (native) OAuth consumer

The MCP server can accept access tokens issued by the Kernel API's native
issuer (`packages/api/lib/oauthnative` in kernel/kernel). It is off by default.
With `OAUTH_NATIVE_ENABLED` unset or not `true`, nothing else is read and no
new secret is required.

## Behavior

A bearer token is native when it is a compact JWT whose header `typ` is
`at+jwt` or `application/at+jwt`, the same selector the Kernel API uses.
Clerk session tokens (`typ: JWT`) and opaque API keys keep their existing
paths. A native token never falls back to Clerk or to API-key handling.

| State                            | Native token                                                |
| -------------------------------- | ----------------------------------------------------------- |
| disabled                         | 401 `invalid_token`, no issuer or API call                  |
| enabled, configuration invalid   | 503 `temporarily_unavailable`                               |
| signature/claims rejected        | 401 before any network call                                 |
| issuer answers `invalid_grant`   | 401 (revoked, expired, inactive grant)                      |
| issuer answers `invalid_scope`   | 403 `insufficient_scope`                                    |
| any other issuer failure         | 503 `temporarily_unavailable`                               |
| exchanged token fails validation | 503 `temporarily_unavailable`                               |
| exchange succeeds                | request proceeds with the exchanged token, one-minute lease |

For every request the server:

1. Verifies the token locally against the pinned JWKS: RS256, `kid`, issuer,
   exactly one audience equal to `OAUTH_NATIVE_MCP_AUDIENCE`, issuer epoch,
   `authorization_version` 1, lifetime at most ten minutes, 30 s skew, and
   no `act`/`parent_jti` (exchanged tokens cannot be exchanged again).
2. Exchanges it at `<issuer>/token` (RFC 8693, `client_secret_basic` with the
   configured intermediary) for an API-audience token with the parent's
   scope. The issuer re-checks grant, registration and membership status on
   every exchange, so revocation takes effect on the next request.
3. Verifies the exchanged token: API audience, at most five minutes, not
   outliving the parent, same `sub`/`grant_id`/`org_id`/`project_id`,
   `client_id` and `act.sub` naming the intermediary, `parent_jti` equal to
   the parent `jti`, and scopes no wider than the parent's.
4. Forwards only the exchanged token to the Kernel API. The MCP-audience
   token is never sent to the API.

The request and any stream it opens end after one minute or the exchanged
token's remaining lifetime, whichever is shorter; continuing needs a new
request and a new exchange. Each native request therefore costs one exchange
(one issued-token row) on the API.

## Configuration

Every value is required when `OAUTH_NATIVE_ENABLED=true`; none has a default.

| Variable                         | Staging value                                                          |
| -------------------------------- | ---------------------------------------------------------------------- |
| `OAUTH_NATIVE_ISSUER`            | `https://auth.dev.onkernel.com` (API `iss`)                            |
| `OAUTH_NATIVE_MCP_AUDIENCE`      | `https://mcp.dev.onkernel.com` (API `NATIVE_OAUTH_MCP_AUDIENCE`)       |
| `OAUTH_NATIVE_API_AUDIENCE`      | `https://api.dev.onkernel.com` (API `NATIVE_OAUTH_API_AUDIENCE`)       |
| `OAUTH_NATIVE_ISSUER_EPOCH`      | API `NATIVE_OAUTH_ISSUER_EPOCH`                                        |
| `OAUTH_NATIVE_VERIFICATION_JWKS` | public keys from `https://auth.dev.onkernel.com/.well-known/jwks.json` |
| `OAUTH_NATIVE_EXCHANGE_CLIENT`   | confidential registration id (`kcl_…`)                                 |
| `OAUTH_NATIVE_EXCHANGE_SECRET`   | its secret (`kcs_…`), staging secret store only                        |

Origins must be HTTPS with no path or trailing slash, and the two audiences
must differ. The JWKS must hold only public RSA members with a `kid`.
Keys are pinned rather than fetched, so the API's signing-key rotation
runbook must update this value in its pre-publish step, and keep retired keys
until no token they signed can still be live. `API_BASE_URL` must point at the
API whose native audience is `OAUTH_NATIVE_API_AUDIENCE`.

## Activation prerequisites

Do not enable this anywhere until each item is resolved; production stays off.

1. **Auth context in policy mode.** Exchanged tokens always run in policy
   mode, and every MCP request resolves `GET /auth/context`. On API main that
   operation is denied in policy mode, so every native request ends in 403.
   kernel/kernel#5309 permits it and must be deployed first.
2. **Tool coverage.** Exchanged tokens reach only the operations listed in
   the API's `lib/middleware/scoped_operations.go`; other tools answer 403.
   This is not native tool parity with Clerk or API-key callers.
3. **Resource alignment.** MCP discovery advertises the resource
   `https://mcp.dev.onkernel.com/mcp`, which MCP clients send as `resource`.
   The API accepts only the exact origin `https://mcp.dev.onkernel.com` and
   answers `invalid_target` otherwise; a request with no `resource` yields an
   API-audience token that this server rejects. One side must accept the
   other's identifier deliberately; this server does not rewrite audiences.
4. **Routing.** Staging routes only the CLI natively
   (`NATIVE_OAUTH_DEFAULT_NEW_FLOWS=false`), and CLI tokens carry the API
   audience. MCP clients receive native MCP-audience tokens only once new
   non-CLI flows are routed natively, which also moves every other staging
   client. Enable this consumer on staging before that switch.
5. **Intermediary registration.** An operator creates a confidential
   registration with only the token-exchange grant
   (`Service.CreateConfidentialClient`; there is no HTTP enrollment), sets the
   API's `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID` to its id, and stores its
   secret only in the staging MCP environment.

## Staging acceptance (not yet run)

Unit tests cover the contract with locally signed tokens and a mocked issuer
modeled on the deployed API. None of the following has been run:

1. Fetch protected-resource and authorization-server metadata; register a
   public client.
2. Browser PKCE login: Clerk sign-in, organization/project picker, native
   consent; redeem the code for an MCP-audience token.
3. `initialize` and `tools/list`; confirm the API sees only the exchanged
   token (`act`, `parent_jti`).
4. Call a project-scoped tool that reaches a scoped operation, such as a
   browser list, and confirm a different project's resource is denied.
5. Refresh, then revoke the token and the grant; the next request is 401.
6. Hold a stream past one minute; it closes and the client reconnects.
7. Confirm Clerk OAuth and API-key connections behave as before.
