import { describe, expect, test } from "bun:test";
import {
  decodeOAuthProxyState,
  encodeOAuthProxyState,
  oauthProxyCallbackUrl,
} from "./oauth-proxy";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

describe("OAuth proxy state", () => {
  test("round trips the client redirect and state", () => {
    const encoded = encodeOAuthProxyState({
      redirectUri: "http://localhost:58432/callback",
      clientState: "opaque",
      now: 1_000,
    });

    expect(decodeOAuthProxyState(encoded, 2_000)).toEqual({
      redirectUri: "http://localhost:58432/callback",
      clientState: "opaque",
    });
  });

  test("rejects tampered and expired state", () => {
    const encoded = encodeOAuthProxyState({
      redirectUri: "http://localhost:58432/callback",
      clientState: null,
      now: 1_000,
    });
    const [payload, signature] = encoded.split(".");

    expect(decodeOAuthProxyState(`${payload}x.${signature}`, 2_000)).toBeNull();
    expect(
      decodeOAuthProxyState(encoded, 1_000 + 60 * 60 * 1000 + 1),
    ).toBeNull();
  });

  test("builds an origin-local callback URL", () => {
    expect(oauthProxyCallbackUrl("https://mcp.example.test")).toBe(
      "https://mcp.example.test/oauth/callback",
    );
  });
});
