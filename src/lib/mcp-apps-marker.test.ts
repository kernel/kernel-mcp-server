import { describe, expect, test } from "bun:test";
import { mcpAppsMarkerSubject } from "@/lib/mcp-apps-marker";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

describe("MCP Apps marker subject", () => {
  test("survives OAuth access-token refresh via the session id", () => {
    const first = jwt({ sub: "user_1", sid: "sess_1", exp: 100 });
    const refreshed = jwt({
      sub: "user_1",
      sid: "sess_1",
      exp: 200,
      iat: 150,
    });
    expect(mcpAppsMarkerSubject(first)).toBe("sid:sess_1");
    expect(mcpAppsMarkerSubject(refreshed)).toBe("sid:sess_1");
  });

  test("keys distinct sessions apart", () => {
    expect(mcpAppsMarkerSubject(jwt({ sid: "sess_2" }))).toBe("sid:sess_2");
    expect(mcpAppsMarkerSubject(jwt({ sid: "sess_2" }))).not.toBe(
      mcpAppsMarkerSubject(jwt({ sid: "sess_3" })),
    );
  });

  test("falls back to the token hash for API keys and sid-less JWTs", () => {
    const apiKey = mcpAppsMarkerSubject("sk_test_key");
    expect(apiKey.startsWith("token:")).toBe(true);
    expect(mcpAppsMarkerSubject("sk_test_key")).toBe(apiKey);
    expect(mcpAppsMarkerSubject("sk_other_key")).not.toBe(apiKey);

    const sidlessA = jwt({ sub: "user_1", exp: 100 });
    const sidlessB = jwt({ sub: "user_1", exp: 200 });
    expect(mcpAppsMarkerSubject(sidlessA).startsWith("token:")).toBe(true);
    expect(mcpAppsMarkerSubject(sidlessA)).not.toBe(
      mcpAppsMarkerSubject(sidlessB),
    );
  });
});
