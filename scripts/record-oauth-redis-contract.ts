// Records the exact Redis contract the OAuth endpoints produce for a fixed
// set of logins: key names, HMAC key derivations, stored values, and TTLs
// are dumped to fixtures/oauth-redis-recordings.json. CI regenerates this
// file and fails on any diff, so a change to token persistence shows up as
// a reviewable fixture change instead of silently remapping live tokens.
//
// Usage:
//   bun scripts/record-oauth-redis-contract.ts
//
// Requires a disposable Redis: every key in the selected database is
// flushed between scenarios. Point it at an isolated instance with
// OAUTH_RECORDING_REDIS_URL (default redis://127.0.0.1:6379/15).

// Hard-assign every environment input the OAuth code reads instead of
// inheriting ambient values: recordings must be reproducible, and an
// inherited REDIS_URL could point the flushes below at real data.
const recordingRedisUrl =
  process.env.OAUTH_RECORDING_REDIS_URL ?? "redis://127.0.0.1:6379/15";
if (!new URL(recordingRedisUrl).pathname.endsWith("/15")) {
  throw new Error(
    "OAUTH_RECORDING_REDIS_URL must select database 15: this script flushes it between scenarios",
  );
}
process.env.REDIS_URL = recordingRedisUrl;
process.env.CLERK_SECRET_KEY = "sk_test_recording_fixture";
process.env.NEXT_PUBLIC_CLERK_DOMAIN = "clerk.recording.invalid";
process.env.KERNEL_CLI_PROD_CLIENT_ID = "rec_cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID = "rec_cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID = "rec_cli_dev";
process.env.OAUTH_LEGACY_NON_PKCE_CLIENT_IDS = "rec_legacy_client";

import type { NextResponse } from "next/server";
import type { TokenDependencies } from "@/app/token/route";
import type { AuthorizeDependencies } from "@/app/authorize/route";

const { NextRequest } = await import("next/server");
const { tokenRequest } = await import("@/app/token/route");
const { authorizeRequest } = await import("@/app/authorize/route");
const { deriveS256CodeChallenge, organizationAuthorizationContext } =
  await import("@/lib/oauth-context");
const { resolveAuthorizationContext } = await import("@/lib/org-utils");
const { REFRESH_TOKEN_ORG_TTL_SECONDS } = await import("@/lib/const");
const {
  persistOAuthTokenContexts,
  setAuthorizationContextForClientId,
  setAuthorizationContextForRequest,
  redisClient,
} = await import("@/lib/redis");

// Pinned inputs. Every value is fake and exists only so that HMAC hashes,
// serialization, and TTLs are identical on every run.
const PKCE_CLIENT_ID = "rec_pkce_client";
const PROJECT_CLIENT_ID = "rec_project_client";
const LEGACY_CLIENT_ID = "rec_legacy_client";
const CODE_VERIFIER = "recording-code-verifier-0123456789abcdef";
const CODE_CHALLENGE = deriveS256CodeChallenge(CODE_VERIFIER);
const USER_ID = "user_rec_1";
const ORG_ID = "org_rec_1";
const PROJECT_ID = "proj_rec_1";
const CLERK_SESSION_TOKEN = "rec-clerk-session-token";
const EXPIRES_IN_SECONDS = 3600;

interface ClerkTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

const clerkResponses: Record<string, ClerkTokens> = {
  authorization_code_organization: {
    access_token: "rec-clerk-access-token-org",
    id_token: "rec-id-token-org-v1",
    refresh_token: "rec-refresh-initial-org-v1",
    expires_in: EXPIRES_IN_SECONDS,
    token_type: "Bearer",
  },
  authorization_code_project: {
    access_token: "rec-clerk-access-token-project",
    id_token: "rec-id-token-project-v1",
    refresh_token: "rec-refresh-initial-project-v1",
    expires_in: EXPIRES_IN_SECONDS,
    token_type: "Bearer",
  },
  refresh_after_org_grant: {
    access_token: "rec-clerk-access-token-refresh",
    id_token: "rec-id-token-after-refresh-v1",
    refresh_token: "rec-refresh-rotated-v1",
    expires_in: EXPIRES_IN_SECONDS,
    token_type: "Bearer",
  },
  legacy_non_pkce_exchange: {
    access_token: "rec-clerk-access-token-legacy",
    id_token: "rec-id-token-legacy-v1",
    refresh_token: "rec-refresh-legacy-grant-v1",
    expires_in: EXPIRES_IN_SECONDS,
    token_type: "Bearer",
  },
  refresh_after_backfill_seed: {
    access_token: "rec-clerk-access-token-backfill",
    id_token: "rec-id-token-backfill-v1",
    refresh_token: "rec-refresh-backfill-rotated-v1",
    expires_in: EXPIRES_IN_SECONDS,
    token_type: "Bearer",
  },
};

interface Snapshot {
  after: string;
  keys: { key: string; value: string; ttl_seconds: number }[];
}

