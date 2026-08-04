import { MCP_SESSION_HEADER } from "@posthog/mcp";
import {
  createMcpHandler,
  experimental_withMcpAuth as withMcpAuth,
} from "mcp-handler";
import { verifyToken } from "@clerk/nextjs/server";
import { after, NextRequest } from "next/server";
import { isValidJwtFormat } from "@/lib/auth-utils";
import { flushMcpAnalytics, instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { mcpAppsAuthSubject } from "@/lib/mcp-apps-marker";
import { requestUsesMcpApps } from "@/lib/mcp-apps-request";
import {
  createMcpTransportSession,
  verifyMcpTransportSession,
} from "@/lib/mcp-transport-session";
import { registerMcpCapabilities } from "@/lib/mcp/register";
import { name, version } from "../../../server.json";

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
const serverInfo = { serverInfo: { name, version } };
const handler = createMcpHandler((server) => {
  instrumentMcpAnalytics(server);
  registerMcpCapabilities(server);
}, serverInfo);
const mcpAppsHandler = createMcpHandler((server) => {
  instrumentMcpAnalytics(server);
  registerMcpCapabilities(server, { mcpApps: true });
}, serverInfo);

async function handleAuthenticatedRequest(
  req: NextRequest,
  transportSessionId: string | null = null,
): Promise<Response> {
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
    // Opaque API keys are authenticated by the Kernel API rather than Clerk.
    const authSubject = mcpAppsAuthSubject({ token });
    const selectedHandler = (await requestUsesMcpApps(req, {
      authSubject,
      transportSessionId,
      ttlSeconds: 24 * 60 * 60,
    }))
      ? mcpAppsHandler
      : handler;
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

    // Capability state is keyed only after Clerk verifies the JWT, and uses
    // the verified user plus this signed MCP transport session.
    const authSubject = mcpAppsAuthSubject({ token, userId: payload.sub });
    const selectedHandler = (await requestUsesMcpApps(req, {
      authSubject,
      transportSessionId,
      ttlSeconds: 24 * 60 * 60,
    }))
      ? mcpAppsHandler
      : handler;

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

  const body = await req.text();
  type InitializeRequest = {
    method?: unknown;
    params?: {
      clientInfo?: { name?: string; version?: string };
      protocolVersion?: string;
    };
  };
  let parsed: InitializeRequest | null = null;
  try {
    const value = JSON.parse(body) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as InitializeRequest;
    }
  } catch {
    // Let the MCP transport return its normal parse error.
  }
  const initializeParams =
    parsed?.method === "initialize" ? parsed.params : undefined;
  const isStreamableInitialize =
    new URL(req.url).pathname.endsWith("/mcp") &&
    parsed?.method === "initialize";
  const session = isStreamableInitialize
    ? createMcpTransportSession({
        clientName: initializeParams?.clientInfo?.name,
        clientVersion: initializeParams?.clientInfo?.version,
        protocolVersion: initializeParams?.protocolVersion,
      })
    : verifyMcpTransportSession(req.headers.get(MCP_SESSION_HEADER));

  // Only the verified inner token reaches PostHog's instrumentation. Clients
  // receive and replay the signed outer token, which capability storage trusts.
  const requestHeaders = new Headers(req.headers);
  if (session) requestHeaders.set(MCP_SESSION_HEADER, session.analyticsToken);
  else requestHeaders.delete(MCP_SESSION_HEADER);
  const response = await handleAuthenticatedRequest(
    new NextRequest(req.url, {
      method: req.method,
      headers: requestHeaders,
      body,
      signal: req.signal,
    }),
    session?.id ?? null,
  );

  if (!session) return response;
  const headers = new Headers(response.headers);
  if (isStreamableInitialize || headers.has(MCP_SESSION_HEADER)) {
    headers.set(MCP_SESSION_HEADER, session.token);
  }
  headers.set("Access-Control-Expose-Headers", MCP_SESSION_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
