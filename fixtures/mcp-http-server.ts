// Isolate upstream service mocks from the rest of the Bun test suite. The HTTP
// listener runs the real route, registrations, OAuth endpoints, and Kernel SDK.
import { mock } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import { jwtVerify, SignJWT } from "jose";
import type { OAuthAuthorizationContext } from "../src/lib/oauth-context";
import type { AuthorizeDependencies } from "../src/app/authorize/route";
import type { TokenDependencies } from "../src/app/token/route";

process.env.CLERK_SECRET_KEY = "mcp-integration-signing-key";
process.env.NEXT_PUBLIC_CLERK_DOMAIN = "clerk.example.test";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
process.env.KERNEL_CLI_PROD_CLIENT_ID = "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID = "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID = "cli_dev";
delete process.env.POSTHOG_PROJECT_TOKEN;
delete process.env.KERNEL_PROJECT;
delete process.env.KERNEL_MCP_ENABLED_TOOLSETS;
delete process.env.KERNEL_MCP_DISABLED_TOOLSETS;

const signingKey = new TextEncoder().encode(process.env.CLERK_SECRET_KEY);
const verify = async (token: string) =>
  (await jwtVerify(token, signingKey)).payload;
const clerk = await import("@clerk/nextjs/server");
mock.module("@clerk/nextjs/server", () => ({ ...clerk, verifyToken: verify }));
const next = await import("next/server");
mock.module("next/server", () => ({ ...next, after: () => {} }));

const markers = new Set<string>();
type Marker = { authSubject: string; transportSessionId: string };
const markerKey = (marker: Marker) =>
  `${marker.authSubject}\0${marker.transportSessionId}`;
const redis = await import("../src/lib/redis");
mock.module("@/lib/redis", () => ({
  ...redis,
  markMcpAppsClient: async (marker: Marker) => {
    markers.add(markerKey(marker));
  },
  clearMcpAppsClient: async (marker: Marker) => {
    markers.delete(markerKey(marker));
  },
  hasMcpAppsClient: async (marker: Marker) => markers.has(markerKey(marker)),
}));

const requests = new Map<string, OAuthAuthorizationContext>();
const refreshes = new Map<
  string,
  { context: OAuthAuthorizationContext; clientId: string }
>();
const tokens = new Map<string, OAuthAuthorizationContext>();
const clients = new Map<string, string[]>();
const codes = new Map<
  string,
  { clientId: string; challenge: string; redirectUri: string }
>();
const { deriveS256CodeChallenge } = await import("../src/lib/oauth-context");
const { resolveAuthorizationContext } = await import("../src/lib/org-utils");
const { defaultMcpDependencies } = await import("../src/lib/mcp/dependencies");
const mcp = await import("../src/app/[transport]/route");
const resourceMetadata = await import(
  "../src/app/.well-known/oauth-protected-resource/mcp/route"
);
const authMetadata = await import(
  "../src/app/.well-known/oauth-authorization-server/route"
);
const { registerRequest } = await import("../src/app/register/route");
const { authorizeRequest } = await import("../src/app/authorize/route");
const { tokenRequest } = await import("../src/app/token/route");

const authorizeDependencies: AuthorizeDependencies = {
  getAuth: async () => ({
    userId: "user_test",
    orgId: "org_test",
    getToken: async () => "session-token",
  }),
  setRequestContext: async ({
    clientId,
    codeChallenge,
    authorizationContext,
  }) => {
    requests.set(`${clientId}:${codeChallenge}`, authorizationContext);
  },
  setClientContext: async () => {
    throw new Error("Expected PKCE authorization");
  },
  requireProject: async ({ projectId }) => ({
    id: projectId,
    name: "Test project",
    status: "active",
  }),
};

