import { NextResponse } from "next/server";
import {
  getAuthorizationContextForClientId,
  getAuthorizationContextForRefreshTokenSliding,
  getAuthorizationContextForRequest,
} from "./redis";
import { REFRESH_TOKEN_ORG_TTL_SECONDS } from "./const";
import {
  deriveS256CodeChallenge,
  type OAuthAuthorizationContext,
} from "./oauth-context";

function createErrorResponse(
  error: string,
  errorDescription: string,
  status = 400,
) {
  return NextResponse.json(
    { error, error_description: errorDescription },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    },
  );
}

export interface AuthorizationContextDependencies {
  getRequestContext: typeof getAuthorizationContextForRequest;
  getClientContext: typeof getAuthorizationContextForClientId;
  getRefreshContext: typeof getAuthorizationContextForRefreshTokenSliding;
}

const authorizationContextDependencies: AuthorizationContextDependencies = {
  getRequestContext: getAuthorizationContextForRequest,
  getClientContext: getAuthorizationContextForClientId,
  getRefreshContext: getAuthorizationContextForRefreshTokenSliding,
};

export interface ResolvedAuthorizationContext {
  authorizationContext: OAuthAuthorizationContext | null;
  requestCodeChallenge?: string;
  error?: NextResponse;
}

export async function resolveAuthorizationContext(
  {
    grantType,
    clientId,
    codeVerifier,
    refreshToken,
  }: {
    grantType: string;
    clientId: string;
    codeVerifier?: string;
    refreshToken?: string;
  },
  dependencies: AuthorizationContextDependencies = authorizationContextDependencies,
): Promise<ResolvedAuthorizationContext> {
  if (grantType === "authorization_code") {
    if (codeVerifier) {
      const codeChallenge = deriveS256CodeChallenge(codeVerifier);
      try {
        const authorizationContext = await dependencies.getRequestContext({
          clientId,
          codeChallenge,
        });
        if (authorizationContext) {
          return {
            authorizationContext,
            requestCodeChallenge: codeChallenge,
          };
        }
        return {
          authorizationContext: null,
          error: createErrorResponse(
            "invalid_grant",
            "Authorization context expired. Please re-authorize.",
          ),
        };
      } catch (error) {
        console.error("[org-utils] failed to read PKCE authorization context", {
          error,
        });
        return {
          authorizationContext: null,
          error: createErrorResponse(
            "server_error",
            "Failed to retrieve authorization context",
            500,
          ),
        };
      }
    }

    try {
      const authorizationContext = await dependencies.getClientContext({
        clientId,
      });
      if (authorizationContext) return { authorizationContext };
    } catch (error) {
      console.error("[org-utils] failed to read client authorization context", {
        error,
      });
      return {
        authorizationContext: null,
        error: createErrorResponse(
          "server_error",
          "Failed to retrieve authorization context",
          500,
        ),
      };
    }

    return {
      authorizationContext: null,
      error: createErrorResponse(
        "invalid_grant",
        "Authorization context expired. Please re-authorize.",
      ),
    };
  }

  if (grantType === "refresh_token") {
    if (!refreshToken) {
      return {
        authorizationContext: null,
        error: createErrorResponse(
          "invalid_request",
          "Missing required parameter: refresh_token",
        ),
      };
    }
    try {
      const authorizationContext = await dependencies.getRefreshContext({
        refreshToken,
        ttlSeconds: REFRESH_TOKEN_ORG_TTL_SECONDS,
      });
      if (authorizationContext) return { authorizationContext };
    } catch (error) {
      console.error(
        "[org-utils] failed to read refresh authorization context",
        {
          error,
        },
      );
      return {
        authorizationContext: null,
        error: createErrorResponse(
          "server_error",
          "Failed to retrieve authorization context for refresh token",
          500,
        ),
      };
    }

    return {
      authorizationContext: null,
      error: createErrorResponse(
        "invalid_grant",
        "Authorization context expired for this refresh token. Please re-authorize.",
      ),
    };
  }

  return {
    authorizationContext: null,
    error: createErrorResponse(
      "unsupported_grant_type",
      `Grant type '${grantType}' is not supported`,
    ),
  };
}