async function snapshot(after: string): Promise<Snapshot> {
  const keys = (await redisClient.keys("*")).sort();
  return {
    after,
    keys: await Promise.all(
      keys.map(async (key) => ({
        key,
        value: (await redisClient.get(key))!,
        ttl_seconds: await redisClient.ttl(key),
      })),
    ),
  };
}

function tokenDependencies(clerkTokens: ClerkTokens): TokenDependencies {
  return {
    exchange: async () => Response.json(clerkTokens),
    resolveContext: resolveAuthorizationContext,
    verify: async () => ({ sub: USER_ID }),
    hasMembership: async () => true,
    persistContexts: persistOAuthTokenContexts,
  };
}

function authorizeDependencies(): AuthorizeDependencies {
  return {
    getAuth: async () => ({
      userId: USER_ID,
      orgId: ORG_ID,
      getToken: async () => CLERK_SESSION_TOKEN,
    }),
    setRequestContext: setAuthorizationContextForRequest,
    setClientContext: setAuthorizationContextForClientId,
    requireProject: async () => ({
      id: PROJECT_ID,
      name: "recording project",
      status: "active",
    }),
  };
}

async function runToken(
  body: Record<string, string>,
  dependencies: TokenDependencies,
): Promise<void> {
  const request = new NextRequest("https://auth.recording.invalid/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const response: NextResponse = await tokenRequest(request, dependencies);
  if (response.status !== 200) {
    throw new Error(
      `token exchange failed with ${response.status}: ${await response.text()}`,
    );
  }
}

async function authorize(query: Record<string, string>): Promise<void> {
  const request = new NextRequest(
    `https://auth.recording.invalid/authorize?${new URLSearchParams({
      org_id: ORG_ID,
      ...query,
    })}`,
  );
  const response = await authorizeRequest(request, authorizeDependencies());
  if (response.status !== 307) {
    throw new Error(
      `authorize redirected to ${response.status}: ${await response.text()}`,
    );
  }
}

function exchangeCode(
  clientId: string,
  clerkTokens: ClerkTokens,
  codeVerifier?: string,
): Promise<void> {
  return runToken(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code: "rec-code",
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    },
    tokenDependencies(clerkTokens),
  );
}

const pkceQuery = {
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
};

interface Scenario {
  name: string;
  description: string;
  run: () => Promise<Snapshot[]>;
}

const scenarios: Scenario[] = [
  {
    name: "authorization_code_org_scoped_pkce",
    description:
      "PKCE authorization for an organization-wide scope: authorize stores the oauth-request context, the code exchange consumes it and persists jwt/refresh mappings.",
    run: async () => {
      await authorize({
        client_id: PKCE_CLIENT_ID,
        access_scope: "organization",
        ...pkceQuery,
      });
      const afterAuthorize = await snapshot("after_authorize");
      await exchangeCode(
        PKCE_CLIENT_ID,
        clerkResponses.authorization_code_organization!,
        CODE_VERIFIER,
      );
      return [afterAuthorize, await snapshot("after_token_exchange")];
    },
  },
  {
    name: "authorization_code_project_scoped_pkce",
    description:
      "Same as above but the selected scope is a single project, so the persisted context carries project_id.",
    run: async () => {
      await authorize({
        client_id: PROJECT_CLIENT_ID,
        access_scope: "project",
        project_id: PROJECT_ID,
        ...pkceQuery,
      });
      const afterAuthorize = await snapshot("after_authorize");
      await exchangeCode(
        PROJECT_CLIENT_ID,
        clerkResponses.authorization_code_project!,
        CODE_VERIFIER,
      );
      return [afterAuthorize, await snapshot("after_token_exchange")];
    },
  },
  {
    name: "refresh_token_rotation_sliding_ttl",
    description:
      "An initial org-scoped grant is followed by a refresh_token grant: the old refresh mapping is deleted, the rotated one is written with a fresh sliding TTL.",
    run: async () => {
      await authorize({
        client_id: PKCE_CLIENT_ID,
        access_scope: "organization",
        ...pkceQuery,
      });
      await exchangeCode(
        PKCE_CLIENT_ID,
        clerkResponses.authorization_code_organization!,
        CODE_VERIFIER,
      );
      const afterInitialGrant = await snapshot(
        "after_initial_authorization_code_grant",
      );
      await runToken(
        {
          grant_type: "refresh_token",
          client_id: PKCE_CLIENT_ID,
          refresh_token:
            clerkResponses.authorization_code_organization!.refresh_token,
        },
        tokenDependencies(clerkResponses.refresh_after_org_grant!),
      );
      return [afterInitialGrant, await snapshot("after_refresh_grant")];
    },
  },
  {
    name: "legacy_non_pkce_client",
    description:
      "A allowlisted legacy client without PKCE: authorize stores the context under the literal client:<client_id> key, which its exchanges read.",
    run: async () => {
      await authorize({
        client_id: LEGACY_CLIENT_ID,
        access_scope: "organization",
      });
      const afterAuthorize = await snapshot("after_authorize");
      await exchangeCode(
        LEGACY_CLIENT_ID,
        clerkResponses.legacy_non_pkce_exchange!,
      );
      return [afterAuthorize, await snapshot("after_token_exchange")];
    },
  },
  {
    name: "refresh_backfills_clerk_user_id_from_id_token",
    description:
      "A pre-existing context without clerk_user_id (stored by older versions) is refreshed: the id_token subject is backfilled into the newly written contexts.",
    run: async () => {
      await persistOAuthTokenContexts({
        jwt: "rec-id-token-seed-v1",
        newRefreshToken: "rec-refresh-seed-v1",
        authorizationContext: organizationAuthorizationContext({
          clerkOrgId: ORG_ID,
        }),
        jwtTtlSeconds: EXPIRES_IN_SECONDS,
        refreshTtlSeconds: REFRESH_TOKEN_ORG_TTL_SECONDS,
      });
      const afterSeed = await snapshot("after_seeding_legacy_contexts");
      await runToken(
        {
          grant_type: "refresh_token",
          client_id: PKCE_CLIENT_ID,
          refresh_token: "rec-refresh-seed-v1",
        },
        tokenDependencies(clerkResponses.refresh_after_backfill_seed!),
      );
      return [afterSeed, await snapshot("after_refresh_grant")];
    },
  },
];

