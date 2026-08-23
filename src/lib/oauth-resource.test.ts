import { describe, expect, test } from "bun:test";
import {
  oauthResourceAllowsRequest,
  resolveOAuthResource,
} from "./oauth-resource";

describe("OAuth resource binding", () => {
  test("normalizes the server origin and supports legacy omission", () => {
    for (const requestedResource of [
      undefined,
      "https://mcp.example.test",
      "https://mcp.example.test/",
    ]) {
      expect(
        resolveOAuthResource({
          requestedResource,
          issuer: "https://mcp.example.test",
        }),
      ).toBe("https://mcp.example.test");
    }
  });

  test("binds specific MCP resources to their request path", () => {
    expect(
      resolveOAuthResource({
        requestedResource: "https://mcp.example.test/mcp",
        issuer: "https://mcp.example.test",
      }),
    ).toBe("https://mcp.example.test/mcp");
    expect(
      oauthResourceAllowsRequest({
        resource: "https://mcp.example.test/mcp",
        requestUrl: "https://mcp.example.test/mcp",
      }),
    ).toBe(true);
    expect(
      oauthResourceAllowsRequest({
        resource: "https://mcp.example.test/mcp",
        requestUrl: "https://mcp.example.test/sse",
      }),
    ).toBe(false);
  });

  test("rejects another audience and ambiguous resource URIs", () => {
    for (const requestedResource of [
      "https://api.example.test",
      "https://mcp.example.test/other",
      "https://mcp.example.test?target=other",
      "not-a-url",
    ]) {
      expect(() =>
        resolveOAuthResource({
          requestedResource,
          issuer: "https://mcp.example.test",
        }),
      ).toThrow();
    }
  });
});
