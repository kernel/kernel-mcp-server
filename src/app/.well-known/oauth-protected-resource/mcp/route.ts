import { NextRequest } from "next/server";
import { oauthResourceMetadata } from "@/lib/oauth-discovery";

const handler = async (request: NextRequest) => {
  return Response.json(oauthResourceMetadata(request), {
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
