import { protectedResourceHandlerClerk } from "@clerk/mcp-tools/next";
import { NextRequest } from "next/server";
import { oauthResourceMetadata } from "@/lib/oauth-discovery";

const handler = async (request: NextRequest) => {
  const clerkResponse = await protectedResourceHandlerClerk({
    scopes_supported: ["openid"],
  })(request);

  const clerkMetadata = await clerkResponse.json();

  const modifiedMetadata = oauthResourceMetadata(request, clerkMetadata);

  return Response.json(modifiedMetadata, {
    headers: {
      "Cache-Control": "no-store",
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
