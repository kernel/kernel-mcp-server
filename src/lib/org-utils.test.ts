import { beforeEach, describe, expect, test } from "bun:test";
import {
  type OAuthAuthorizationContext,
  organizationAuthorizationContext,
  projectAuthorizationContext,
} from "./oauth-context";
import type { AuthorizationContextDependencies } from "./org-utils";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";
process.env.OAUTH_LEGACY_NON_PKCE_CLIENT_IDS = "legacy_client";

const { resolveAuthorizationContext } = await import("./org-utils");

let requestContext: OAuthAuthorizationContext | null = null;
let clientContext: OAuthAuthorizationContext | null = null;
let refreshContext: OAuthAuthorizationContext | null = null;
let requestLookup: { clientId: string; codeChallenge: string } | null = null;

const dependencies: AuthorizationContextDependencies = {
  getRequestContext: async (value) => {
    requestLookup = value;
    return requestContext;
  },
  getClientContext: async () => clientContext,
  getRefreshContext: async () => refreshContext,
};

function resolveContext(
  input: Parameters<typeof resolveAuthorizationContext>[0],
) {
  return resolveAuthorizationContext(input, dependencies);
}

beforeEach(() => {
  requestContext = null;
  clientContext = null;
  refreshContext = null;
  requestLookup = null;
});

describe("resolveAuthorizationContext", () => {
  test("uses the PKCE-bound request context", async () => {
    requestContext = projectAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_1",
      projectId: "proj_1",
    });

    const result = await resolveContext({
      grantType: "authorization_code",
      clientId: "client_1",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });

    expect(requestLookup).toEqual({
      clientId: "client_1",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
    expect(result.authorizationContext).toEqual(requestContext);
    expect(result.requestCodeChallenge).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("refresh uses only the refresh-token mapping", async () => {
    refreshContext = projectAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_1",
      projectId: "proj_1",
    });

    const result = await resolveContext({
      grantType: "refresh_token",
      clientId: "cli_prod",
      refreshToken: "refresh-token",
    });

    expect(result.authorizationContext).toEqual(refreshContext);
  });

  test("does not resolve client context outside the legacy allowlist", async () => {
    clientContext = projectAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_1",
      projectId: "proj_1",
    });

    const result = await resolveContext({
      grantType: "authorization_code",
      clientId: "client_1",
    });

    expect(result.authorizationContext).toBeNull();
    expect(result.error?.status).toBe(400);
  });

  test("resolves organization context for an allowlisted legacy client", async () => {
    clientContext = organizationAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_1",
    });

    const result = await resolveContext({
      grantType: "authorization_code",
      clientId: "legacy_client",
    });

    expect(result.authorizationContext).toEqual(clientContext);
  });

  test("rejects project context for an allowlisted legacy client", async () => {
    clientContext = projectAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_1",
      projectId: "proj_1",
    });

    const result = await resolveContext({
      grantType: "authorization_code",
      clientId: "legacy_client",
    });

    expect(result.authorizationContext).toBeNull();
    expect(result.error?.status).toBe(400);
  });

  test("does not fall back to client context when PKCE context is missing", async () => {
    clientContext = projectAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_wrong",
      projectId: "proj_wrong",
    });

    const result = await resolveContext({
      grantType: "authorization_code",
      clientId: "client_1",
      codeVerifier: "verifier",
    });

    expect(result.authorizationContext).toBeNull();
    expect(result.error?.status).toBe(400);
  });

  test("fails when request and refresh context have expired", async () => {
    const authCode = await resolveContext({
      grantType: "authorization_code",
      clientId: "client_1",
      codeVerifier: "verifier",
    });
    expect(authCode.error?.status).toBe(400);

    const refresh = await resolveContext({
      grantType: "refresh_token",
      clientId: "client_1",
      refreshToken: "refresh-token",
    });
    expect(refresh.error?.status).toBe(400);
  });
});