const tokenDependencies: TokenDependencies = {
  resolveContext: (input) =>
    resolveAuthorizationContext(input, {
      getRequestContext: async ({ clientId, codeChallenge }) =>
        requests.get(`${clientId}:${codeChallenge}`) ?? null,
      getClientContext: async () => null,
      getRefreshContext: async ({ refreshToken }) =>
        refreshes.get(refreshToken)?.context ?? null,
    }),
  verify,
  hasMembership: async () => true,
  exchange: async (_url, init) => {
    const params = new URLSearchParams(String(init?.body));
    const clientId = params.get("client_id")!;
    if (params.get("grant_type") === "authorization_code") {
      const code = params.get("code")!;
      const grant = codes.get(code);
      if (
        !grant ||
        grant.clientId !== clientId ||
        grant.redirectUri !== params.get("redirect_uri") ||
        grant.challenge !==
          deriveS256CodeChallenge(params.get("code_verifier")!)
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      codes.delete(code);
    } else if (
      refreshes.get(params.get("refresh_token")!)?.clientId !== clientId
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_test")
      .setJti(crypto.randomUUID())
      .setExpirationTime("1h")
      .sign(signingKey);
    return Response.json({
      access_token: "provider-access-token",
      id_token: token,
      refresh_token: crypto.randomUUID(),
      expires_in: 3600,
      token_type: "Bearer",
    });
  },
  persistContexts: async ({
    jwt,
    newRefreshToken,
    oldRefreshToken,
    authorizationContext,
    consumedRequest,
  }) => {
    const clientId =
      consumedRequest?.clientId ?? refreshes.get(oldRefreshToken!)!.clientId;
    tokens.set(jwt, authorizationContext);
    refreshes.set(newRefreshToken, { context: authorizationContext, clientId });
    if (oldRefreshToken) refreshes.delete(oldRefreshToken);
    if (consumedRequest)
      requests.delete(`${clientId}:${consumedRequest.codeChallenge}`);
  },
  recordExchange: () => {},
};

defaultMcpDependencies.createKernelClient = (token, project) =>
  new Kernel({
    apiKey: token,
    project,
    baseURL: "https://api.example.test",
    maxRetries: 0,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      const context = tokens.get(token);
      if (!context && token !== "sk_valid")
        return Response.json(
          { message: "Invalid credential" },
          { status: 401 },
        );
      const projectId = context?.project_id ?? null;
      if (path === "/auth/context")
        return Response.json({
          authentication: {
            method: context ? "jwt" : "api_key",
            source: context ? "oauth" : "api_key",
            credential_id: null,
          },
          principal: {
            type: context ? "user" : "api_key",
            id: context ? "user_test" : "key_test",
          },
          organization: { id: "org_test" },
          authorization: {
            credential_scope: { project_id: projectId },
            effective_scope: { project_id: projectId },
          },
        });
      if (path === "/org/entitlements")
        return Response.json({ features: { vaults: { enabled: true } } });
      if (path === "/org/projects/project_test")
        return Response.json({
          id: "project_test",
          name: "Test project",
          status: "active",
        });
      if (path === "/org/projects/missing")
        return Response.json({ message: "Project not found" }, { status: 404 });
      throw new Error(`Unexpected Kernel API path: ${path}`);
    },
  });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const req = new next.NextRequest(request);
    switch (url.pathname) {
      case "/mcp":
        if (req.method === "POST") return mcp.POST(req);
        if (req.method === "GET") return mcp.GET(req);
        if (req.method === "OPTIONS") return mcp.OPTIONS(req);
        return new Response(null, { status: 405 });
      case "/.well-known/oauth-protected-resource/mcp":
        return resourceMetadata.GET(req);
      case "/.well-known/oauth-authorization-server":
        return authMetadata.GET(req);
      case "/register":
        return registerRequest(req, {
          createOAuthApplication: async ({ redirectUris }) => {
            const clientId = crypto.randomUUID();
            clients.set(clientId, redirectUris);
            return { id: clientId, clientId };
          },
        });
      case "/authorize": {
        // Simulate the user selecting a project and approving Clerk's hosted UI.
        url.searchParams.set("org_id", "org_test");
        url.searchParams.set("access_scope", "project");
        url.searchParams.set("project_id", "project_test");
        const response = await authorizeRequest(
          new next.NextRequest(url),
          authorizeDependencies,
        );
        if (response.status !== 307) return response;
        const upstream = new URL(response.headers.get("location")!);
        const clientId = upstream.searchParams.get("client_id")!;
        const redirectUri = upstream.searchParams.get("redirect_uri")!;
        if (!clients.get(clientId)?.includes(redirectUri))
          return new Response("Invalid redirect", { status: 400 });
        const code = crypto.randomUUID();
        codes.set(code, {
          clientId,
          redirectUri,
          challenge: upstream.searchParams.get("code_challenge")!,
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", upstream.searchParams.get("state")!);
        return Response.redirect(callback, 302);
      }
      case "/token":
        return tokenRequest(req, tokenDependencies);
      default:
        return new Response("Not found", { status: 404 });
    }
  },
});
console.log(JSON.stringify({ url: new URL("/mcp", server.url).href }));
