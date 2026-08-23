# OAuth conformance

The required CI suite includes a Vercel Connect fixture for Kernel's hosted OAuth server. It models the Custom OAuth contract documented by Vercel rather than a separate Kernel-specific protocol.

## Vercel Connect contract

Vercel documents Custom OAuth connectors as follows:

- the connector discovers authorization, token, registration, PKCE, scope, and grant metadata from the provider's server URL;
- Vercel Connect owns client registration, PKCE, state validation, the callback handshake, refresh-token storage, and refresh;
- user authorization uses the authorization-code flow;
- the connector configuration records its exact redirect URI, token-endpoint authentication method, PKCE requirement, challenge method, user scopes, and refresh-token support.

Sources:

- [Vercel Connect connectors](https://vercel.com/docs/connect/concepts/connectors)
- [Vercel Connect authentication](https://vercel.com/docs/connect/concepts/authentication)
- [Create a connector API](https://vercel.com/docs/rest-api/connect/create-a-connector)
- [`connectAuthProvider` implementation](https://github.com/vercel/vercel/blob/17d9ebaf8e9b335d550dea1a243743a74edc772e/packages/connect/src/mcp/connect-auth-provider.ts)

The fixture uses a public client (`token_endpoint_auth_method=none`), authorization code plus refresh grants, the `mcp` resource scope, RFC 8707 resource binding, and S256 PKCE. Kernel restores the client's exact `state` after the upstream identity callback and returns its public issuer as required by RFC 9207.

## Covered behavior

`src/app/oauth-conformance/vercel-connect.test.ts` verifies:

- OAuth server discovery advertises registration, authorization-code exchange, refresh, and S256 PKCE;
- dynamic registration creates a public client without a secret;
- organization-wide and project-scoped authorization both complete;
- refresh rotation preserves the original organization or project boundary;
- token request fields cannot change the stored organization or scope;
- wrong PKCE verifiers fail before the provider exchange;
- redirect mismatches and invalid public-client authentication fail without persisting token context;
- OAuth state, redirect URI, and PKCE parameters survive the Kernel-to-Clerk redirect unchanged.

CI runs the suite through the repository's required `bun test` check.

## Run locally

```bash
bun test src/app/oauth-conformance/vercel-connect.test.ts
```

The checked-in redirect uses the reserved `.test` domain. To replay the same suite with the redirect URI returned by a staging Vercel connector:

```bash
VERCEL_CONNECT_REDIRECT_URI='https://<vercel-returned-redirect>' \
  bun test src/app/oauth-conformance/vercel-connect.test.ts
```

## Confirm a live Vercel connector

Before treating Vercel Connect as a supported consumer:

1. Create a staging Custom OAuth connector using Kernel's staging MCP server URL and Vercel Assisted Setup.
2. Record the connector response's `redirectUri`, `tokenEndpointAuthMethod`, `pkceRequired`, `codeChallengeMethod`, enabled user scopes, and refresh setting.
3. Compare those non-secret values with the fixture. Run the suite with `VERCEL_CONNECT_REDIRECT_URI` set to the returned URI.
4. Complete organization-wide and project-scoped grants and confirm harmless Kernel reads.
5. Refresh each grant and confirm the original scope remains enforced.

Do not commit connector credentials, authorization codes, access tokens, refresh tokens, PKCE verifiers, state, or complete authorization URLs.
