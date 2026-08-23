import { NextRequest } from "next/server";
import { MCP_OAUTH_SCOPE } from "@/lib/oauth-scopes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest): Promise<Response> {
  const baseUrl = request.nextUrl.origin;
  return Response.json(
    {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: [MCP_OAUTH_SCOPE],
    },
    { headers: CORS_HEADERS },
  );
}
