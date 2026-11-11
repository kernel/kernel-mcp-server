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
2. Exchanges it at `<issuer>/token` (RFC 8693, `client_secret_basic`) for an
   API-audience token with `resource=<API origin>` and the same scope.
3. Verifies the exchanged token and its lineage: API audience, at most five
   minutes, same `sub`/`grant_id`/`org_id`/`project_id`, `client_id` and
   `act.sub` naming the exchange client, `parent_jti` equal to the incoming
   `jti`, expiry no later than the incoming token's, and no wider scope.
4. Calls the Kernel API, starting with `GET /auth/context`, with only the
   exchanged token. The MCP-audience token never reaches the API.

| Outcome                                                                                                                   | Response                      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| token fails local verification                                                                                            | 401 `invalid_token`           |
| no native issuer trusted for this origin                                                                                  | 401 `invalid_token`           |
| issuer answers `invalid_grant` (revoked, expired)                                                                         | 401 `invalid_token`           |
| issuer answers `invalid_scope`                                                                                            | 403 `insufficient_scope`      |
| issuer keys or exchange unreachable, 5xx                                                                                  | 503 `temporarily_unavailable` |
| missing exchange credentials, `invalid_target`, `invalid_client`, other OAuth errors, exchanged token outside its lineage | 500 `server_error`, logged    |

### Caching and freshness

- **Exchanged tokens** are cached in memory, keyed by a SHA-256 fingerprint of
  the incoming token (never the token itself), at most 1,000 entries. An entry
  is reused only while at least a minute of its lifetime remains, bounded by
  both tokens' expiry. Concurrent requests with the same token share one
  exchange. The incoming token is verified before the cache is consulted, and
  the API checks the exchanged token's status on every call, so revocation
  still takes effect on the next request. Losing the cache costs only a new
  exchange.
- **`/auth/context`** is resolved on every native request; nothing derived
  from it is reused across requests.
- **Identity** for MCP Apps markers, analytics sessions and the entitlements
  snapshot is the verified `sub` (and `grant_id` for entitlements), not the
  rotating exchanged token. The entitlements snapshot keeps its usual
  30-minute lifetime and only selects which tools are listed; every tool call
  is still authorized by the API.
- **Requests and streams** end when the exchanged token expires (at most five
  minutes); clients reconnect with a fresh request.

## Configuration

Trust follows the public MCP origin, the same mapping discovery advertises:

| MCP origin                     | Issuer                          | API                            |
| ------------------------------ | ------------------------------- | ------------------------------ |
| `https://mcp.onkernel.com`     | `https://auth.onkernel.com`     | `https://api.onkernel.com`     |
| `https://mcp.dev.onkernel.com` | `https://auth.dev.onkernel.com` | `https://api.dev.onkernel.com` |

| Variable                                  | Required               | Purpose                                                                                          |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID`     | yes                    | the token-exchange client configured on the authorization server                                 |
| `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET` | yes (secret)           | its secret                                                                                       |
| `API_BASE_URL`                            | yes                    | must be the API origin for this MCP origin; exchanged tokens are valid only there                |
| `NATIVE_OAUTH_ISSUER`                     | only for other origins | issuer for origins outside the table, such as `http://localhost:3002`; ignored for the two above |

If the exchange credentials are missing or `API_BASE_URL` does not match,
native tokens fail with a 500 and a log line naming the setting; Clerk tokens
and API keys are unaffected. Configuration is read per request, so a build or
an unrelated route never fails on it. On origins outside the table without
`NATIVE_OAUTH_ISSUER`, native tokens are rejected with 401.

### Provisioning the exchange secret

The MCP server's runtime configuration lives in its Vercel project's
environment variables, one set per environment (staging serves
`mcp.dev.onkernel.com`, production `mcp.onkernel.com`). For each environment:

1. Take the exchange client ID and raw secret that the authorization server
   for that environment is configured with. Never reuse a secret across
   environments or commit it.
2. Add `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_ID` and
   `NATIVE_OAUTH_MCP_EXCHANGE_CLIENT_SECRET` (marked sensitive) to that
   environment only, and confirm `API_BASE_URL` is the matching API origin.
3. Redeploy that environment so the new variables take effect.

## Activation prerequisites

1. The authorization server accepts the path-bearing MCP resource
   (`<mcp origin>/mcp`) as the MCP audience, validates the exchange `resource`
   (`invalid_target` otherwise), and has the static exchange client configured.
   That server change must be deployed before this one is exercised.
2. The exchange client ID and secret are provisioned in the MCP environment as
   above.
3. In staging, route new OAuth flows natively on the authorization server
   (`NATIVE_OAUTH_DEFAULT_NEW_FLOWS=true`) and run the acceptance checks
   below. Production follows only after staging passes and is approved.

Exchanged tokens reach only the API operations available to scoped OAuth
tokens; other tools answer 403 until the API allows them.

## Staging acceptance

1. Fetch `https://mcp.dev.onkernel.com/.well-known/oauth-protected-resource/mcp`:
   `resource` is `https://mcp.dev.onkernel.com/mcp`, `authorization_servers`
   is `https://auth.dev.onkernel.com`, and `resource_name` /
   `resource_documentation` are present.
2. Connect an MCP client from scratch: dynamic registration, browser PKCE
   login and consent. The access token has `typ: at+jwt` and
   `aud: ["https://mcp.dev.onkernel.com/mcp"]`.
3. `initialize`, `tools/list` and a project-scoped tool call (for example a
   browser list) succeed; a different project's resource is denied.
4. Repeated requests with the same access token perform one exchange, and a
   refreshed token performs a new one.
5. On an MCP Apps host, the managed-auth login app opens and its app-only
   tools run after a token refresh.
6. Hold a stream open: it closes when the exchanged token expires and the
   client reconnects.
7. Revoke the grant: the next request is 401 and the client re-authorizes.
8. Clerk OAuth and API-key connections behave as before.
