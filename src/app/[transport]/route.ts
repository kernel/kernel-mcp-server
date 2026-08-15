import { MCP_SESSION_HEADER } from "@posthog/mcp";
import {
  createMcpHandler,
  experimental_withMcpAuth as withMcpAuth,
} from "mcp-handler";
import { verifyToken } from "@clerk/nextjs/server";
import { after, NextRequest } from "next/server";
import { isValidJwtFormat } from "@/lib/auth-utils";
import {
  captureMcpConnectionScopeFailure,
  clientCapabilityAnalyticsFromInitialize,
  flushMcpAnalytics,
  instrumentMcpAnalytics,
  isMcpAnalyticsEnabled,
  type McpClientCapabilityAnalytics,
} from "@/lib/mcp/analytics";
import {
  connectionAnalyticsFromContext,
  resolveMcpConnectionContext,
  type McpConnectionContextFailure,
} from "@/lib/mcp/auth-context";
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

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function errorResponse(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { ...CORS_HEADERS, ...headers } },
  );
}

// Helper function to create authentication error response
function createAuthErrorResponse(
  error: string = "invalid_token",
  description: string = "Missing or invalid access token",
): Response {
  return errorResponse(401, error, description, {
    "WWW-Authenticate": `Bearer realm="OAuth", error="${error}", error_description="${description}"`,
  });
}

export function connectionScopeFailureResponse(
  failure: Exclude<McpConnectionContextFailure, { status: "invalid" }>,
): Response {
  if (failure.status === "rejected") {
    switch (failure.statusCode) {
      case 403:
        return errorResponse(
          403,
          "insufficient_scope",
          "This credential is not scoped to the requested Kernel project",
          {
            "WWW-Authenticate": `Bearer realm="OAuth", error="insufficient_scope"`,
          },
        );
      case 404:
        return errorResponse(
          404,
          "project_not_found",
          "The Kernel project for this connection was not found or is inactive",
        );
      case 401:
        return createAuthErrorResponse(
          "invalid_token",
          "The Kernel API rejected this credential",
        );
    }
  }
  return errorResponse(
    503,
    "temporarily_unavailable",
    "Unable to resolve Kernel connection scope",
    { "Retry-After": "1" },
  );
}

// Handler variants keep per-connection capabilities out of tools/list unless
// the authenticated connection can use them.
const serverInfo = { serverInfo: { name, version } };
function createHandler({ mcpApps = false }: { mcpApps?: boolean } = {}) {
  return createMcpHandler((server) => {
    instrumentMcpAnalytics(server);
    registerMcpCapabilities(server, { mcpApps });
  }, serverInfo);
}

const handler = createHandler();
const mcpAppsHandler = createHandler({ mcpApps: true });

type AuthInfoExtra = {
  userId: string | null;
  clerkToken: string | null;
};

async function handleMcpRequestWithIdentity({
  req,
  token,
  authSubject,
  scopes,
  authInfoExtra,
  credentialType,
  transportSessionId,
  connectionContextCacheIdentity,
  observeConnection,
  clientCapabilityAnalytics,
}: {
  req: NextRequest;
  token: string;
  authSubject: string;
  scopes: string[];
  authInfoExtra: AuthInfoExtra;
  credentialType: "api_key" | "oauth";
  transportSessionId: string | null;
  connectionContextCacheIdentity?: string;
  observeConnection: boolean;
  clientCapabilityAnalytics: McpClientCapabilityAnalytics | null;
}) {
  const [mcpApps, connection] = await Promise.all([
    requestUsesMcpApps(req, {
      authSubject,
      transportSessionId,
      ttlSeconds: 24 * 60 * 60,
    }),
    resolveMcpConnectionContext({
      token,
      signal: req.signal,
      cacheIdentity: connectionContextCacheIdentity,
    }),
  ]);
  if (connection.status !== "ok") {
    captureMcpConnectionScopeFailure({
      outcome: connection.status,
      credentialType,
      upstreamStatusCode:
        connection.status === "invalid" ? undefined : connection.statusCode,
    });
    if (connection.status === "invalid") {
      throw new Error("Unable to resolve Kernel connection scope");
    }
    return connectionScopeFailureResponse(connection);
  }
  const connectionContext = connection.context;
  const connectionAnalytics =
    observeConnection && isMcpAnalyticsEnabled()
      ? connectionAnalyticsFromContext(connectionContext)
      : null;
  const authHandler = withMcpAuth(
    mcpApps ? mcpAppsHandler : handler,
    async () => ({
      token,
      scopes,
      clientId: "mcp-server",
      extra: {
        ...authInfoExtra,
        connectionContext,
        connectionAnalytics,
        clientCapabilityAnalytics,
      },
    }),
    {
      required: true,
      resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
    },
  );
  return await authHandler(req);
}

async function handleAuthenticatedRequest(
  req: NextRequest,
  transportSessionId: string | null = null,
  observeConnection = false,
  clientCapabilityAnalytics: McpClientCapabilityAnalytics | null = null,
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
    // Do not cache their context: /auth/context must revalidate the credential
    // on every request so revoked keys cannot keep using a cached scope.
    return await handleMcpRequestWithIdentity({
      req,
      token,
      authSubject: mcpAppsAuthSubject({ token }),
      scopes: ["apikey"],
      authInfoExtra: { userId: null, clerkToken: null },
      credentialType: "api_key",
      transportSessionId,
      observeConnection,
      clientCapabilityAnalytics,
    });
  }

  let userId: string;
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
    userId = payload.sub;
  } catch (authError) {
    return createAuthErrorResponse(
      "invalid_token",
      `Invalid token: ${authError instanceof Error ? authError.message : "Authentication failed"}`,
    );
  }

  // Capability state is keyed only after Clerk verifies the JWT, and uses
  // the verified user plus this signed MCP transport session.
  const authSubject = mcpAppsAuthSubject({ token, userId });
  return await handleMcpRequestWithIdentity({
    req,
    token,
    authSubject,
    scopes: ["openid"],
    authInfoExtra: { userId, clerkToken: token },
    credentialType: "oauth",
    transportSessionId,
    connectionContextCacheIdentity: transportSessionId
      ? `${authSubject}\0${transportSessionId}`
      : undefined,
    observeConnection,
    clientCapabilityAnalytics,
  });
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
  const isInitialize = parsed?.method === "initialize";
  const initializeParams = isInitialize ? parsed?.params : undefined;
  const clientCapabilityAnalytics = isInitialize
    ? clientCapabilityAnalyticsFromInitialize(parsed)
    : null;
  const isStreamableInitialize =
    new URL(req.url).pathname.endsWith("/mcp") && isInitialize;
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
    isInitialize,
    clientCapabilityAnalytics,
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
