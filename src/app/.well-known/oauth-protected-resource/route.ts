import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";
import { NextRequest } from "next/server";

const handler = async (request: NextRequest) => {
  const clerkResponse = await protectedResourceHandlerClerk({
    scopes_supported: ["openid"],
  })(request);

  const clerkMetadata = await clerkResponse.json();

  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;

  if (!clerkDomain) {
    return Response.json(
      { error: "server_error", error_description: "Clerk domain not found" },
      { status: 500 },
    );
  }

  const clerkBaseUrl = `https://${clerkDomain}`;

  const modifiedMetadata: Record<string, unknown> = {
    ...clerkMetadata,
    resource: baseUrl,
    authorization_servers: [baseUrl],
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${clerkBaseUrl}/oauth/register`,
    scopes_supported: ["openid"],
  };

  return Response.json(modifiedMetadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
};

export const OPTIONS = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });

export { handler as GET };
