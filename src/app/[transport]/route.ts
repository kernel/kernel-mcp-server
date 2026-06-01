import {
  createMcpHandler,
  experimental_withMcpAuth as withMcpAuth,
} from "mcp-handler";
import { verifyToken } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { isValidJwtFormat } from "@/lib/auth-utils";
import { registerMcpCapabilities } from "@/lib/mcp/register";

export async function OPTIONS(_req: NextRequest): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// Helper function to create authentication error response
function createAuthErrorResponse(
  error: string = "invalid_token",
  description: string = "Missing or invalid access token",
): Response {
  return new Response(
    JSON.stringify({
      error,
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="OAuth", error="${error}", error_description="${description}"`,
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    },
  );
}

// Create MCP handler with tools
const handler = createMcpHandler((server) => {
  registerMcpCapabilities(server);
});

async function handleAuthenticatedRequest(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7).trim()
    : null;
  if (!token) {
    return createAuthErrorResponse(
      "invalid_token",
      "Missing or invalid access token",
    );
  }

  if (!isValidJwtFormat(token)) {
    const authHandler = withMcpAuth(
      handler,
      async () => ({
        token,
        scopes: ["apikey"],
        clientId: "mcp-server",
        extra: { userId: null, clerkToken: null },
      }),
      {
        required: true,
        resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
      },
    );
    return await authHandler(req);
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    if (!payload.sub) {
      return createAuthErrorResponse(
        "invalid_token",
        "Invalid token: No user ID found in token payload",
      );
    }

    // Create authenticated handler with auth info
    const authHandler = withMcpAuth(
      handler,
      async (_req, _providedToken) => {
        // Return auth info with validated user data
        return {
          token: token, // Use the validated token
          scopes: ["openid"],
          clientId: "mcp-server",
          extra: {
            userId: payload.sub,
            clerkToken: token,
          },
        };
      },
      {
        required: true,
        resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
      },
    );

    return await authHandler(req);
  } catch (authError) {
    return createAuthErrorResponse(
      "invalid_token",
      `Invalid token: ${authError instanceof Error ? authError.message : "Authentication failed"}`,
    );
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return await handleAuthenticatedRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return await handleAuthenticatedRequest(req);
}
