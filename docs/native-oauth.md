# Kernel-issued (native) OAuth

The MCP server accepts access tokens issued by Kernel's own authorization
server alongside Clerk OAuth tokens and API keys. Clients discover it through
protected-resource metadata and authorize with `resource` set to the MCP
endpoint.

## Behavior

A bearer token is native when it is a compact JWT whose header `typ` is
`at+jwt` (or `application/at+jwt`). Clerk session tokens (`typ: JWT`) and
opaque API keys keep their existing paths. A native token never falls back to
Clerk or to API-key handling.

On every request the server:

1. Verifies the token locally: RS256, issuer, exactly one audience equal to
   the MCP resource (`https://mcp.onkernel.com/mcp`), `typ`, profile version,
   a lifetime of at most ten minutes with 30 s skew, and no `act` or
   `parent_jti` (exchanged tokens cannot be exchanged again). Keys come from
   the trusted issuer's `/.well-known/jwks.json`, never from a location named
   in the token. The key set is cached for ten minutes and refetched at most
   every 30 s when an unknown key id appears.
2. Reuses a cached exchanged token for this incoming token, or exchanges it
   at `<issuer>/token` (RFC 8693, `client_secret_basic`) for an API-audience
   token with `resource=<API origin>` and the same scope.
3. Verifies the exchanged token and its lineage: API audience, at most five
   minutes, same `sub`/`grant_id`/`org_id`/`project_id`, `client_id` and
   `act.sub` naming the exchange client, `parent_jti` equal to the incoming
   `jti`, expiry no later than the incoming token's, and no wider scope.
4. Calls the Kernel API, starting with `GET /auth/context`, with only the
   exchanged token. The MCP-audience token never reaches the API.

| Outcome                                                                                           | Response                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------- |
| native OAuth not configured on this server                                                        | 401 `invalid_token`           |
| token fails local verification                                                                    | 401 `invalid_token`           |
| issuer answers `invalid_grant` (revoked, expired)                                                 | 401 `invalid_token`           |
| issuer answers `invalid_scope`                                                                    | 403 `insufficient_scope`      |
| issuer keys or token endpoint unreachable, 5xx, `temporarily_unavailable`                         | 503 `temporarily_unavailable` |
| issuer refuses this server (`invalid_target`, `invalid_client`, …) or returns an unexpected token | 503, logged as an error       |

### Caching and freshness

- **Exchanged tokens** are cached in Redis so every instance can reuse them.
  The key is an HMAC of the issuer, MCP audience and incoming token. The value
  is encrypted with AES-256-GCM under a key derived (HKDF-SHA256) from the
  incoming token, so the cache contents are useless without the incoming
  bearer. An entry expires a minute before the exchanged token does, and a
  cached token is used only after it decrypts and verifies again against the
  incoming token. A miss, a Redis error or a read slower than 500 ms falls back
  to a fresh exchange. Concurrent requests on one instance share an exchange.
- **Revocation** is unaffected: the incoming token is verified on every
  request, and the API checks the exchanged token's status on every call.
- **`/auth/context`** is resolved on every native request; nothing derived
  from it is reused across requests.
- **Identity** for MCP Apps markers, analytics sessions and the entitlements
  snapshot is the verified `sub` (and `grant_id` for entitlements), not the
  rotating exchanged token. The entitlements snapshot keeps its usual
  30-minute lifetime and only selects which tools are listed; every tool call
  is still authorized by the API.
- **Requests and streams** end when the exchanged token expires (at most five
  minutes); clients reconnect with a fresh request.
- **Permissions** are chosen by the person who connects, on the authorization
  server's consent page. The protected-resource metadata lists no
  `scopes_supported`, so clients request no scopes and that page decides.
  When the exchanged token names actions, toolsets none of them can use are
  left out of the tool list and `get_connection_context` reports them under
  `granted`. A token that names no action lists every toolset. Either way the
  API authorizes each call.

## Configuration

Native configuration is resolved once at startup from this server's public
origin, `MANAGED_AUTH_APP_ORIGIN` (default `https://mcp.onkernel.com`).

| MCP origin                     | Issuer                          | API                            |
| ------------------------------ | ------------------------------- | ------------------------------ |
| `https://mcp.onkernel.com`     | `https://auth.onkernel.com`     | `https://api.onkernel.com`     |
| `https://mcp.dev.onkernel.com` | `https://auth.dev.onkernel.com` | `https://api.dev.onkernel.com` |

| Variable                                  | Purpose                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `MANAGED_AUTH_APP_ORIGIN`                 | this server's public origin; selects the row above                        |
| `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID`     | the token-exchange client configured on the authorization server          |
| `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET` | its secret                                                                |
| `API_BASE_URL`                            | the API origin; exchanged tokens are only valid at their own API          |
| `NATIVE_OAUTH_ISSUER`                     | issuer for any other origin, such as local development; HTTPS or loopback |

- **The two origins above** always accept native tokens. Both exchange
  variables are required, `API_BASE_URL` must be that row's API, and
  `NATIVE_OAUTH_ISSUER` must not be set.
- **Any other origin** sets all of `NATIVE_OAUTH_ISSUER` and both exchange
  variables, or none of them. With none, native OAuth is off and native tokens
  are rejected like any untrusted token. The API is `API_BASE_URL`.

Missing or inconsistent settings stop the server at startup: Next.js runs the
check in `src/instrumentation.ts` before serving, and an instance whose check
fails serves no requests. `next build` does not run the check.
