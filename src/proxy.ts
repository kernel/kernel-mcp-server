import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { isValidJwtFormat } from "@/lib/auth-utils";

// Public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  "/",
  "/(.well-known)(.*)",
  "/register",
  "/authorize",
  "/token",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  if (req.nextUrl.pathname.startsWith("/mcp")) {
    if (req.method === "OPTIONS") return;
    const authheader = req.headers.get("Authorization");
    if (authheader?.startsWith("Bearer ")) {
      const token = authheader.substring(7).trim();
      // If it's NOT a JWT format, treat it as an API key
      if (!isValidJwtFormat(token)) return;
    }
  }
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
