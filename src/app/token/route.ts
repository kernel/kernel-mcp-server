import { clerkClient, verifyToken } from "@clerk/nextjs/server";
import { after, NextRequest, NextResponse } from "next/server";
import {
  getOAuthClientRedirectUris,
  getOAuthProviderRefreshToken,
  persistOAuthTokenContexts,
} from "@/lib/redis";
import { resolveAuthorizationContext } from "@/lib/org-utils";
import { REFRESH_TOKEN_ORG_TTL_SECONDS } from "@/lib/const";
import { normalizeLocalhostUri } from "@/lib/auth-utils";
import {
  captureOAuthTokenExchange,
  flushMcpAnalytics,
  type OAuthTokenExchangeAnalytics,
} from "@/lib/mcp/analytics";
import { oauthProxyCallbackUrl } from "@/lib/oauth-proxy";
import { resolveOAuthResource } from "@/lib/oauth-resource";
import {
  isKernelOAuthRefreshToken,
  issueKernelOAuthTokens,
} from "@/lib/oauth-tokens";
import {
  CLERK_OAUTH_SCOPE,
  validatePublicOAuthScope,
} from "@/lib/oauth-scopes";
import { isMcpAuthorizationServer } from "@/lib/oauth-server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

interface ClerkTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  id_token?: string;
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type OAuthErrorCode = NonNullable<OAuthTokenExchangeAnalytics["errorCode"]>;

function createErrorResponse(
  error: OAuthErrorCode,
  errorDescription: string,
  status = 400,
) {
  return NextResponse.json(
    { error, error_description: errorDescription },
    { status, headers: CORS_HEADERS },
  );
}

function clientCredentials(
  request: NextRequest,
  body: FormData,
  params: URLSearchParams,
): { clientId: string | null } {
  let clientId = body.get("client_id")?.toString() || null;
  let clientSecret = body.get("client_secret")?.toString() || null;

  if (!clientId) {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        const colonIndex = decoded.indexOf(":");
        if (colonIndex !== -1) {
          clientId = decodeURIComponent(decoded.slice(0, colonIndex));
          clientSecret = decodeURIComponent(decoded.slice(colonIndex + 1));
          params.set("client_id", clientId);
          if (clientSecret) params.set("client_secret", clientSecret);
        }
      } catch {
        // Missing client_id is returned below.
      }
    }
  }

  return { clientId };
}

async function hasOrganizationMembership(
  clerkUserId: string,
  clerkOrgId: string,
): Promise<boolean> {
  const clerk = await clerkClient();
  let offset = 0;
  const limit = 100;

  for (;;) {
    const memberships = await clerk.users.getOrganizationMembershipList({
      userId: clerkUserId,
      limit,
      offset,
    });
    if (
      memberships.data.some(
        (membership) => membership.organization.id === clerkOrgId,
      )
    ) {
      return true;
    }
    offset += memberships.data.length;
    if (memberships.data.length === 0 || offset >= memberships.totalCount) {
      return false;
    }
  }
}

type Fetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface TokenDependencies {
  exchange: Fetcher;
  resolveContext: typeof resolveAuthorizationContext;
  verify: (
    token: string,
    options: { secretKey?: string },
  ) => Promise<{ sub?: string }>;
  hasMembership: typeof hasOrganizationMembership;
  getRedirectUris: (input: {
    clientId: string;
    issuer: string;
  }) => Promise<string[] | null>;
  getProviderRefreshToken: typeof getOAuthProviderRefreshToken;
  issueTokens: typeof issueKernelOAuthTokens;
  persistContexts: typeof persistOAuthTokenContexts;
  recordExchange?: (exchange: OAuthTokenExchangeAnalytics) => void;
}

const tokenDependencies: TokenDependencies = {
  exchange: fetch,
  resolveContext: resolveAuthorizationContext,
  verify: verifyToken,
  hasMembership: hasOrganizationMembership,
  getRedirectUris: async ({ clientId }) => getOAuthClientRedirectUris(clientId),
  getProviderRefreshToken: getOAuthProviderRefreshToken,
  issueTokens: issueKernelOAuthTokens,
  persistContexts: persistOAuthTokenContexts,
  recordExchange: captureOAuthTokenExchange,
};

function clientType(
  clientId: string | null,
): OAuthTokenExchangeAnalytics["clientType"] {
  if (!clientId) return "unknown";
  const cliClientIds = [
    process.env.KERNEL_CLI_PROD_CLIENT_ID,
    process.env.KERNEL_CLI_STAGING_CLIENT_ID,
    process.env.KERNEL_CLI_DEV_CLIENT_ID,
  ].filter(Boolean);
  return cliClientIds.includes(clientId) ? "kernel_cli" : "registered_client";
}

function normalizedGrantType(
  grantType: string,
): OAuthTokenExchangeAnalytics["grantType"] {
  return grantType === "authorization_code" || grantType === "refresh_token"
    ? grantType
    : "unknown";
}

