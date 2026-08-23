import { describe, expect, test } from "bun:test";
import { validatePublicOAuthScope } from "./oauth-scopes";

describe("public OAuth scopes", () => {
  test("defaults new clients to the MCP resource scope", () => {
    expect(validatePublicOAuthScope(undefined)).toBe("mcp");
    expect(validatePublicOAuthScope("mcp")).toBe("mcp");
  });

  test("accepts the legacy openid scope without arbitrary escalation", () => {
    expect(validatePublicOAuthScope("openid")).toBe("openid");
    expect(validatePublicOAuthScope("mcp openid mcp")).toBe("mcp openid");
    expect(() => validatePublicOAuthScope("profile")).toThrow(
      "Unsupported OAuth scope",
    );
  });
});
