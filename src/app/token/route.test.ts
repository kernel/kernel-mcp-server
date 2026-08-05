import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
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

function request(values: Record<string, string>) {
  return new NextRequest("https://auth.example.test/token", {
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
  clerkTokens?: Record<string, unknown>;
} = {}) {
  const calls = {
    resolve: [] as Parameters<TokenDependencies["resolveContext"]>[0][],
    exchanges: [] as URLSearchParams[],
    jwt: [] as Parameters<TokenDependencies["setJwtContext"]>[0][],
    refresh: [] as Parameters<TokenDependencies["setRefreshContext"]>[0][],
    rotate: [] as Parameters<TokenDependencies["rotateRefreshContext"]>[0][],
    deleted: [] as Parameters<TokenDependencies["deleteRequestContext"]>[0][],
  };

  return {
    calls,
    value: {
      resolveContext: async (value) => {
        calls.resolve.push(value);
        return {
          authorizationContext,
          ...(value.grantType === "authorization_code"
            ? { requestCodeChallenge: "derived-challenge" }
            : {}),
        };
      },
      exchange: async (_input, init) => {
        calls.exchanges.push(
          new URLSearchParams(init?.body as URLSearchParams),
        );
        return Response.json(clerkTokens, { status: clerkStatus });
      },
      verify: async () => ({ sub: subject }),
      hasMembership: async () => member,
      setJwtContext: async (value) => {
        calls.jwt.push(value);
      },
      setRefreshContext: async (value) => {
        calls.refresh.push(value);
      },
      rotateRefreshContext: async (value) => {
        calls.rotate.push(value);
      },
      deleteRequestContext: async (value) => {
        calls.deleted.push(value);
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
        org_id: "forged-org",
        access_scope: "project",
        project_id: "forged-project",
      }),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: "header.payload.signature",
      refresh_token: "refresh-new",
      org_id: "org_1",
      access_scope: "organization",
    });
    expect(deps.calls.jwt).toHaveLength(1);
    expect(deps.calls.refresh).toHaveLength(1);
    expect(deps.calls.deleted).toEqual([
      { clientId: "client_1", codeChallenge: "derived-challenge" },
    ]);
    expect(deps.calls.exchanges[0].has("org_id")).toBe(false);
    expect(deps.calls.exchanges[0].has("project_id")).toBe(false);
    expect(deps.calls.exchanges[0].has("access_scope")).toBe(false);
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
    expect(deps.calls.rotate).toEqual([
      expect.objectContaining({
        oldRefreshToken: "refresh-old",
        newRefreshToken: "refresh-new",
        authorizationContext: expect.objectContaining({
          access_scope: "project",
          project_id: "proj_1",
        }),
      }),
    ]);
    expect(deps.calls.exchanges[0].has("org_id")).toBe(false);
    expect(deps.calls.exchanges[0].has("project_id")).toBe(false);
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
    expect(wrongSubject.calls.jwt).toHaveLength(0);

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
    expect(removedMember.calls.rotate).toHaveLength(0);
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
    expect(providerFailure.calls.jwt).toHaveLength(0);

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
    expect(missingRefresh.calls.jwt).toHaveLength(0);
  });
});