async function oauthErrorCode(response: NextResponse): Promise<OAuthErrorCode> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (
      body.error === "invalid_request" ||
      body.error === "invalid_grant" ||
      body.error === "unsupported_grant_type" ||
      body.error === "server_error"
    ) {
      return body.error;
    }
  } catch {
    // Fall back to the status without logging the response body.
  }
  return response.status >= 500 ? "server_error" : "invalid_grant";
}

export async function tokenRequest(
  request: NextRequest,
  dependencies: TokenDependencies = tokenDependencies,
): Promise<NextResponse> {
  const startedAt = Date.now();
  const mcpAuthorizationServer = isMcpAuthorizationServer(
    request.nextUrl.origin,
  );
  let grantTypeForAnalytics: OAuthTokenExchangeAnalytics["grantType"] =
    "unknown";
  let clientTypeForAnalytics: OAuthTokenExchangeAnalytics["clientType"] =
    "unknown";
  let accessScopeForAnalytics: OAuthTokenExchangeAnalytics["accessScope"] =
    "unknown";
  let stage: OAuthTokenExchangeAnalytics["stage"] = "request_validation";

  const finish = (
    response: NextResponse,
    errorCode?: OAuthErrorCode,
  ): NextResponse => {
    try {
      dependencies.recordExchange?.({
        grantType: grantTypeForAnalytics,
        clientType: clientTypeForAnalytics,
        accessScope: accessScopeForAnalytics,
        stage,
        outcome: response.ok ? "success" : "error",
        ...(errorCode ? { errorCode } : {}),
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("Failed to record OAuth token exchange outcome", error);
    }
    return response;
  };
  const fail = (
    error: OAuthErrorCode,
    description: string,
    status = 400,
  ): NextResponse =>
    finish(createErrorResponse(error, description, status), error);

  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/x-www-form-urlencoded")) {
    return fail(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded",
    );
  }

  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;
  if (!clerkDomain) {
    return fail("server_error", "Server configuration error", 500);
  }

  const body = await request.formData();
  const params = new URLSearchParams();
  for (const [key, value] of body.entries()) {
    params.append(
      key,
      key === "redirect_uri"
        ? normalizeLocalhostUri(value.toString())
        : value.toString(),
    );
  }

  const grantType = body.get("grant_type")?.toString() || "";
  grantTypeForAnalytics = normalizedGrantType(grantType);
  const { clientId } = clientCredentials(request, body, params);
  clientTypeForAnalytics = clientType(clientId);
  if (!clientId) {
    return fail("invalid_request", "Missing required parameter: client_id");
  }

  const requestedScope = body.get("scope")?.toString();
  if (mcpAuthorizationServer) {
    try {
      validatePublicOAuthScope(requestedScope);
    } catch {
      return fail("invalid_request", "Unsupported OAuth scope");
    }
    if (requestedScope) params.set("scope", CLERK_OAUTH_SCOPE);
  }

  const refreshToken = body.get("refresh_token")?.toString();
  let resource = request.nextUrl.origin;
  if (mcpAuthorizationServer) {
    try {
      resource = resolveOAuthResource({
        requestedResource: body.get("resource")?.toString(),
        issuer: request.nextUrl.origin,
      });
    } catch (error) {
      return fail(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid OAuth resource",
      );
    }
  }

  let registeredRedirectUris: string[] | null = null;
  if (mcpAuthorizationServer && grantType === "authorization_code") {
    try {
      registeredRedirectUris = await dependencies.getRedirectUris({
        clientId,
        issuer: request.nextUrl.origin,
      });
    } catch (error) {
      console.error("[token] failed to load OAuth client registration", {
        error,
      });
      return fail("server_error", "Failed to validate OAuth client", 500);
    }
  }
  if (registeredRedirectUris) {
    const redirectUri = body.get("redirect_uri")?.toString();
    if (
      !redirectUri ||
      (!registeredRedirectUris.includes(redirectUri) &&
        !registeredRedirectUris.includes(normalizeLocalhostUri(redirectUri)))
    ) {
      return fail(
        "invalid_request",
        "redirect_uri is not registered for this client",
      );
    }
    params.set("redirect_uri", oauthProxyCallbackUrl(request.nextUrl.origin));
  }

  stage = "context_resolution";
  const contextResult = await dependencies.resolveContext({
    grantType,
    clientId,
    codeVerifier: body.get("code_verifier")?.toString(),
    refreshToken,
  });
  if (contextResult.error) {
    return finish(
      contextResult.error,
      await oauthErrorCode(contextResult.error),
    );
  }
  const authorizationContext = contextResult.authorizationContext;
  if (!authorizationContext) {
    return fail(
      "invalid_grant",
      "Authorization context not found. Please re-authorize.",
    );
  }
  accessScopeForAnalytics = authorizationContext.access_scope;
  if (
    mcpAuthorizationServer &&
    contextResult.requestResource &&
    contextResult.requestResource !== resource
  ) {
    return fail(
      "invalid_grant",
      "Token resource does not match the authorization request",
    );
  }

  let persistedAuthorizationContext = authorizationContext;

  // Internal context parameters are not part of Clerk's token endpoint.
  params.delete("org_id");
  params.delete("project_id");
  params.delete("access_scope");

  // New refresh contexts carry the user, so validate membership before Clerk
  // rotates the one-time credential. Legacy org-only contexts still require
  // post-exchange identity discovery until they expire.
  const refreshContextUserId =
    grantType === "refresh_token"
      ? authorizationContext.clerk_user_id
      : undefined;

  try {
    if (
      mcpAuthorizationServer &&
      grantType === "refresh_token" &&
      refreshToken &&
      isKernelOAuthRefreshToken(refreshToken)
    ) {
      const providerRefreshToken =
        await dependencies.getProviderRefreshToken(refreshToken);
      if (!providerRefreshToken) {
        return fail("invalid_grant", "Refresh token is invalid or expired");
      }
      params.set("refresh_token", providerRefreshToken);
    }

    stage = "membership_validation";
    if (
      refreshContextUserId &&
      !(await dependencies.hasMembership(
        refreshContextUserId,
        authorizationContext.clerk_org_id,
      ))
    ) {
      return fail(
        "invalid_grant",
        "Organization membership is no longer active",
      );
    }

    stage = "provider_exchange";
    const clerkResponse = await dependencies.exchange(
      `https://${clerkDomain}/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
    );
    if (!clerkResponse.ok) {
      return fail(
        "invalid_grant",
        grantType === "refresh_token"
          ? "Failed to refresh token"
          : "Failed to exchange authorization code",
      );
    }

    stage = "provider_response_validation";
    const clerkTokens = (await clerkResponse.json()) as ClerkTokenResponse;
    if (!clerkTokens.id_token) {
      return fail(
        "invalid_grant",
        "Failed to retrieve id_token from OAuth provider",
      );
    }
    if (
      !Number.isFinite(clerkTokens.expires_in) ||
      clerkTokens.expires_in <= 0
    ) {
      return fail(
        "invalid_grant",
        "OAuth provider returned an invalid token lifetime",
      );
    }

    if (!refreshContextUserId) {
      const payload = await dependencies.verify(clerkTokens.id_token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      if (!payload.sub) {
        return fail(
          "invalid_grant",
          "OAuth provider returned a token without a subject",
        );
      }
      if (
        authorizationContext.clerk_user_id &&
        authorizationContext.clerk_user_id !== payload.sub
      ) {
        return fail(
          "invalid_grant",
          "OAuth token subject does not match authorization context",
        );
      }
      stage = "membership_validation";
      if (
        !(await dependencies.hasMembership(
          payload.sub,
          authorizationContext.clerk_org_id,
        ))
      ) {
        return fail(
          "invalid_grant",
          "Organization membership is no longer active",
        );
      }
      if (!authorizationContext.clerk_user_id) {
        persistedAuthorizationContext = {
          ...authorizationContext,
          clerk_user_id: payload.sub,
        };
      }
    }

    stage = "provider_response_validation";
    const issuedProviderRefreshToken = clerkTokens.refresh_token;
    if (!issuedProviderRefreshToken) {
      return fail(
        "invalid_grant",
        grantType === "refresh_token"
          ? "OAuth provider did not rotate the refresh token"
          : "OAuth provider did not return a refresh token",
      );
    }
    const providerJwt = clerkTokens.id_token;
    if (grantType === "refresh_token" && !refreshToken) {
      return fail("invalid_grant", "Missing required parameter: refresh_token");
    }
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return fail(
        "unsupported_grant_type",
        `Grant type '${grantType}' is not supported`,
      );
    }

    const issuedTokens = mcpAuthorizationServer
      ? dependencies.issueTokens()
      : {
          accessToken: providerJwt,
          refreshToken: issuedProviderRefreshToken,
        };
    stage = "persistence";
    await dependencies.persistContexts({
      providerJwt,
      publicAccessToken: issuedTokens.accessToken,
      providerRefreshToken: issuedProviderRefreshToken,
      publicRefreshToken: issuedTokens.refreshToken,
      ...(grantType === "refresh_token" && refreshToken
        ? { oldPublicRefreshToken: refreshToken }
        : {}),
      authorizationContext: persistedAuthorizationContext,
      resource,
      accessTokenTtlSeconds: clerkTokens.expires_in,
      refreshTtlSeconds: REFRESH_TOKEN_ORG_TTL_SECONDS,
      ...(contextResult.requestCodeChallenge
        ? {
            consumedRequest: {
              clientId,
              codeChallenge: contextResult.requestCodeChallenge,
            },
          }
        : {}),
    });

    stage = "complete";
    return finish(
      NextResponse.json(
        {
          ...(mcpAuthorizationServer ? {} : clerkTokens),
          access_token: issuedTokens.accessToken,
          refresh_token: issuedTokens.refreshToken,
          token_type: "Bearer",
          expires_in: clerkTokens.expires_in,
          org_id: authorizationContext.clerk_org_id,
          access_scope: authorizationContext.access_scope,
          ...(authorizationContext.project_id
            ? { project_id: authorizationContext.project_id }
            : {}),
        },
        { headers: CORS_HEADERS },
      ),
    );
  } catch (error) {
    console.error("[token] token exchange failed", { error });
    return fail("server_error", "Internal server error", 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = await tokenRequest(request);
  after(flushMcpAnalytics);
  return response;
}
