import { describe, expect, test } from "bun:test";
import { isMcpAuthorizationServer } from "./oauth-server";

describe("OAuth server aliases", () => {
  test("keeps CLI auth aliases separate from MCP authorization", () => {
    expect(isMcpAuthorizationServer("https://mcp.onkernel.com")).toBe(true);
    expect(isMcpAuthorizationServer("https://mcp.dev.onkernel.com")).toBe(true);
    expect(isMcpAuthorizationServer("https://preview.example.test")).toBe(true);
    expect(isMcpAuthorizationServer("https://auth.onkernel.com")).toBe(false);
    expect(isMcpAuthorizationServer("https://auth.dev.onkernel.com")).toBe(
      false,
    );
  });
});
