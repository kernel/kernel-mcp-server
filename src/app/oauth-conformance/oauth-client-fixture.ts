import { expect } from "bun:test";
import { NextRequest } from "next/server";
import type { AuthorizeDependencies } from "@/app/authorize/route";
import type { RegisterDependencies } from "@/app/register/route";
import type { TokenDependencies } from "@/app/token/route";
import type { OAuthAuthorizationContext } from "@/lib/oauth-context";
import { expandLocalhostUris, normalizeLocalhostUri } from "@/lib/auth-utils";
import { oauthProxyCallbackUrl } from "@/lib/oauth-proxy";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";
process.env.NEXT_PUBLIC_CLERK_DOMAIN ??= "clerk.example.test";
process.env.CLERK_SECRET_KEY ??= "clerk-secret";

const { authorizeRequest } = await import("@/app/authorize/route");
const { registerRequest } = await import("@/app/register/route");
const { tokenRequest } = await import("@/app/token/route");
const { GET: oauthCallback } = await import("@/app/oauth/callback/route");
const { deriveS256CodeChallenge } = await import("@/lib/oauth-context");
const { resolveAuthorizationContext } = await import("@/lib/org-utils");

export interface OAuthClientConformanceContract {
  name: string;
  clientName: string;
  redirectUri: string;
  tokenEndpointAuthMethod: "none";
  grantTypes: readonly ["authorization_code", "refresh_token"];
  responseTypes: readonly ["code"];
  scope: "mcp";
  codeChallengeMethod: "S256";
}

export const CODE_VERIFIER = "oauth-conformance-code-verifier";
const CODE_CHALLENGE = deriveS256CodeChallenge(CODE_VERIFIER);

interface TokenSet {
  refreshToken: string;
}

export function formRequest(
  values: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://auth.example.test/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(values),
  });
}