async function main(): Promise<void> {
  await redisClient.connect();
  const recordedScenarios = [];
  let keyCount = 0;
  for (const scenario of scenarios) {
    await redisClient.flushDb();
    const snapshots = await scenario.run();
    keyCount += snapshots.at(-1)!.keys.length;
    recordedScenarios.push({
      name: scenario.name,
      description: scenario.description,
      snapshots,
    });
  }
  await redisClient.flushDb();

  const recording = {
    meta: {
      purpose:
        "Golden fixtures of the Redis state written by the OAuth /authorize and /token endpoints for fixed logins. Key names, HMAC derivations, stored values, and TTLs must stay byte-identical unless a diff is reviewed deliberately.",
      regeneration: {
        command: "bun scripts/record-oauth-redis-contract.ts",
        enforcement:
          "CI regenerates this file and fails when it differs from what is committed.",
        redis:
          "Isolated disposable Redis; database 15 is flushed between scenarios.",
        ttl_note:
          "ttl_seconds is read back from Redis immediately after each step; Redis rounds to the nearest second, so treat an off-by-one as timing noise.",
      },
      key_derivations: {
        "jwt:<hmac>": "HMAC-SHA256(CLERK_SECRET_KEY, access token), hex digest",
        "refresh:<hmac>":
          "HMAC-SHA256(CLERK_SECRET_KEY, refresh token), hex digest",
        "oauth-request:<hmac>":
          "HMAC-SHA256(CLERK_SECRET_KEY, '<client_id>:<code_challenge>'), hex digest",
        "client:<client_id>":
          "Legacy allowlisted clients only; the client id is used literally, not hashed.",
      },
      pinned_inputs: {
        environment: {
          CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
          NEXT_PUBLIC_CLERK_DOMAIN: process.env.NEXT_PUBLIC_CLERK_DOMAIN,
          KERNEL_CLI_PROD_CLIENT_ID: process.env.KERNEL_CLI_PROD_CLIENT_ID,
          KERNEL_CLI_STAGING_CLIENT_ID:
            process.env.KERNEL_CLI_STAGING_CLIENT_ID,
          KERNEL_CLI_DEV_CLIENT_ID: process.env.KERNEL_CLI_DEV_CLIENT_ID,
          OAUTH_LEGACY_NON_PKCE_CLIENT_IDS:
            process.env.OAUTH_LEGACY_NON_PKCE_CLIENT_IDS,
        },
        identifiers: {
          pkce_client_id: PKCE_CLIENT_ID,
          project_client_id: PROJECT_CLIENT_ID,
          legacy_client_id: LEGACY_CLIENT_ID,
          clerk_user_id: USER_ID,
          clerk_org_id: ORG_ID,
          project_id: PROJECT_ID,
          clerk_session_token: CLERK_SESSION_TOKEN,
          seed_id_token: "rec-id-token-seed-v1",
          seed_refresh_token: "rec-refresh-seed-v1",
        },
        pkce: {
          code_verifier: CODE_VERIFIER,
          code_challenge: CODE_CHALLENGE,
          note: "code_challenge is base64url(SHA-256(code_verifier)) with no padding.",
        },
        clerk_responses: clerkResponses,
        context_serialization:
          "Stored values are JSON strings whose field order follows the writer: version, clerk_user_id?, clerk_org_id, access_scope[, project_id].",
      },
      coverage: scenarios.map(
        (scenario) => `${scenario.name}: ${scenario.description}`,
      ),
    },
    scenarios: recordedScenarios,
  };

  const prettier = await import("prettier");
  const contents = await prettier.format(JSON.stringify(recording, null, 2), {
    parser: "json",
  });
  const fixturePath = new URL(
    "../fixtures/oauth-redis-recordings.json",
    import.meta.url,
  ).pathname;
  await Bun.write(fixturePath, contents);
  console.log(
    `Recorded ${scenarios.length} scenarios (${keyCount} final keys) to ${fixturePath}`,
  );
}

await main();
await redisClient.disconnect();
