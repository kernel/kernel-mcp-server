import { NextRequest } from "next/server";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;

  if (!clerkDomain) {
    return Response.json(
      { error: "server_error", error_description: "Clerk domain not found" },
      { status: 500 },
    );
  }

  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const clerkBaseUrl = `https://${clerkDomain}`;

  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${clerkBaseUrl}/oauth/register`,
    jwks_uri: `${clerkBaseUrl}/.well-known/jwks.json`,
    scopes_supported: ["openid"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ],
  };

  return Response.json(metadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
