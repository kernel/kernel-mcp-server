import { expect } from "bun:test";
import { NextRequest } from "next/server";
import type { AuthorizeDependencies } from "@/app/authorize/route";
import type { RegisterDependencies } from "@/app/register/route";
import type { TokenDependencies } from "@/app/token/route";
import type { OAuthAuthorizationContext } from "@/lib/oauth-context";
import { expandLocalhostUris, normalizeLocalhostUri } from "@/lib/auth-utils";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";
process.env.NEXT_PUBLIC_CLERK_DOMAIN ??= "clerk.example.test";
process.env.CLERK_SECRET_KEY ??= "clerk-secret";

const { authorizeRequest } = await import("@/app/authorize/route");
const { registerRequest } = await import("@/app/register/route");
const { tokenRequest } = await import("@/app/token/route");
const { deriveS256CodeChallenge } = await import("@/lib/oauth-context");
const { resolveAuthorizationContext } = await import("@/lib/org-utils");

export interface OAuthClientConformanceContract {
  name: string;
  clientName: string;
  redirectUri: string;
  tokenEndpointAuthMethod: "none";
  grantTypes: readonly ["authorization_code", "refresh_token"];
  responseTypes: readonly ["code"];
  scope: "openid";
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
  const refreshContexts = new Map<string, OAuthAuthorizationContext>();
  const refreshClientIds = new Map<string, string>();
  const providerExchanges: URLSearchParams[] = [];
  const persisted: Parameters<TokenDependencies["persistContexts"]>[0][] = [];
  let tokenSequence = 0;

  const registerDependencies: RegisterDependencies = {
    createOAuthApplication: async (input) => {
      expect(input).toEqual({
        name: contract.clientName,
        redirectUris: expandLocalhostUris([contract.redirectUri]),
        scopes: contract.scope,
        public: true,
      });
      return {
        id: "oauth_app_conformance",
        clientId: "conformance_client",
        clientSecret: null,
      };
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
    }) => {
      requestContexts.set(`${clientId}:${codeChallenge}`, authorizationContext);
    },
    setClientContext: async () => {
      throw new Error(`${contract.name} must not use non-PKCE authorization`);
    },
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

      if (
        params.get("redirect_uri") !==
        normalizeLocalhostUri(contract.redirectUri)
      ) {
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
        id_token: `kernel-jwt-${tokenSequence}`,
        refresh_token: `refresh-${tokenSequence}`,
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
    verify: async () => ({ sub: "user_1" }),
    hasMembership: async () => true,
    persistContexts: async (value) => {
      persisted.push(value);
      refreshContexts.set(value.newRefreshToken, value.authorizationContext);
      const clientId =
        value.consumedRequest?.clientId ??
        (value.oldRefreshToken
          ? refreshClientIds.get(value.oldRefreshToken)
          : undefined);
      if (clientId) refreshClientIds.set(value.newRefreshToken, clientId);
      if (value.oldRefreshToken) {
        refreshContexts.delete(value.oldRefreshToken);
        refreshClientIds.delete(value.oldRefreshToken);
      }
      if (value.consumedRequest) {
        requestContexts.delete(
          `${value.consumedRequest.clientId}:${value.consumedRequest.codeChallenge}`,
        );
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
    expect(response.status).toBe(200);
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
      scope: "openid",
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
    expect(providerUrl.searchParams.get("state")).toBe(state);
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(
      contract.redirectUri,
    );
    expect(providerUrl.searchParams.get("code_challenge")).toBe(CODE_CHALLENGE);
    expect(providerUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(providerUrl.searchParams.get("org_id")).toBeNull();
    expect(providerUrl.searchParams.get("access_scope")).toBeNull();
    expect(providerUrl.searchParams.get("project_id")).toBeNull();
  }

  async function exchangeCode(clientId: string): Promise<TokenSet> {
    const response = await tokenRequest(
      formRequest({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "authorization-code",
        code_verifier: CODE_VERIFIER,
        redirect_uri: contract.redirectUri,
      }),
      tokenDependencies,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { refresh_token: string };
    return { refreshToken: body.refresh_token };
  }

  return {
    requestContexts,
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
