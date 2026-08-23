import { NextRequest } from "next/server";
import { CLERK_OAUTH_SCOPE, MCP_OAUTH_SCOPE } from "@/lib/oauth-scopes";
import { isMcpAuthorizationServer } from "@/lib/oauth-server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest): Promise<Response> {
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const mcpAuthorizationServer = isMcpAuthorizationServer(baseUrl);
  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;
  if (!mcpAuthorizationServer && !clerkDomain) {
    return Response.json(
      { error: "server_error", error_description: "Clerk domain not found" },
      { status: 500 },
    );
  }

  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    ...(mcpAuthorizationServer
      ? {}
      : { jwks_uri: `https://${clerkDomain}/.well-known/jwks.json` }),
    scopes_supported: [
      mcpAuthorizationServer ? MCP_OAUTH_SCOPE : CLERK_OAUTH_SCOPE,
    ],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    ...(mcpAuthorizationServer
      ? { authorization_response_iss_parameter_supported: true }
      : {}),
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
  };

  return Response.json(metadata, { headers: CORS_HEADERS });
}
