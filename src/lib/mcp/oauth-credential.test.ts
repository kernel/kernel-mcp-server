import { describe, expect, test } from "bun:test";
import { resolvePresentedCredential } from "./oauth-credential";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

describe("presented MCP credentials", () => {
  test("resolves Kernel access tokens to a separate provider credential", async () => {
    const verified: string[] = [];
    const result = await resolvePresentedCredential(
      "kmcp_at_client_token",
      "https://mcp.example.test/mcp",
      {
        getAccessTokenSession: async () => ({
          providerJwt: "header.payload.signature",
          resource: "https://mcp.example.test/mcp",
        }),
        verify: async (token) => {
          verified.push(token);
          return { sub: "user_1" };
        },
      },
    );

    expect(result).toEqual({
      kind: "oauth",
      clientToken: "kmcp_at_client_token",
      providerToken: "header.payload.signature",
      userId: "user_1",
    });
    expect(verified).toEqual(["header.payload.signature"]);
  });

  test("keeps existing JWT sessions and API keys compatible", async () => {
    const dependencies = {
      getAccessTokenSession: async () => null,
      verify: async () => ({ sub: "user_1" }),
    };
    expect(
      await resolvePresentedCredential(
        "header.payload.signature",
        "https://mcp.example.test/mcp",
        dependencies,
      ),
    ).toMatchObject({
      kind: "oauth",
      clientToken: "header.payload.signature",
      providerToken: "header.payload.signature",
    });
    expect(
      await resolvePresentedCredential(
        "sk_opaque_key",
        "https://mcp.example.test/mcp",
        dependencies,
      ),
    ).toEqual({ kind: "api_key", token: "sk_opaque_key" });
  });

  test("rejects missing and wrong-audience Kernel access tokens", async () => {
    const verify = async () => ({ sub: "user_1" });
    expect(
      await resolvePresentedCredential(
        "kmcp_at_missing",
        "https://mcp.example.test/mcp",
        { getAccessTokenSession: async () => null, verify },
      ),
    ).toMatchObject({ kind: "invalid" });
    expect(
      await resolvePresentedCredential(
        "kmcp_at_wrong_audience",
        "https://mcp.example.test/mcp",
        {
          getAccessTokenSession: async () => ({
            providerJwt: "header.payload.signature",
            resource: "https://other.example.test",
          }),
          verify,
        },
      ),
    ).toMatchObject({ kind: "invalid" });
    expect(
      await resolvePresentedCredential(
        "kmcp_at_wrong_path",
        "https://mcp.example.test/sse",
        {
          getAccessTokenSession: async () => ({
            providerJwt: "header.payload.signature",
            resource: "https://mcp.example.test/mcp",
          }),
          verify,
        },
      ),
    ).toMatchObject({ kind: "invalid" });
  });
});
