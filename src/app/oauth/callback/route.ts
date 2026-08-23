import { NextRequest, NextResponse } from "next/server";
import { decodeOAuthProxyState } from "@/lib/oauth-proxy";

function errorResponse(description: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_request", error_description: description },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const encodedState = params.get("state");
  if (!encodedState) {
    return errorResponse("Missing OAuth proxy state");
  }

  const state = decodeOAuthProxyState(encodedState);
  if (!state) {
    return errorResponse("Invalid or expired OAuth proxy state");
  }

  const providerIssuer = params.get("iss");
  const clerkDomain = process.env.NEXT_PUBLIC_CLERK_DOMAIN;
  if (
    providerIssuer &&
    (!clerkDomain || providerIssuer !== `https://${clerkDomain}`)
  ) {
    return errorResponse("OAuth provider issuer mismatch");
  }

  const code = params.get("code");
  const error = params.get("error");
  if ((!code && !error) || (code && error)) {
    return errorResponse("Invalid OAuth authorization response");
  }

  const redirect = new URL(state.redirectUri);
  if (code) redirect.searchParams.set("code", code);
  if (error) {
    redirect.searchParams.set("error", error);
    for (const key of ["error_description", "error_uri"] as const) {
      const value = params.get(key);
      if (value) redirect.searchParams.set(key, value);
    }
  }
  if (state.clientState !== null) {
    redirect.searchParams.set("state", state.clientState);
  }
  redirect.searchParams.set("iss", request.nextUrl.origin);

  const response = NextResponse.redirect(redirect, 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
