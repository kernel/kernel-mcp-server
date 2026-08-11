import { clerkClient, verifyToken } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { persistOAuthTokenContexts } from "@/lib/redis";
import { resolveAuthorizationContext } from "@/lib/org-utils";
import { REFRESH_TOKEN_ORG_TTL_SECONDS } from "@/lib/const";
import { normalizeLocalhostUri } from "@/lib/auth-utils";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function createErrorResponse(
  error: string,
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
  persistContexts: typeof persistOAuthTokenContexts;
}

const tokenDependencies: TokenDependencies = {
  exchange: fetch,
  resolveContext: resolveAuthorizationContext,
  verify: verifyToken,
  hasMembership: hasOrganizationMembership,
  persistContexts: persistOAuthTokenContexts,
};

export async function tokenRequest(
  request: NextRequest,
  dependencies: TokenDependencies = tokenDependencies,
): Promise<NextResponse> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/x-www-form-urlencoded")) {
    return createErrorResponse(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded",
    );
  }

  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;
  if (!clerkDomain) {
    return createErrorResponse(
      "server_error",
      "Server configuration error",
      500,
    );
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
  const { clientId } = clientCredentials(request, body, params);
  if (!clientId) {
    return createErrorResponse(
      "invalid_request",
      "Missing required parameter: client_id",
    );
  }

  const refreshToken = body.get("refresh_token")?.toString();
  const contextResult = await dependencies.resolveContext({
    grantType,
    clientId,
    codeVerifier: body.get("code_verifier")?.toString(),
    refreshToken,
  });
  if (contextResult.error) return contextResult.error;
  const authorizationContext = contextResult.authorizationContext;
  if (!authorizationContext) {
    return createErrorResponse(
      "invalid_grant",
      "Authorization context not found. Please re-authorize.",
    );
  }

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
      refreshContextUserId &&
      !(await dependencies.hasMembership(
        refreshContextUserId,
        authorizationContext.clerk_org_id,
      ))
    ) {
      return createErrorResponse(
        "invalid_grant",
        "Organization membership is no longer active",
      );
    }

    const clerkResponse = await dependencies.exchange(
      `https://${clerkDomain}/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
    );
    if (!clerkResponse.ok) {
      return createErrorResponse(
        "invalid_grant",
        grantType === "refresh_token"
          ? "Failed to refresh token"
          : "Failed to exchange authorization code",
      );
    }

    const clerkTokens = (await clerkResponse.json()) as ClerkTokenResponse;
    if (!clerkTokens.id_token) {
      return createErrorResponse(
        "invalid_grant",
        "Failed to retrieve id_token from OAuth provider",
      );
    }
    if (
      !Number.isFinite(clerkTokens.expires_in) ||
      clerkTokens.expires_in <= 0
    ) {
      return createErrorResponse(
        "invalid_grant",
        "OAuth provider returned an invalid token lifetime",
      );
    }

    if (!refreshContextUserId) {
      const payload = await dependencies.verify(clerkTokens.id_token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      if (!payload.sub) {
        return createErrorResponse(
          "invalid_grant",
          "OAuth provider returned a token without a subject",
        );
      }
      if (
        authorizationContext.clerk_user_id &&
        authorizationContext.clerk_user_id !== payload.sub
      ) {
        return createErrorResponse(
          "invalid_grant",
          "OAuth token subject does not match authorization context",
        );
      }
      if (
        !(await dependencies.hasMembership(
          payload.sub,
          authorizationContext.clerk_org_id,
        ))
      ) {
        return createErrorResponse(
          "invalid_grant",
          "Organization membership is no longer active",
        );
      }
    }

    const issuedRefreshToken = clerkTokens.refresh_token;
    if (!issuedRefreshToken) {
      return createErrorResponse(
        "invalid_grant",
        grantType === "refresh_token"
          ? "OAuth provider did not rotate the refresh token"
          : "OAuth provider did not return a refresh token",
      );
    }
    const finalJwt = clerkTokens.id_token;
    if (grantType === "refresh_token" && !refreshToken) {
      return createErrorResponse(
        "invalid_grant",
        "Missing required parameter: refresh_token",
      );
    }
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return createErrorResponse(
        "unsupported_grant_type",
        `Grant type '${grantType}' is not supported`,
      );
    }

    await dependencies.persistContexts({
      jwt: finalJwt,
      newRefreshToken: issuedRefreshToken,
      ...(grantType === "refresh_token" && refreshToken
        ? { oldRefreshToken: refreshToken }
        : {}),
      authorizationContext,
      jwtTtlSeconds: clerkTokens.expires_in,
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

    return NextResponse.json(
      {
        ...clerkTokens,
        access_token: finalJwt,
        expires_in: clerkTokens.expires_in,
        org_id: authorizationContext.clerk_org_id,
        access_scope: authorizationContext.access_scope,
        ...(authorizationContext.project_id
          ? { project_id: authorizationContext.project_id }
          : {}),
      },
      { headers: CORS_HEADERS },
    );
  } catch (error) {
    console.error("[token] token exchange failed", { error });
    return createErrorResponse("server_error", "Internal server error", 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return tokenRequest(request);
}
