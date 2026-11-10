import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hostedAuthorizationServer } from "@/lib/oauth-discovery";

// Public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  "/",
  "/(.well-known)(.*)",
  // The MCP route validates bearer tokens and returns OAuth discovery challenges.
  "/mcp",
  "/register",
  "/authorize",
  "/oauth-consent",
  "/token",
  // Public only at this narrow relay boundary. The route itself accepts an
  // unauthenticated single-use exchange and validates scoped managed-auth JWTs
  // for retrieve, submit, and events.
  "/managed-auth-proxy/auth/connections/(.*)",
]);

// Clients that cached this host's OAuth endpoints are sent to the hosted
// authorization server, which issues the tokens the Kernel API accepts.
// Credentials issued here earlier are not migrated: the hosted server rejects
// them and the client registers again.
const HOSTED_OAUTH_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
  "/authorize",
  "/register",
  "/token",
]);

export default clerkMiddleware(async (auth, req) => {
  const authorizationServer = hostedAuthorizationServer(req);
  if (
    authorizationServer &&
    req.method !== "OPTIONS" &&
    HOSTED_OAUTH_PATHS.has(req.nextUrl.pathname)
  ) {
    return NextResponse.redirect(
      `${authorizationServer}${req.nextUrl.pathname}${req.nextUrl.search}`,
      308,
    );
  }
  if (isPublicRoute(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
