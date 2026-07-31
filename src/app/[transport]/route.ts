import { MCP_SESSION_HEADER } from "@posthog/mcp";
import {
  createMcpHandler,
  experimental_withMcpAuth as withMcpAuth,
} from "mcp-handler";
import { verifyToken } from "@clerk/nextjs/server";
import { after, NextRequest } from "next/server";
import { isValidJwtFormat } from "@/lib/auth-utils";
import {
  flushMcpAnalytics,
  instrumentMcpAnalytics,
  mintMcpSessionId,
} from "@/lib/mcp/analytics";
import { registerMcpCapabilities } from "@/lib/mcp/register";
import { initializeDeclaresMcpApps } from "@/lib/mcp/tools/auth-login-app";
import {
  clearMcpAppsClient,
  hasMcpAppsClient,
  markMcpAppsClient,
} from "@/lib/redis";

// The streamable-HTTP transport creates one McpServer per request, so the
// initialize capability is unavailable when tools/list or an App call arrives.
// Persist the negotiation marker, then select the additive App registration
// only for requests that need to discover or invoke it.
async function requestUsesMcpApps(
  req: NextRequest,
  token: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (req.method !== "POST") return false;
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return false;
  }

  const request =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as {
          method?: unknown;
          params?: { name?: unknown; uri?: unknown };
        })
      : null;
  if (request?.method === "initialize") {
    const declaresApps = initializeDeclaresMcpApps(body);
    try {
      if (declaresApps) {
        await markMcpAppsClient({ token, ttlSeconds });
      } else {
        await clearMcpAppsClient(token);
      }
    } catch (error) {
      // Never block initialize; without a marker, later App discovery and
      // invocation fail closed to the base tool set.
      console.error("Failed to record MCP Apps capability:", error);
    }
    return false;
  }

  const needsAppRegistration =
    request?.method === "tools/list" ||
    request?.method === "resources/list" ||
    (request?.method === "resources/read" &&
      typeof request.params?.uri === "string" &&
      request.params.uri.startsWith("ui://kernel/managed-auth-login")) ||
    (request?.method === "tools/call" &&
      (request.params?.name === "open_auth_login" ||
        request.params?.name === "begin_auth_login"));
  if (!needsAppRegistration) return false;

  try {
    return await hasMcpAppsClient({ token, ttlSeconds });
  } catch (error) {
    console.error("MCP Apps capability check failed; using base tools:", error);
    return false;
  }
}

export async function OPTIONS(_req: NextRequest): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": `Content-Type, Authorization, ${MCP_SESSION_HEADER}`,
      "Access-Control-Expose-Headers": MCP_SESSION_HEADER,
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

// The base tool set is unchanged. Capability negotiation only adds the
// Managed Auth launcher, its resource, and its app-only implementation tools.
const handler = createMcpHandler((server) => {
  instrumentMcpAnalytics(server);
  registerMcpCapabilities(server);
});
const mcpAppsHandler = createMcpHandler((server) => {
  instrumentMcpAnalytics(server);
  registerMcpCapabilities(server, { mcpApps: true });
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

  const selectedHandler = (await requestUsesMcpApps(req, token, 24 * 60 * 60))
    ? mcpAppsHandler
    : handler;

  if (!isValidJwtFormat(token)) {
    const authHandler = withMcpAuth(
      selectedHandler,
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
      selectedHandler,
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
  after(flushMcpAnalytics);
  return await handleAuthenticatedRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  after(flushMcpAnalytics);

  const sessionId = await mintMcpSessionId(req);
  if (!sessionId) return await handleAuthenticatedRequest(req);

  // Pass the token in on the handshake too, so the initialize event lands in the same
  // session as the calls that follow it.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(MCP_SESSION_HEADER, sessionId);
  const response = await handleAuthenticatedRequest(
    new NextRequest(req.url, {
      method: req.method,
      headers: requestHeaders,
      body: await req.text(),
      signal: req.signal,
    }),
  );

  const headers = new Headers(response.headers);
  headers.set(MCP_SESSION_HEADER, sessionId);
  // Preflight allows the header; a browser only gets to read it if the response that
  // carries it says so too.
  headers.set("Access-Control-Expose-Headers", MCP_SESSION_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
