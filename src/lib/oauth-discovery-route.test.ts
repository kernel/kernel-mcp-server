import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const clerkMetadata = {
  resource: "https://clerk.example.test",
  authorization_servers: ["https://clerk.example.test"],
  jwks_uri: "https://clerk.example.test/.well-known/jwks.json",
};
mock.module("@clerk/mcp-tools/next", () => ({
  protectedResourceHandlerClerk: () => async () => Response.json(clerkMetadata),
}));

const { GET, OPTIONS } = await import(
  "@/app/.well-known/oauth-protected-resource/mcp/route"
);

describe("/.well-known/oauth-protected-resource/mcp", () => {
  test.each([
    ["https://mcp.onkernel.com", "https://auth.onkernel.com"],
    ["http://localhost:3002", "http://localhost:3002"],
    ["https://mcp-staging.onkernel.com", "https://mcp-staging.onkernel.com"],
  ])("serves uncached metadata bound to %s/mcp", async (origin, issuer) => {
    const resource = new URL(`${origin}/mcp`);
    const discoveryUrl = new URL(resource);
    discoveryUrl.pathname = `/.well-known/oauth-protected-resource${resource.pathname}`;
    const response = await GET(new NextRequest(discoveryUrl));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({
      resource: resource.href,
      authorization_servers: [issuer],
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      scopes_supported: ["openid"],
      jwks_uri: clerkMetadata.jwks_uri,
    });
  });

  test("keeps discovery available to cross-origin clients", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization",
    );
  });
});
