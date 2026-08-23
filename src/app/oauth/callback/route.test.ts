import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encodeOAuthProxyState } from "@/lib/oauth-proxy";
import { GET } from "./route";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";
process.env.NEXT_PUBLIC_CLERK_DOMAIN ??= "clerk.example.test";

function request(params: URLSearchParams): NextRequest {
  return new NextRequest(
    `https://mcp.example.test/oauth/callback?${params.toString()}`,
  );
}

describe("GET /oauth/callback", () => {
  test("returns the provider code with the public issuer", async () => {
    const state = encodeOAuthProxyState({
      redirectUri: "http://localhost:58432/callback?existing=value",
      clientState: "opaque",
    });
    const response = await GET(
      request(new URLSearchParams({ code: "code_1", state })),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("http://localhost:58432");
    expect(location.pathname).toBe("/callback");
    expect(location.searchParams.get("existing")).toBe("value");
    expect(location.searchParams.get("code")).toBe("code_1");
    expect(location.searchParams.get("state")).toBe("opaque");
    expect(location.searchParams.get("iss")).toBe("https://mcp.example.test");
  });

  test("forwards provider errors without exposing its issuer", async () => {
    const state = encodeOAuthProxyState({
      redirectUri: "http://localhost:58432/callback",
      clientState: "opaque",
    });
    const response = await GET(
      request(
        new URLSearchParams({
          error: "access_denied",
          error_description: "Canceled",
          iss: "https://clerk.example.test",
          state,
        }),
      ),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe("Canceled");
    expect(location.searchParams.get("iss")).toBe("https://mcp.example.test");
  });

  test("rejects invalid state and malformed responses", async () => {
    const invalidState = await GET(
      request(new URLSearchParams({ code: "code_1", state: "invalid" })),
    );
    expect(invalidState.status).toBe(400);

    const state = encodeOAuthProxyState({
      redirectUri: "http://localhost:58432/callback",
      clientState: null,
    });
    const missingResult = await GET(request(new URLSearchParams({ state })));
    expect(missingResult.status).toBe(400);

    const wrongIssuer = await GET(
      request(
        new URLSearchParams({
          code: "code_1",
          state,
          iss: "https://other.example.test",
        }),
      ),
    );
    expect(wrongIssuer.status).toBe(400);
  });
});
