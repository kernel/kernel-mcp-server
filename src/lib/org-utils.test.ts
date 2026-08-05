import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type OAuthAuthorizationContext,
  projectAuthorizationContext,
} from "./oauth-context";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";

let requestContext: OAuthAuthorizationContext | null = null;
let clientContext: OAuthAuthorizationContext | null = null;
let refreshContext: OAuthAuthorizationContext | null = null;
let requestLookup: { clientId: string; codeChallenge: string } | null = null;

mock.module("./redis", () => ({
  getAuthorizationContextForRequest: async (value: {
    clientId: string;
    codeChallenge: string;
  }) => {
    requestLookup = value;
    return requestContext;
  },
  getAuthorizationContextForClientId: async () => clientContext,
  getAuthorizationContextForRefreshTokenSliding: async () => refreshContext,
}));

const { resolveAuthorizationContext } = await import("./org-utils");

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

    const result = await resolveAuthorizationContext({
      grantType: "authorization_code",
      clientId: "client_1",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });

    expect(requestLookup).toEqual({
      clientId: "client_1",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
    expect(result.authorizationContext).toEqual(requestContext);
    expect(result.requestCodeChallenge).toBe(requestLookup.codeChallenge);
  });

  test("refresh uses only the refresh-token mapping", async () => {
    refreshContext = projectAuthorizationContext({
      clerkUserId: "user_1",
      clerkOrgId: "org_1",
      projectId: "proj_1",
    });

    const result = await resolveAuthorizationContext({
      grantType: "refresh_token",
      clientId: "cli_prod",
      refreshToken: "refresh-token",
    });

    expect(result.authorizationContext).toEqual(refreshContext);
  });

  test("shared clients cannot supply authorization context directly", async () => {
    const result = await resolveAuthorizationContext({
      grantType: "authorization_code",
      clientId: "cli_prod",
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

    const result = await resolveAuthorizationContext({
      grantType: "authorization_code",
      clientId: "client_1",
      codeVerifier: "verifier",
    });

    expect(result.authorizationContext).toBeNull();
    expect(result.error?.status).toBe(400);
  });

  test("fails when request and refresh context have expired", async () => {
    const authCode = await resolveAuthorizationContext({
      grantType: "authorization_code",
      clientId: "client_1",
      codeVerifier: "verifier",
    });
    expect(authCode.error?.status).toBe(400);

    const refresh = await resolveAuthorizationContext({
      grantType: "refresh_token",
      clientId: "client_1",
      refreshToken: "refresh-token",
    });
    expect(refresh.error?.status).toBe(400);
  });
});