export function createFixture(contract: OAuthClientConformanceContract) {
  const requestContexts = new Map<string, OAuthAuthorizationContext>();
  const requestResources = new Map<string, string>();
  const refreshContexts = new Map<string, OAuthAuthorizationContext>();
  const refreshClientIds = new Map<string, string>();
  const providerRefreshTokens = new Map<string, string>();
  const providerExchanges: URLSearchParams[] = [];
  const persisted: Parameters<TokenDependencies["persistContexts"]>[0][] = [];
  const clientRedirectUris = new Map<string, string[]>();
  let tokenSequence = 0;

  const registerDependencies: RegisterDependencies = {
    createOAuthApplication: async (input) => {
      expect(input).toEqual({
        name: contract.clientName,
        redirectUris: [
          ...expandLocalhostUris([contract.redirectUri]),
          "https://auth.example.test/oauth/callback",
        ],
        scopes: "openid",
        public: true,
      });
      return {
        id: "oauth_app_conformance",
        clientId: "conformance_client",
        clientSecret: null,
      };
    },
    storeRedirectUris: async ({ clientId, redirectUris }) => {
      clientRedirectUris.set(clientId, redirectUris);
    },
  };

  const authorizeDependencies: AuthorizeDependencies = {
    getAuth: async () => ({
      userId: "user_1",
      orgId: "org_1",
      getToken: async () => "clerk-session-token",
    }),
    setRequestContext: async ({
      clientId,
      codeChallenge,
      authorizationContext,
      resource,
    }) => {
      const key = `${clientId}:${codeChallenge}`;
      requestContexts.set(key, authorizationContext);
      requestResources.set(key, resource);
    },
    setClientContext: async () => {
      throw new Error(`${contract.name} must not use non-PKCE authorization`);
    },
    getRedirectUris: async ({ clientId }) =>
      clientRedirectUris.get(clientId) ?? null,
    requireProject: async ({ projectId }) => ({
      id: projectId,
      name: "mason",
      status: "active",
    }),
  };

  const tokenDependencies: TokenDependencies = {
    resolveContext: (input) =>
      resolveAuthorizationContext(input, {
        getRequestContext: async ({ clientId, codeChallenge }) =>
          requestContexts.get(`${clientId}:${codeChallenge}`) ?? null,
        getRequestResource: async ({ clientId, codeChallenge }) =>
          requestResources.get(`${clientId}:${codeChallenge}`) ?? null,
        getClientContext: async () => null,
        getRefreshContext: async ({ refreshToken }) =>
          refreshContexts.get(refreshToken) ?? null,
      }),
    exchange: async (input, init) => {
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      const params = new URLSearchParams(init?.body as URLSearchParams);
      providerExchanges.push(params);

      expect(input.toString()).toBe("https://clerk.example.test/oauth/token");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(params.get("client_id")).toBeTruthy();
      expect(params.get("redirect_uri")).toBeTruthy();

      if (params.get("grant_type") === "authorization_code") {
        expect(params.get("code")).toBe("authorization-code");
        expect(params.get("code_verifier")).toBe(CODE_VERIFIER);
        expect(params.has("refresh_token")).toBe(false);
      } else {
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("refresh_token")).toBeTruthy();
        expect(params.has("code")).toBe(false);
        expect(params.has("code_verifier")).toBe(false);
      }

      const expectedRedirectUri =
        params.get("grant_type") === "authorization_code"
          ? oauthProxyCallbackUrl("https://auth.example.test")
          : normalizeLocalhostUri(contract.redirectUri);
      if (params.get("redirect_uri") !== expectedRedirectUri) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (params.get("client_secret")) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      const presentedRefreshToken = params.get("refresh_token");
      if (
        presentedRefreshToken &&
        refreshClientIds.get(presentedRefreshToken) !== params.get("client_id")
      ) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }

      tokenSequence += 1;
      return Response.json({
        access_token: `provider-access-${tokenSequence}`,
        id_token: `provider-jwt-${tokenSequence}`,
        refresh_token: `refresh-${tokenSequence}`,
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
    verify: async () => ({ sub: "user_1" }),
    hasMembership: async () => true,
    getRedirectUris: async ({ clientId }) =>
      clientRedirectUris.get(clientId) ?? null,
    getProviderRefreshToken: async (refreshToken) =>
      providerRefreshTokens.get(refreshToken) ?? null,
    issueTokens: () => ({
      accessToken: `kmcp_at_${tokenSequence}`,
      refreshToken: `kmcp_rt_${tokenSequence}`,
    }),
    persistContexts: async (value) => {
      persisted.push(value);
      refreshContexts.set(value.publicRefreshToken, value.authorizationContext);
      providerRefreshTokens.set(
        value.publicRefreshToken,
        value.providerRefreshToken,
      );
      const clientId =
        value.consumedRequest?.clientId ??
        (value.oldPublicRefreshToken
          ? refreshClientIds.get(value.oldPublicRefreshToken)
          : undefined);
      if (clientId) {
        refreshClientIds.set(value.providerRefreshToken, clientId);
        refreshClientIds.set(value.publicRefreshToken, clientId);
      }
      if (value.oldPublicRefreshToken) {
        refreshContexts.delete(value.oldPublicRefreshToken);
        providerRefreshTokens.delete(value.oldPublicRefreshToken);
        refreshClientIds.delete(value.oldPublicRefreshToken);
      }
      if (value.consumedRequest) {
        const requestKey = `${value.consumedRequest.clientId}:${value.consumedRequest.codeChallenge}`;
        requestContexts.delete(requestKey);
        requestResources.delete(requestKey);
      }
    },
  };

  async function registerClient(): Promise<string> {
    const response = await registerRequest(
      new NextRequest("https://auth.example.test/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: contract.clientName,
          redirect_uris: [contract.redirectUri],
          token_endpoint_auth_method: contract.tokenEndpointAuthMethod,
          grant_types: contract.grantTypes,
          response_types: contract.responseTypes,
          scope: contract.scope,
        }),
      }),
      registerDependencies,
    );
    expect(response.status).toBe(201);
    const registration = (await response.json()) as {
      client_id: string;
      client_secret?: string;
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
      redirect_uris: string[];
      scope: string;
    };
    expect(registration).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [contract.redirectUri],
      scope: "mcp",
    });
    expect(registration.client_id.length).toBeGreaterThan(0);
    expect(registration.client_secret).toBeUndefined();
    return registration.client_id;
  }

  async function authorize({
    clientId,
    accessScope,
  }: {
    clientId: string;
    accessScope: "organization" | "project";
  }): Promise<void> {
    const state = "oauth-conformance-state";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: contract.redirectUri,
      response_type: "code",
      scope: contract.scope,
      state,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: contract.codeChallengeMethod,
      resource: "https://auth.example.test",
      org_id: "org_1",
      access_scope: accessScope,
      ...(accessScope === "project" ? { project_id: "project_1" } : {}),
    });
    const response = await authorizeRequest(
      new NextRequest(`https://auth.example.test/authorize?${params}`),
      authorizeDependencies,
    );
    expect(response.status).toBe(307);
    const providerUrl = new URL(response.headers.get("location")!);
    expect(providerUrl.searchParams.get("state")).not.toBe(state);
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(
      "https://auth.example.test/oauth/callback",
    );
    expect(providerUrl.searchParams.get("code_challenge")).toBe(CODE_CHALLENGE);
    expect(providerUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(providerUrl.searchParams.get("scope")).toBe("openid");
    expect(providerUrl.searchParams.get("org_id")).toBeNull();
    expect(providerUrl.searchParams.get("access_scope")).toBeNull();
    expect(providerUrl.searchParams.get("project_id")).toBeNull();
    expect(providerUrl.searchParams.get("resource")).toBe(
      "https://auth.example.test",
    );

    const callbackParams = new URLSearchParams({
      code: "authorization-code",
      state: providerUrl.searchParams.get("state")!,
      iss: "https://clerk.example.test",
    });
    const callbackResponse = await oauthCallback(
      new NextRequest(
        `https://auth.example.test/oauth/callback?${callbackParams}`,
      ),
    );
    expect(callbackResponse.status).toBe(302);
    const clientCallback = new URL(callbackResponse.headers.get("location")!);
    expect(clientCallback.origin + clientCallback.pathname).toBe(
      contract.redirectUri,
    );
    expect(clientCallback.searchParams.get("code")).toBe("authorization-code");
    expect(clientCallback.searchParams.get("state")).toBe(state);
    expect(clientCallback.searchParams.get("iss")).toBe(
      "https://auth.example.test",
    );
  }

  async function exchangeCode(clientId: string): Promise<TokenSet> {
    const response = await tokenRequest(
      formRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "authorization-code",
        code_verifier: CODE_VERIFIER,
        redirect_uri: contract.redirectUri,
        resource: "https://auth.example.test",
      }),
      tokenDependencies,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { refresh_token: string };
    return { refreshToken: body.refresh_token };
  }

  return {
    requestContexts,
    requestResources,
    refreshContexts,
    refreshClientIds,
    providerExchanges,
    persisted,
    tokenDependencies,
    registerClient,
    authorize,
    exchangeCode,
  };
}
