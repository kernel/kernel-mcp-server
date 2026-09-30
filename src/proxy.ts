import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

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

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
