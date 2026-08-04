import { describe, expect, test } from "bun:test";
import { mcpAppsAuthSubject, mcpAppsMarkerKey } from "@/lib/mcp-apps-marker";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

describe("MCP Apps marker identity", () => {
  test("OAuth refresh keeps the authenticated user subject", () => {
    const first = mcpAppsAuthSubject({ token: "jwt_1", userId: "user_1" });
    const refreshed = mcpAppsAuthSubject({
      token: "jwt_2",
      userId: "user_1",
    });
    expect(first).toBe(refreshed);
  });

  test("opposite-capability clients sharing one Clerk user stay isolated", () => {
    const subject = mcpAppsAuthSubject({ token: "jwt", userId: "user_1" });
    const appsClient = mcpAppsMarkerKey(subject, "mcp_session_apps");
    const plainClient = mcpAppsMarkerKey(subject, "mcp_session_plain");
    expect(appsClient).not.toBe(plainClient);
  });

  test("opposite-capability clients sharing one API key stay isolated", () => {
    const subject = mcpAppsAuthSubject({ token: "sk_shared" });
    const appsClient = mcpAppsMarkerKey(subject, "mcp_session_apps");
    const plainClient = mcpAppsMarkerKey(subject, "mcp_session_plain");
    expect(appsClient).not.toBe(plainClient);
    expect(mcpAppsAuthSubject({ token: "sk_shared" })).toBe(subject);
  });

  test("does not expose credentials or user ids in Redis keys", () => {
    const subject = mcpAppsAuthSubject({
      token: "sk_secret_value",
      userId: "user_sensitive",
    });
    const key = mcpAppsMarkerKey(subject, "session_sensitive");
    expect(key).not.toContain("sk_secret_value");
    expect(key).not.toContain("user_sensitive");
    expect(key).not.toContain("session_sensitive");
  });
});
