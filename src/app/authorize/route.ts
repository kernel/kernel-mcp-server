import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  setAuthorizationContextForClientId,
  setAuthorizationContextForRequest,
} from "@/lib/redis";
import { SHARED_CLIENT_IDS } from "@/lib/const";
import {
  authorizationContextFromSelection,
  type OAuthAuthorizationContext,
  PROJECT_ACCESS_SCOPE,
} from "@/lib/oauth-context";
import {
  OAuthProjectsError,
  requireActiveOAuthProject,
} from "@/lib/oauth-projects";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const INTERNAL_AUTHORIZATION_PARAMS = new Set([
  "org_id",
  "access_scope",
  "project_id",
]);

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function errorResponse(
  error: string,
  errorDescription: string,
  status = 400,
): NextResponse {
  return NextResponse.json(
    { error, error_description: errorDescription },
    { status, headers: CORS_HEADERS },
  );
}

function sharedClientState({
  originalState,
  orgId,
  accessScope,
  projectId,
}: {
  originalState: string | null;
  orgId: string;
  accessScope: string;
  projectId?: string;
}): string {
  let csrf = originalState || "";
  if (originalState) {
    try {
      const parsed = JSON.parse(
        Buffer.from(originalState, "base64").toString(),
      ) as { csrf?: string };
      if (parsed.csrf) csrf = parsed.csrf;
    } catch {
      // Older clients may send a plain CSRF value.
    }
  }

  return Buffer.from(
    JSON.stringify({
      csrf,
      org_id: orgId,
      access_scope: accessScope,
      ...(projectId ? { project_id: projectId } : {}),
    }),
  ).toString("base64");
}

export interface AuthorizeDependencies {
  getAuth: () => Promise<{
    userId: string | null | undefined;
    orgId: string | null | undefined;
    getToken: () => Promise<string | null>;
  }>;
  setRequestContext: (input: {
    clientId: string;
    codeChallenge: string;
    authorizationContext: OAuthAuthorizationContext;
    ttlSeconds: number;
  }) => Promise<void>;
  setClientContext: (input: {
    clientId: string;
    authorizationContext: OAuthAuthorizationContext;
    ttlSeconds: number;
  }) => Promise<void>;
  requireProject: typeof requireActiveOAuthProject;
}

const authorizeDependencies: AuthorizeDependencies = {
  getAuth: async () => auth(),
  setRequestContext: setAuthorizationContextForRequest,
  setClientContext: setAuthorizationContextForClientId,
  requireProject: requireActiveOAuthProject,
};

export async function authorizeRequest(
  request: NextRequest,
  dependencies: AuthorizeDependencies = authorizeDependencies,
): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const clientId = searchParams.get("client_id");
  const selectedOrgId = searchParams.get("org_id");
  const originalState = searchParams.get("state");
  const accessScope = searchParams.get("access_scope");
  const projectId = searchParams.get("project_id");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");

  if (!clientId) {
    return errorResponse(
      "invalid_request",
      "Missing required parameter: client_id",
    );
  }

  if (!selectedOrgId) {
    const selectOrgUrl = new URL("/select-org", request.nextUrl.origin);
    searchParams.forEach((value, key) => {
      selectOrgUrl.searchParams.set(key, value);
    });
    return NextResponse.redirect(selectOrgUrl);
  }

  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;
  if (!clerkDomain) {
    return errorResponse("server_error", "Server configuration error", 500);
  }

  const { userId, orgId, getToken } = await dependencies.getAuth();
  if (!userId || orgId !== selectedOrgId) {
    return errorResponse(
      "access_denied",
      "The selected organization is not active for this user",
      403,
    );
  }

  const hasPKCEParameters = Boolean(codeChallenge || codeChallengeMethod);
  if (hasPKCEParameters && (!codeChallenge || codeChallengeMethod !== "S256")) {
    return errorResponse(
      "invalid_request",
      "PKCE requires code_challenge and code_challenge_method=S256",
    );
  }
  if (SHARED_CLIENT_IDS.includes(clientId) && !codeChallenge) {
    return errorResponse(
      "invalid_request",
      "Shared OAuth clients require PKCE with S256",
    );
  }

  let authorizationContext;
  try {
    authorizationContext = authorizationContextFromSelection({
      clerkUserId: userId,
      clerkOrgId: selectedOrgId,
      accessScope,
      projectId,
    });
  } catch (error) {
    return errorResponse(
      "invalid_request",
      error instanceof Error ? error.message : "Invalid access scope",
    );
  }

  if (authorizationContext.access_scope === PROJECT_ACCESS_SCOPE) {
    if (!codeChallenge) {
      return errorResponse(
        "invalid_request",
        "Project-scoped authorization requires PKCE with S256",
      );
    }
    const clerkSessionToken = await getToken();
    if (!clerkSessionToken) {
      return errorResponse("access_denied", "Authentication required", 401);
    }
    try {
      await dependencies.requireProject({
        clerkSessionToken,
        projectId: authorizationContext.project_id,
      });
    } catch (error) {
      console.warn("[authorize] project validation failed", { error });
      if (error instanceof OAuthProjectsError && error.status >= 500) {
        return errorResponse(
          "server_error",
          "Project validation is temporarily unavailable",
          503,
        );
      }
      return errorResponse(
        "access_denied",
        "Project not found or inactive",
        403,
      );
    }
  }

  try {
    if (codeChallenge) {
      await dependencies.setRequestContext({
        clientId,
        codeChallenge,
        authorizationContext,
        ttlSeconds: 60 * 60,
      });
    } else {
      // Compatibility for existing non-PKCE organization-wide clients. New
      // project-scoped grants always require the PKCE-bound request mapping.
      await dependencies.setClientContext({
        clientId,
        authorizationContext,
        ttlSeconds: 60 * 60,
      });
    }
  } catch (error) {
    console.error("[authorize] failed to store authorization context", {
      error,
    });
    return errorResponse(
      "server_error",
      "Failed to store authorization context",
      500,
    );
  }

  let state = originalState;
  if (SHARED_CLIENT_IDS.includes(clientId)) {
    state = sharedClientState({
      originalState,
      orgId: selectedOrgId,
      accessScope: authorizationContext.access_scope,
      projectId: authorizationContext.project_id,
    });
  }

  const clerkAuthUrl = new URL(`https://${clerkDomain}/oauth/authorize`);
  searchParams.forEach((value, key) => {
    if (!INTERNAL_AUTHORIZATION_PARAMS.has(key)) {
      clerkAuthUrl.searchParams.set(key, value);
    }
  });
  if (state) clerkAuthUrl.searchParams.set("state", state);

  return NextResponse.redirect(clerkAuthUrl);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return authorizeRequest(request);
}
