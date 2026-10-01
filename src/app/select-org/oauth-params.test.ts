import { describe, expect, test } from "bun:test";
import { buildSelectOrgRedirectUrl } from "./oauth-params";

describe("select organization OAuth parameters", () => {
  test("preserves client, redirect, state, and PKCE parameters when switching accounts", () => {
    const params = new URLSearchParams({
      client_id: "client_1",
      state: "opaque state",
      redirect_uri: "https://client.example.test/oauth/callback?source=mcp",
      code_challenge: "challenge_1",
      code_challenge_method: "S256",
    });

    const redirect = new URL(
      buildSelectOrgRedirectUrl(params),
      "https://auth.example.test",
    );

    expect(redirect.pathname).toBe("/select-org");
    expect(redirect.searchParams.get("client_id")).toBe("client_1");
    expect(redirect.searchParams.get("state")).toBe("opaque state");
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      "https://client.example.test/oauth/callback?source=mcp",
    );
    expect(redirect.searchParams.get("code_challenge")).toBe("challenge_1");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
