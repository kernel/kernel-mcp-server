import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { expandLocalhostUris } from "@/lib/auth-utils";
import { setOAuthClientRedirectUris } from "@/lib/redis";
import { oauthProxyCallbackUrl } from "@/lib/oauth-proxy";
import {
  CLERK_OAUTH_SCOPE,
  MCP_OAUTH_SCOPE,
  validatePublicOAuthScope,
} from "@/lib/oauth-scopes";
import { isMcpAuthorizationServer } from "@/lib/oauth-server";

// Kernel owns the public MCP scope while Clerk receives only the internal
// identity scope needed for login and consent.
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

interface OAuthApplicationInput {
  name: string;
  redirectUris: string[];
  scopes: string;
  public: boolean;
}

export interface RegisterDependencies {
  createOAuthApplication: (input: OAuthApplicationInput) => Promise<{
    id: string;
    clientId: string;
    clientSecret?: string | null;
  }>;
  storeRedirectUris: (input: {
    clientId: string;
    redirectUris: string[];
  }) => Promise<void>;
}

const registerDependencies: RegisterDependencies = {
  createOAuthApplication: async (input) => {
    const clerk = await clerkClient();
    return clerk.oauthApplications.create(input);
  },
  storeRedirectUris: setOAuthClientRedirectUris,
};

export async function registerRequest(
  request: NextRequest,
  dependencies: RegisterDependencies = registerDependencies,
): Promise<NextResponse> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Content-Type must be application/json",
      },
      { status: 400 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const mcpAuthorizationServer = isMcpAuthorizationServer(
    request.nextUrl.origin,
  );
  const {
    redirect_uris,
    client_name,
    client_uri,
    logo_uri,
    contacts,
    tos_uri,
    policy_uri,
    token_endpoint_auth_method = "none", // Default to PKCE for public clients
    grant_types = ["authorization_code"],
    response_types = ["code"],
    scope = mcpAuthorizationServer ? MCP_OAUTH_SCOPE : CLERK_OAUTH_SCOPE,
  } = body;

  let publicScope: string;
  try {
    publicScope = mcpAuthorizationServer
      ? validatePublicOAuthScope(scope)
      : typeof scope === "string" && scope.trim()
        ? scope.trim()
        : CLERK_OAUTH_SCOPE;
  } catch {
    return NextResponse.json(
      {
        error: "invalid_scope",
        error_description: "Unsupported OAuth scope",
      },
      { status: 400 },
    );
  }

  // Validate required parameters
  if (
    !redirect_uris ||
    !Array.isArray(redirect_uris) ||
    redirect_uris.length === 0
  ) {
    return NextResponse.json(
      {
        error: "invalid_redirect_uri",
        error_description:
          "redirect_uris is required and must be a non-empty array",
      },
      { status: 400 },
    );
  }

  // Validate redirect URIs
  for (const uri of redirect_uris) {
    try {
      const url = new URL(uri);
      // Allow HTTPS, localhost, and custom URI schemes (for native apps)
      if (url.protocol === "https:") {
        // HTTPS is always allowed
        continue;
      } else if (
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      ) {
        // HTTP localhost is allowed for development
        continue;
      } else if (url.protocol !== "http:" && url.protocol !== "https:") {
        // Custom URI schemes are allowed for native apps (e.g., cursor://, myapp://)
        continue;
      } else {
        // HTTP with non-localhost hostname is not allowed
        return NextResponse.json(
          {
            error: "invalid_redirect_uri",
            error_description:
              "HTTP redirect URIs are only allowed for localhost",
          },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        {
          error: "invalid_redirect_uri",
          error_description: "Invalid redirect URI format",
        },
        { status: 400 },
      );
    }
  }

  try {
    // Expand redirect_uris to include both localhost and 127.0.0.1 variants
    // This is needed because Vercel normalizes 127.0.0.1 to localhost in query params
    const expandedRedirectUris = expandLocalhostUris(redirect_uris);

    const oauthApp = await dependencies.createOAuthApplication({
      name: client_name || "MCP Client",
      redirectUris: mcpAuthorizationServer
        ? [
            ...expandedRedirectUris,
            oauthProxyCallbackUrl(request.nextUrl.origin),
          ]
        : expandedRedirectUris,
      scopes: mcpAuthorizationServer ? CLERK_OAUTH_SCOPE : publicScope,
      public: true,
    });
    if (mcpAuthorizationServer) {
      await dependencies.storeRedirectUris({
        clientId: oauthApp.clientId,
        redirectUris: expandedRedirectUris,
      });
    }

    // Create response in OAuth Dynamic Client Registration format
    const now = Math.floor(Date.now() / 1000);

    const registrationResponse = {
      client_id: oauthApp.clientId,
      client_secret: oauthApp.clientSecret || undefined, // May be null for public clients
      client_name: client_name || "MCP Client",
      client_uri,
      logo_uri,
      contacts,
      tos_uri,
      policy_uri,
      redirect_uris,
      token_endpoint_auth_method,
      grant_types,
      response_types,
      scope: publicScope,
      client_id_issued_at: now,
      client_secret_expires_at: 0, // Public clients don't expire
      registration_access_token: oauthApp.id, // Use OAuth app ID as registration token
      registration_client_uri: `${request.nextUrl.origin}/register/${oauthApp.clientId}`,
    };

    return NextResponse.json(registrationResponse, {
      status: 201,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  } catch (error) {
    console.error("Client registration error:", error);
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Failed to register client with OAuth provider",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return registerRequest(request);
}
