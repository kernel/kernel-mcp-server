import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import type { TokenDependencies } from "./route";
import {
  organizationAuthorizationContext,
  projectAuthorizationContext,
} from "@/lib/oauth-context";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";
process.env.NEXT_PUBLIC_CLERK_DOMAIN ??= "clerk.example.test";
process.env.CLERK_SECRET_KEY ??= "clerk-secret";

const { tokenRequest } = await import("./route");

function request(
  values: Record<string, string>,
  origin = "https://auth.example.test",
) {
  return new NextRequest(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

function dependencies({
  authorizationContext = organizationAuthorizationContext({
    clerkUserId: "user_1",
    clerkOrgId: "org_1",
  }),
  subject = "user_1",
  member = true,
  clerkStatus = 200,
  membershipError,
  contextError,
  redirectUris = null,
  providerRefreshToken = "provider-refresh-old",
  requestResource,
  clerkTokens = {
    access_token: "clerk-access",
    id_token: "header.payload.signature",
    refresh_token: "refresh-new",
    expires_in: 3600,
    token_type: "Bearer",
  },
}: {
  authorizationContext?:
    | ReturnType<typeof organizationAuthorizationContext>
    | ReturnType<typeof projectAuthorizationContext>;
  subject?: string;
  member?: boolean;
  clerkStatus?: number;
  membershipError?: Error;
  contextError?: {
    error:
      | "invalid_request"
      | "invalid_grant"
      | "unsupported_grant_type"
      | "server_error";
    status: number;
  };
  redirectUris?: string[] | null;
  providerRefreshToken?: string | null;
  requestResource?: string;
  clerkTokens?: Record<string, unknown>;
} = {}) {
  const calls = {
    resolve: [] as Parameters<TokenDependencies["resolveContext"]>[0][],
    exchanges: [] as URLSearchParams[],
    verifications: [] as string[],
    memberships: [] as Array<{ clerkUserId: string; clerkOrgId: string }>,
    persisted: [] as Parameters<TokenDependencies["persistContexts"]>[0][],
    providerRefreshes: [] as string[],
    outcomes: [] as Parameters<
      NonNullable<TokenDependencies["recordExchange"]>
    >[0][],
  };

  return {
    calls,
    value: {
      resolveContext: async (value) => {
        calls.resolve.push(value);
        if (contextError) {
          return {
            authorizationContext: null,
            error: NextResponse.json(
              { error: contextError.error },
              { status: contextError.status },
            ),
          };
        }
        return {
          authorizationContext,
          ...(value.grantType === "authorization_code"
            ? {
                requestCodeChallenge: "derived-challenge",
                ...(requestResource ? { requestResource } : {}),
              }
            : {}),
        };
      },
      exchange: async (_input, init) => {
        calls.exchanges.push(
          new URLSearchParams(init?.body as URLSearchParams),
        );
        return Response.json(clerkTokens, { status: clerkStatus });
      },
      verify: async (token) => {
        calls.verifications.push(token);
        return { sub: subject };
      },
      hasMembership: async (clerkUserId, clerkOrgId) => {
        calls.memberships.push({ clerkUserId, clerkOrgId });
        if (membershipError) throw membershipError;
        return member;
      },
      getRedirectUris: async () => redirectUris,
      getProviderRefreshToken: async (token) => {
        calls.providerRefreshes.push(token);
        return providerRefreshToken;
      },
      issueTokens: () => ({
        accessToken: "kmcp_at_test",
        refreshToken: "kmcp_rt_test",
      }),
      persistContexts: async (value) => {
        calls.persisted.push(value);
      },
      recordExchange: (value) => {
        calls.outcomes.push(value);
      },
    } satisfies TokenDependencies,
  };
}

describe("POST /token", () => {
  test("issues an organization-wide token and persists both contexts", async () => {
    const deps = dependencies();
    const response = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
        scope: "mcp",
        org_id: "forged-org",
        access_scope: "project",
        project_id: "forged-project",
        refresh_token: "unrelated-refresh",
      }),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      access_token: "kmcp_at_test",
      refresh_token: "kmcp_rt_test",
      org_id: "org_1",
      access_scope: "organization",
    });
    expect(responseBody).not.toHaveProperty("id_token");
    expect(JSON.stringify(responseBody)).not.toContain("clerk-access");
    expect(JSON.stringify(responseBody)).not.toContain(
      "header.payload.signature",
    );
    expect(JSON.stringify(responseBody)).not.toContain("refresh-new");
    expect(deps.calls.persisted).toEqual([
      expect.objectContaining({
        providerJwt: "header.payload.signature",
        publicAccessToken: "kmcp_at_test",
        providerRefreshToken: "refresh-new",
        publicRefreshToken: "kmcp_rt_test",
        resource: "https://auth.example.test",
        authorizationContext: expect.objectContaining({
          access_scope: "organization",
        }),
        consumedRequest: {
          clientId: "client_1",
          codeChallenge: "derived-challenge",
        },
      }),
    ]);
    expect(deps.calls.exchanges[0].has("org_id")).toBe(false);
    expect(deps.calls.exchanges[0].has("project_id")).toBe(false);
    expect(deps.calls.exchanges[0].has("access_scope")).toBe(false);
    expect(deps.calls.exchanges[0].get("scope")).toBe("openid");
    expect(deps.calls.persisted[0]).not.toHaveProperty("oldPublicRefreshToken");
    expect(deps.calls.outcomes).toEqual([
      expect.objectContaining({
        grantType: "authorization_code",
        clientType: "registered_client",
        accessScope: "organization",
        stage: "complete",
        outcome: "success",
        statusCode: 200,
      }),
    ]);
  });

  test("keeps the CLI auth alias on Clerk-issued credentials", async () => {
    const deps = dependencies();
    const response = await tokenRequest(
      request(
        {
          grant_type: "authorization_code",
          client_id: "cli_prod",
          code: "code_1",
          code_verifier: "verifier_1",
          scope: "openid email",
          redirect_uri: "http://localhost:9999/callback",
        },
        "https://auth.onkernel.com",
      ),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: "header.payload.signature",
      refresh_token: "refresh-new",
      id_token: "header.payload.signature",
    });
    expect(deps.calls.exchanges[0].get("scope")).toBe("openid email");
    expect(deps.calls.exchanges[0].get("redirect_uri")).toBe(
      "http://localhost:9999/callback",
    );
    expect(deps.calls.persisted[0]).toMatchObject({
      publicAccessToken: "header.payload.signature",
      publicRefreshToken: "refresh-new",
    });
  });

  test("rejects a token request for a different MCP resource", async () => {
    const deps = dependencies({
      requestResource: "https://auth.example.test/mcp",
    });
    const response = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
        resource: "https://auth.example.test",
      }),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(deps.calls.exchanges).toHaveLength(0);
    expect(deps.calls.persisted).toHaveLength(0);
  });

  test("exchanges proxied codes with the provider callback URI", async () => {
    const redirectUri = "http://localhost:58432/callback";
    const deps = dependencies({ redirectUris: [redirectUri] });
    const response = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
        redirect_uri: redirectUri,
      }),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(deps.calls.exchanges[0].get("redirect_uri")).toBe(
      "https://auth.example.test/oauth/callback",
    );
  });

  test("rejects an unregistered redirect before exchanging a proxied code", async () => {
    const deps = dependencies({
      redirectUris: ["http://localhost:58432/callback"],
    });
    const response = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
        redirect_uri: "http://localhost:9999/callback",
      }),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(deps.calls.exchanges).toHaveLength(0);
  });

  test("returns the server-bound project scope", async () => {
    const deps = dependencies({
      authorizationContext: projectAuthorizationContext({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        projectId: "proj_1",
      }),
    });
    const response = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
      }),
      deps.value,
    );

    expect(await response.json()).toMatchObject({
      org_id: "org_1",
      access_scope: "project",
      project_id: "proj_1",
    });
    expect(deps.calls.outcomes[0]).toMatchObject({
      grantType: "authorization_code",
      clientType: "registered_client",
      accessScope: "project",
      stage: "complete",
      outcome: "success",
    });
  });

  test("refresh preserves stored scope and ignores body escalation", async () => {
    const deps = dependencies({
      authorizationContext: projectAuthorizationContext({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        projectId: "proj_1",
      }),
    });
    const response = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "cli_prod",
        refresh_token: "refresh-old",
        org_id: "org_other",
        access_scope: "organization",
        project_id: "proj_other",
      }),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(deps.calls.resolve[0]).toMatchObject({
      grantType: "refresh_token",
      clientId: "cli_prod",
      refreshToken: "refresh-old",
    });
    expect(deps.calls.persisted).toEqual([
      expect.objectContaining({
        oldPublicRefreshToken: "refresh-old",
        providerRefreshToken: "refresh-new",
        publicRefreshToken: "kmcp_rt_test",
        authorizationContext: expect.objectContaining({
          access_scope: "project",
          project_id: "proj_1",
        }),
      }),
    ]);
    expect(deps.calls.memberships).toEqual([
      { clerkUserId: "user_1", clerkOrgId: "org_1" },
    ]);
    expect(deps.calls.verifications).toHaveLength(0);
    expect(deps.calls.exchanges[0].has("org_id")).toBe(false);
    expect(deps.calls.exchanges[0].has("project_id")).toBe(false);
    expect(deps.calls.outcomes[0]).toMatchObject({
      grantType: "refresh_token",
      clientType: "kernel_cli",
      accessScope: "project",
      stage: "complete",
      outcome: "success",
    });
  });

  test("keeps provider refresh credentials behind the Kernel boundary", async () => {
    const deps = dependencies();
    const response = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "client_1",
        refresh_token: "kmcp_rt_old",
        resource: "https://auth.example.test/",
      }),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(deps.calls.providerRefreshes).toEqual(["kmcp_rt_old"]);
    expect(deps.calls.exchanges[0].get("refresh_token")).toBe(
      "provider-refresh-old",
    );
    expect(await response.json()).toMatchObject({
      access_token: "kmcp_at_test",
      refresh_token: "kmcp_rt_test",
    });
  });

  test("rejects an expired Kernel refresh token before provider exchange", async () => {
    const deps = dependencies({ providerRefreshToken: null });
    const response = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "client_1",
        refresh_token: "kmcp_rt_expired",
      }),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(deps.calls.exchanges).toHaveLength(0);
    expect(deps.calls.persisted).toHaveLength(0);
  });

  test("records the OAuth error returned by context resolution", async () => {
    const deps = dependencies({
      contextError: { error: "server_error", status: 500 },
    });
    const response = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "client_1",
        refresh_token: "refresh-old",
      }),
      deps.value,
    );

    expect(response.status).toBe(500);
    expect(deps.calls.outcomes[0]).toMatchObject({
      stage: "context_resolution",
      outcome: "error",
      errorCode: "server_error",
      statusCode: 500,
    });
  });

  test("checks refresh membership before asking Clerk to rotate", async () => {
    const deps = dependencies({
      membershipError: new Error("clerk unavailable"),
    });
    const response = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "client_1",
        refresh_token: "refresh-old",
      }),
      deps.value,
    );

    expect(response.status).toBe(500);
    expect(deps.calls.exchanges).toHaveLength(0);
    expect(deps.calls.persisted).toHaveLength(0);
    expect(deps.calls.outcomes[0]).toMatchObject({
      grantType: "refresh_token",
      clientType: "registered_client",
      accessScope: "organization",
      stage: "membership_validation",
      outcome: "error",
      errorCode: "server_error",
      statusCode: 500,
    });
  });

  test("keeps post-exchange validation for legacy refresh context", async () => {
    const deps = dependencies({
      authorizationContext: organizationAuthorizationContext({
        clerkOrgId: "org_1",
      }),
    });
    const response = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "client_1",
        refresh_token: "refresh-old",
      }),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(deps.calls.exchanges).toHaveLength(1);
    expect(deps.calls.verifications).toEqual(["header.payload.signature"]);
    expect(deps.calls.memberships).toEqual([
      { clerkUserId: "user_1", clerkOrgId: "org_1" },
    ]);
    expect(deps.calls.persisted[0].authorizationContext).toMatchObject({
      clerk_user_id: "user_1",
      clerk_org_id: "org_1",
      access_scope: "organization",
    });
  });

  test("fails closed on subject and membership mismatches", async () => {
    const wrongSubject = dependencies({ subject: "user_2" });
    const subjectResponse = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
      }),
      wrongSubject.value,
    );
    expect(subjectResponse.status).toBe(400);
    expect(wrongSubject.calls.persisted).toHaveLength(0);

    const removedMember = dependencies({ member: false });
    const memberResponse = await tokenRequest(
      request({
        grant_type: "refresh_token",
        client_id: "client_1",
        refresh_token: "refresh-old",
      }),
      removedMember.value,
    );
    expect(memberResponse.status).toBe(400);
    expect(removedMember.calls.exchanges).toHaveLength(0);
    expect(removedMember.calls.persisted).toHaveLength(0);
  });

  test("does not persist partial context when provider response is invalid", async () => {
    const providerFailure = dependencies({ clerkStatus: 401 });
    const failedResponse = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "bad",
        code_verifier: "verifier_1",
      }),
      providerFailure.value,
    );
    expect(failedResponse.status).toBe(400);
    expect(providerFailure.calls.persisted).toHaveLength(0);
    expect(providerFailure.calls.outcomes[0]).toMatchObject({
      stage: "provider_exchange",
      outcome: "error",
      errorCode: "invalid_grant",
      statusCode: 400,
    });

    const missingRefresh = dependencies({
      clerkTokens: {
        access_token: "clerk-access",
        id_token: "header.payload.signature",
        expires_in: 3600,
        token_type: "Bearer",
      },
    });
    const missingRefreshResponse = await tokenRequest(
      request({
        grant_type: "authorization_code",
        client_id: "client_1",
        code: "code_1",
        code_verifier: "verifier_1",
      }),
      missingRefresh.value,
    );
    expect(missingRefreshResponse.status).toBe(400);
    expect(missingRefresh.calls.persisted).toHaveLength(0);
  });
});
