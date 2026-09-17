# Canonical OAuth discovery release

This change only updates production protected-resource discovery. It does not
move MCP traffic, proxy OAuth requests, modify registrations, or remove
compatibility code. Review approval is not deployment approval.

## Contract

- Resource remains `https://mcp.onkernel.com`; MCP remains hosted at
  `https://mcp.onkernel.com/mcp`.
- `/.well-known/oauth-protected-resource/mcp` advertises
  `authorization_servers: ["https://auth.onkernel.com"]` and canonical
  `/authorize`, `/token`, and `/register` endpoints. Responses use `no-store`.
- Legacy authorization-server metadata and all existing TypeScript OAuth routes,
  picker/consent pages, token verification, and Redis behavior remain unchanged.
  There is no legacy Go relay or MCP DNS change.
- Local, staging, and preview discovery retain their own origin. There is no
  client-specific opt-in discovery header.

## Compatibility dependency

Keeping the legacy routes preserves the existing path for clients that keep
using cached legacy metadata. It does **not** prove that clients discovering the
canonical issuer will discard an old registration or keep using existing tokens.

Go authorization requires a durable registration bound to its issuer alias and
redirect, apart from the static CLI overlay. A Clerk-only registration is not
implicitly imported; an unknown or wrong-issuer registration returns
`invalid_request`. A canonical registration cannot simply be reused under the
legacy Go issuer. Fresh registration/login tests do not establish cached-client
recovery. Before rollout, resolve the isolated cached-client compatibility result
and its supported recovery procedure, including clients already using the auth
hostname. Do not add a Clerk fallback, bulk import, registration cleanup, or
cross-issuer retry as part of this deployment.

Existing credentials must remain available: preserve Clerk applications, durable
registrations, static clients, shared token context, and both issuer endpoints.
Token validation and refresh behavior are unchanged by this metadata update.

## Forward deployment order

1. Obtain explicit release approval after the applicable acceptance checks and
   cached-client compatibility result. Record current auth DNS, parsed metadata,
   deployed revisions, and the verified rollback target. Confirm the canonical
   Go service, registry, shared token context, static CLI overlay, dashboard
   picker/consent, and canonical Clerk callback are usable. Keep the existing
   MCP deployment and all legacy routes in service.
2. Merge/apply the separately reviewed **auth DNS-only** change to the existing
   production API load balancer. Leave MCP DNS on Vercel. Verify public auth
   DNS/TLS convergence, canonical issuer/endpoints, and callback reachability.
   With the current 300-second TTL, allow two observed TTLs (10 minutes); recheck
   the actual TTL and public resolvers at execution time. During this interval,
   MCP discovery still advertises the working legacy TypeScript path.
3. Only after step 2 is verified, merge/deploy this MCP PR. Treat merging as a
   possible production deployment. Verify canonical protected-resource metadata,
   unchanged resource identity, unchanged legacy authorization-server metadata
   and routes, and the agreed cached-client outcome.

Discovery-first is not safe merely because the auth hostname already resolves:
that hostname must serve the intended canonical service and callbacks, not the
old deployment. DNS-first also requires accounting for cached clients that
already use the auth hostname; keeping MCP legacy routes cannot protect those
clients from an auth DNS change.

## Reverse deployment order

1. On current main, prepare a focused corrective PR that changes only the
   production discovery selection in `src/lib/oauth-discovery.ts` back to
   `MCP_ORIGIN`, and updates its test. Deploy that change first; verify the served
   protected-resource JSON advertises only the legacy origin again. Retain
   `no-store`, resource identity, and all existing routes. Do not reset main,
   revert unrelated commits, or promote an old whole MCP deployment.
2. Keep auth DNS on Go while accounting for cached canonical registrations and
   in-flight Go authorizations/codes. Metadata rollback affects future discovery;
   it cannot erase cached issuers or registrations. The old TypeScript token
   endpoint cannot redeem Go broker codes, and its authorization responses do not
   provide the same issuer binding. Before a DNS rollback, establish a supported
   recovery/drain procedure or explicitly accept and communicate interrupted
   logins. Do not imply that metadata rollback alone restores every client.
3. If auth DNS rollback is still required and separately approved, change only
   the auth record to its captured prior Vercel target in current infrastructure
   main. Require a fresh one-record-update preview and review; keep MCP DNS,
   certificates, listeners, and other concurrent work unchanged. Apply, wait two
   observed TTLs, and verify public routing plus the retained auth deployment.
   Preserve registration and credential data; rollback requires no data cleanup.

If the failure occurs before step 3 of the forward sequence, MCP discovery needs
no rollback: it still points at the legacy service. Auth DNS rollback still has
the cached-canonical/in-flight constraints above.
