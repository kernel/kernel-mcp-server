import { NextRequest, NextResponse } from "next/server";
import {
  setOrgIdForJwt,
  setOrgIdForRefreshToken,
  deleteOrgIdForRefreshToken,
} from "@/lib/redis";
import { resolveOrgId } from "@/lib/org-utils";
import { REFRESH_TOKEN_ORG_TTL_SECONDS } from "@/lib/const";
import { normalizeLocalhostUri } from "@/lib/auth-utils";

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function createErrorResponse(
  error: string,
  errorDescription: string,
  status: number = 400,
) {
  return NextResponse.json(
    {
      error,
      error_description: errorDescription,
    },
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

interface ClerkTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
  id_token?: string; // Optional, only present for authorization_code grants
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Step 1: Validate request format
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/x-www-form-urlencoded")) {
    console.debug("[token] invalid content-type", { contentType });
    return createErrorResponse(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded",
    );
  }

  const body = await request.formData();

  // Step 2: Validate server configuration
  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;

  if (!clerkDomain) {
    console.error("NEXT_PUBLIC_CLERK_DOMAIN environment variable is not set");
    return createErrorResponse(
      "server_error",
      "Server configuration error - clerk domain not found",
      500,
    );
  }

  try {
    // Step 3: Prepare parameters for Clerk token exchange
    // Normalize redirect_uri to match Vercel's query param normalization (127.0.0.1 → localhost)
    const params = new URLSearchParams();
    for (const [key, value] of body.entries()) {
      if (key === "redirect_uri") {
        params.append(key, normalizeLocalhostUri(value.toString()));
      } else {
        params.append(key, value.toString());
      }
    }

    const grantType = body.get("grant_type") as string;
    console.debug("[token] start", { grantType });

    // Extract client_id from body or Authorization: Basic header
    let clientId = body.get("client_id") as string | null;
    let clientSecret = body.get("client_secret") as string | null;

    if (!clientId) {
      const authHeader = request.headers.get("authorization");
      if (authHeader?.startsWith("Basic ")) {
        try {
          const decoded = atob(authHeader.slice(6));
          const colonIdx = decoded.indexOf(":");
          if (colonIdx !== -1) {
            clientId = decodeURIComponent(decoded.slice(0, colonIdx));
            clientSecret = decodeURIComponent(decoded.slice(colonIdx + 1));
            params.set("client_id", clientId);
            if (clientSecret) {
              params.set("client_secret", clientSecret);
            }
            console.debug("[token] extracted client_id from Basic auth header");
          }
        } catch {
          console.debug("[token] failed to decode Basic auth header");
        }
      }
    }

    if (!clientId) {
      console.debug("[token] missing client_id");
      return createErrorResponse(
        "invalid_request",
        "Missing required parameter: client_id",
      );
    }

    // Extract direct org_id if provided (shared clients)
    let directOrgId: string | undefined;
    const directOrgIdParam = body.get("org_id");
    if (directOrgIdParam) {
      const orgIdParam = directOrgIdParam.toString();
      directOrgId = orgIdParam;
      const maskedOrgId = orgIdParam.slice(0, 4) + "..." + orgIdParam.slice(-4);
      console.debug("[token] using org_id from request body", { maskedOrgId });
    }

    // For refresh_token flow, resolve org before calling Clerk
    let resolvedOrgId: string | null = null;
    let refreshTokenFromBody: string | null = null;
    if (grantType === "refresh_token") {
      refreshTokenFromBody = body.get("refresh_token") as string | null;
      if (!refreshTokenFromBody) {
        console.debug("[token] missing refresh_token in refresh flow");
        return createErrorResponse(
          "invalid_request",
          "Missing required parameter: refresh_token",
        );
      }
      const orgResultPre = await resolveOrgId({
        grantType,
        clientId,
        directOrgId,
        refreshToken: refreshTokenFromBody,
      });
      if (orgResultPre.error) {
        console.debug(
          "[token] resolveOrgId (pre) returned error for refresh flow",
        );
        return orgResultPre.error;
      }
      resolvedOrgId = orgResultPre.orgId;
      if (!resolvedOrgId) {
        console.debug("[token] no org_id resolved for refresh_token flow");
        return createErrorResponse(
          "invalid_grant",
          "Organization context not found for refresh token. Please re-authorize.",
        );
      }
      console.debug("[token] resolved org via refresh_token mapping");
    }

    // Step 4: Exchange with Clerk
    const clerkTokenResponse = await fetch(
      `https://${clerkDomain}/oauth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      },
    );

    if (!clerkTokenResponse.ok) {
      console.error("[token] clerk token exchange failed");
      return createErrorResponse(
        "invalid_grant",
        grantType === "refresh_token"
          ? "Failed to refresh token"
          : "Failed to exchange authorization code",
      );
    }

    const clerkTokens: ClerkTokenResponse = await clerkTokenResponse.json();

    // Step 5: Resolve organization context for authorization_code flows (or confirm for refresh flows)
    let orgId = resolvedOrgId;
    if (!orgId) {
      const orgResult = await resolveOrgId({
        grantType,
        clientId,
        directOrgId,
      });
      if (orgResult.error) {
        console.debug("[token] resolveOrgId returned error for auth_code flow");
        return orgResult.error;
      }
      orgId = orgResult.orgId;
    }

    // Step 6: Validate organization context
    if (!orgId || orgId === "") {
      console.warn("[token] no org_id resolved for client", {
        clientIdMasked: clientId.slice(0, 4) + "...",
      });
      return createErrorResponse(
        "invalid_grant",
        "Unable to resolve organization context. Please re-authorize.",
      );
    }

    // Step 7: Validate grant type and extract JWT
    let finalJwt: string;
    let expiresIn: number;

    if (grantType === "authorization_code") {
      // For authorization_code: Use id_token directly (already has proper structure)
      if (!clerkTokens.id_token) {
        console.debug("[token] missing id_token in auth_code response");
        return createErrorResponse(
          "invalid_grant",
          "Failed to retrieve id_token from Clerk authorization code",
        );
      }

      finalJwt = clerkTokens.id_token;
      expiresIn = clerkTokens.expires_in;
    } else if (grantType === "refresh_token") {
      if (!clerkTokens.id_token) {
        console.debug("[token] missing id_token in refresh response");
        return createErrorResponse(
          "invalid_grant",
          "Failed to retrieve id_token from Clerk refresh token",
        );
      }

      finalJwt = clerkTokens.id_token;
      expiresIn = clerkTokens.expires_in;
    } else {
      return createErrorResponse(
        "unsupported_grant_type",
        `Grant type '${grantType}' is not supported`,
      );
    }

    // Step 8: Store refresh_token → org_id mapping (where applicable)
    try {
      if (grantType === "authorization_code" && clerkTokens.refresh_token) {
        await setOrgIdForRefreshToken({
          refreshToken: clerkTokens.refresh_token,
          orgId,
          ttlSeconds: REFRESH_TOKEN_ORG_TTL_SECONDS,
        });
        console.debug(
          "[token] stored refresh_token→org_id mapping (auth_code)",
        );
      }
      if (grantType === "refresh_token") {
        // Update mapping for rotated refresh token if provided
        if (clerkTokens.refresh_token) {
          // Clean up old mapping before storing the new one
          if (refreshTokenFromBody) {
            try {
              await deleteOrgIdForRefreshToken({
                refreshToken: refreshTokenFromBody,
              });
              console.debug(
                "[token] deleted old refresh_token→org_id mapping (refresh)",
              );
            } catch (e) {
              console.warn(
                "[token] failed to delete old refresh_token mapping",
                { error: e },
              );
            }
          }
          await setOrgIdForRefreshToken({
            refreshToken: clerkTokens.refresh_token,
            orgId,
            ttlSeconds: REFRESH_TOKEN_ORG_TTL_SECONDS,
          });
          console.debug(
            "[token] updated refresh_token→org_id mapping (refresh)",
          );
        }
      }
    } catch (error) {
      console.error("[token] failed to store refresh_token→org_id mapping", {
        error,
      });
      return createErrorResponse(
        "server_error",
        "Failed to store refresh token context",
        500,
      );
    }

    // Step 9: Store JWT to org_id mapping for verifyjwt.go
    try {
      // Store JWT to org_id mapping with JWT expiration time
      await setOrgIdForJwt({
        jwt: finalJwt,
        orgId,
        ttlSeconds: expiresIn,
      });
      console.debug("[token] stored jwt→org_id mapping", {
        ttlSeconds: expiresIn,
      });
    } catch (error) {
      console.error("[token] failed to store jwt→org_id mapping", { error });
      return createErrorResponse(
        "server_error",
        "Failed to store authentication context",
        500,
      );
    }

    // Step 10: Build final token response
    const mcpTokenResponse = {
      ...clerkTokens,
      access_token: finalJwt,
      expires_in: expiresIn,
    };

    console.debug("[token] success", { grantType });
    return NextResponse.json(mcpTokenResponse, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  } catch (error) {
    console.error("[token] unhandled error", { error });

    // If it's a Clerk error, log the detailed error information
    if (error && typeof error === "object" && "clerkError" in error) {
      const clerkError = error as any;
      console.error("Clerk error details:");
      console.error("  Status:", clerkError.status);
      console.error("  Clerk Trace ID:", clerkError.clerkTraceId);
      if (clerkError.errors && Array.isArray(clerkError.errors)) {
        console.error("  Specific errors:");
        clerkError.errors.forEach((err: any, index: number) => {
          console.error(
            `    Error ${index + 1}:`,
            JSON.stringify(err, null, 2),
          );
        });
      }
    }

    return createErrorResponse("server_error", "Internal server error", 500);
  }
}
