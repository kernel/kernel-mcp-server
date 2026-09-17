import { describe, expect, it } from "bun:test";
import { oauthResourceMetadata } from "./oauth-discovery";

describe("OAuth protected-resource discovery", () => {
  it("advertises canonical OAuth without changing the MCP resource identity", () => {
    expect(
      oauthResourceMetadata(
        new Request(
          "https://mcp.onkernel.com/.well-known/oauth-protected-resource/mcp",
        ),
        {
          resource: "https://clerk.example",
          authorization_servers: ["https://clerk.example"],
          jwks_uri: "https://clerk.example/.well-known/jwks.json",
          token_types_supported: [
            "urn:ietf:params:oauth:token-type:access_token",
          ],
        },
      ),
    ).toEqual({
      resource: "https://mcp.onkernel.com",
      authorization_servers: ["https://auth.onkernel.com"],
      authorization_endpoint: "https://auth.onkernel.com/authorize",
      token_endpoint: "https://auth.onkernel.com/token",
      registration_endpoint: "https://auth.onkernel.com/register",
      scopes_supported: ["openid"],
      jwks_uri: "https://clerk.example/.well-known/jwks.json",
      token_types_supported: ["urn:ietf:params:oauth:token-type:access_token"],
    });
  });

  it("pins resource and issuer when Next uses an internal request origin", () => {
    const metadata = oauthResourceMetadata(
      new Request(
        "https://localhost:3002/.well-known/oauth-protected-resource/mcp",
        {
          headers: {
            Host: "mcp.onkernel.com",
            "X-Forwarded-Host": "evil.example",
          },
        },
      ),
      {},
    );
    expect(metadata.resource).toBe("https://mcp.onkernel.com");
    expect(metadata.authorization_servers).toEqual([
      "https://auth.onkernel.com",
    ]);
  });

  it("does not send local, staging, or preview clients to production OAuth", () => {
    for (const origin of [
      "http://localhost:3002",
      "https://mcp-staging.onkernel.com",
      "https://preview.example",
      "https://mcp.onkernel.com.evil.example",
    ]) {
      const metadata = oauthResourceMetadata(new Request(`${origin}/mcp`), {});
      expect(metadata.resource).toBe(origin);
      expect(metadata.authorization_servers).toEqual([origin]);
      expect(metadata.authorization_endpoint).toBe(`${origin}/authorize`);
    }
  });
});
