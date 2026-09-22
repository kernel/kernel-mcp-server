import { describe, expect, it } from "bun:test";
import {
  oauthResourceMetadata,
  oauthResourceMetadataUrl,
} from "./oauth-discovery";

describe("OAuth protected-resource discovery", () => {
  it.each([
    ["https://mcp.onkernel.com", undefined, "https://mcp.onkernel.com"],
    ["http://localhost:3002", "mcp.onkernel.com", "https://mcp.onkernel.com"],
    [
      "http://localhost:3002",
      "mcp.dev.onkernel.com",
      "https://mcp.dev.onkernel.com",
    ],
    ["http://localhost:3002", undefined, "http://localhost:3002"],
    [
      "https://localhost:3000",
      "mcp-staging.onkernel.com",
      "https://mcp-staging.onkernel.com",
    ],
    ["https://preview.example", undefined, "https://preview.example"],
  ])(
    "binds RFC 9728 path discovery to the resource at %s (Host: %s)",
    (requestOrigin, host, publicOrigin) => {
      const resource = new URL(`${publicOrigin}/mcp`);
      const expectedMetadataUrl = new URL(resource);
      expectedMetadataUrl.pathname = `/.well-known/oauth-protected-resource${resource.pathname}`;
      const headers = host ? { Host: host } : undefined;
      const endpointRequest = new Request(`${requestOrigin}/mcp`, { headers });
      expect(oauthResourceMetadataUrl(endpointRequest)).toBe(
        expectedMetadataUrl.href,
      );

      const metadataRequest = new Request(
        `${requestOrigin}${expectedMetadataUrl.pathname}`,
        { headers },
      );
      const metadata = oauthResourceMetadata(metadataRequest, {
        resource: publicOrigin,
      });
      expect(metadata.resource).toBe(resource.href);
      expect(metadata.resource).not.toBe(resource.origin);
    },
  );

  it("advertises canonical OAuth for the exact MCP endpoint", () => {
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
      resource: "https://mcp.onkernel.com/mcp",
      authorization_servers: ["https://auth.onkernel.com"],
      authorization_endpoint: "https://auth.onkernel.com/authorize",
      token_endpoint: "https://auth.onkernel.com/token",
      registration_endpoint: "https://auth.onkernel.com/register",
      scopes_supported: ["openid"],
      jwks_uri: "https://clerk.example/.well-known/jwks.json",
      token_types_supported: ["urn:ietf:params:oauth:token-type:access_token"],
    });
  });

  it.each([
    ["mcp.onkernel.com", "auth.onkernel.com"],
    ["mcp.dev.onkernel.com", "auth.dev.onkernel.com"],
  ])("pins %s discovery to %s behind Next", (resourceHost, issuerHost) => {
    const metadata = oauthResourceMetadata(
      new Request(
        "https://localhost:3002/.well-known/oauth-protected-resource/mcp",
        {
          headers: {
            Host: resourceHost,
            "X-Forwarded-Host": "evil.example",
          },
        },
      ),
      {},
    );
    expect(metadata).toMatchObject({
      resource: `https://${resourceHost}/mcp`,
      authorization_servers: [`https://${issuerHost}`],
      authorization_endpoint: `https://${issuerHost}/authorize`,
      token_endpoint: `https://${issuerHost}/token`,
      registration_endpoint: `https://${issuerHost}/register`,
    });
  });

  it("advertises the dev OAuth server on direct dev requests", () => {
    const metadata = oauthResourceMetadata(
      new Request(
        "https://mcp.dev.onkernel.com/.well-known/oauth-protected-resource/mcp",
      ),
      {},
    );
    expect(metadata.resource).toBe("https://mcp.dev.onkernel.com/mcp");
    expect(metadata.authorization_servers).toEqual([
      "https://auth.dev.onkernel.com",
    ]);
  });

  it("uses the public Host for other non-production discovery behind Next", () => {
    for (const host of [
      "mcp-staging.onkernel.com",
      "preview.example",
      "localhost:3002",
    ]) {
      const metadata = oauthResourceMetadata(
        new Request(
          "https://localhost:3000/.well-known/oauth-protected-resource/mcp",
          {
            headers: { Host: host, "X-Forwarded-Host": "mcp.onkernel.com" },
          },
        ),
        {},
      );
      expect(metadata.resource).toBe(`https://${host}/mcp`);
      expect(metadata.authorization_servers).toEqual([`https://${host}`]);
      expect(metadata.authorization_endpoint).toBe(`https://${host}/authorize`);
      expect(metadata.token_endpoint).toBe(`https://${host}/token`);
      expect(metadata.registration_endpoint).toBe(`https://${host}/register`);
    }
  });

  it("does not send local, staging, or preview clients to production OAuth", () => {
    for (const origin of [
      "http://localhost:3002",
      "https://mcp-staging.onkernel.com",
      "https://preview.example",
      "https://mcp.onkernel.com.evil.example",
      "https://mcp.dev.onkernel.com.evil.example",
    ]) {
      const metadata = oauthResourceMetadata(
        new Request(`${origin}/.well-known/oauth-protected-resource/mcp`),
        {},
      );
      expect(metadata.resource).toBe(`${origin}/mcp`);
      expect(metadata.authorization_servers).toEqual([origin]);
      expect(metadata.authorization_endpoint).toBe(`${origin}/authorize`);
    }
  });
});
