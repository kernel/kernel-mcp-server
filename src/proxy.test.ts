import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

let handleRequest: (
  auth: { protect: () => Promise<void> },
  request: NextRequest,
) => Promise<Response | void>;
const clerk = await import("@clerk/nextjs/server");
mock.module("@clerk/nextjs/server", () => ({
  ...clerk,
  clerkMiddleware: (handler: typeof handleRequest) => {
    handleRequest = handler;
    return handler;
  },
}));
await import("./proxy");

describe("MCP discovery through middleware", () => {
  test.each(["GET", "POST", "OPTIONS"])(
    "lets unauthenticated %s /mcp reach the bearer-token gate",
    async (method) => {
      const protect = mock(async () => {});
      await handleRequest(
        { protect },
        new NextRequest("https://mcp.example.test/mcp", { method }),
      );
      expect(protect).not.toHaveBeenCalled();
    },
  );

  test("lets API keys reach the MCP route's credential validation", async () => {
    const protect = mock(async () => {});
    await handleRequest(
      { protect },
      new NextRequest("https://mcp.example.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer sk_test_key" },
      }),
    );
    expect(protect).not.toHaveBeenCalled();
  });

  test.each(["GET", "POST", "OPTIONS"])(
    "does not bypass Clerk for %s on other /mcp-prefixed paths",
    async (method) => {
      const protect = mock(async () => {});
      await handleRequest(
        { protect },
        new NextRequest("https://mcp.example.test/mcp-other", {
          method,
          headers: { Authorization: "Bearer sk_test_key" },
        }),
      );
      expect(protect).toHaveBeenCalledTimes(1);
    },
  );

  test("keeps organization selection protected by Clerk", async () => {
    const protect = mock(async () => {});
    await handleRequest(
      { protect },
      new NextRequest("https://mcp.example.test/select-org"),
    );
    expect(protect).toHaveBeenCalledTimes(1);
  });
});

describe("OAuth routes on hosted MCP origins", () => {
  test.each([
    ["mcp.onkernel.com", "auth.onkernel.com"],
    ["mcp.dev.onkernel.com", "auth.dev.onkernel.com"],
  ])("redirects %s OAuth routes to %s", async (mcpHost, authHost) => {
    for (const [method, path] of [
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/authorize?client_id=abc&state=xyz"],
      ["POST", "/register"],
      ["POST", "/token"],
    ]) {
      const protect = mock(async () => {});
      const response = await handleRequest(
        { protect },
        new NextRequest(`https://${mcpHost}${path}`, { method }),
      );
      expect(response?.status).toBe(308);
      expect(response?.headers.get("location")).toBe(
        `https://${authHost}${path}`,
      );
      expect(protect).not.toHaveBeenCalled();
    }
  });

  test("redirects using the public Host behind Next", async () => {
    const response = await handleRequest(
      { protect: mock(async () => {}) },
      new NextRequest("http://localhost:3002/token", {
        method: "POST",
        headers: { Host: "mcp.onkernel.com" },
      }),
    );
    expect(response?.headers.get("location")).toBe(
      "https://auth.onkernel.com/token",
    );
  });

  test("lets CORS preflight reach the route handlers", async () => {
    const response = await handleRequest(
      { protect: mock(async () => {}) },
      new NextRequest("https://mcp.onkernel.com/token", { method: "OPTIONS" }),
    );
    expect(response).toBeUndefined();
  });

  test.each([
    "http://localhost:3002",
    "https://preview.example",
    "https://mcp.onkernel.com.evil.example",
  ])("keeps serving OAuth on %s", async (origin) => {
    for (const path of ["/authorize", "/token", "/register"]) {
      const response = await handleRequest(
        { protect: mock(async () => {}) },
        new NextRequest(`${origin}${path}`),
      );
      expect(response).toBeUndefined();
    }
  });

  test("does not redirect the MCP endpoint or its resource metadata", async () => {
    for (const path of ["/mcp", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await handleRequest(
        { protect: mock(async () => {}) },
        new NextRequest(`https://mcp.onkernel.com${path}`, { method: "POST" }),
      );
      expect(response).toBeUndefined();
    }
  });
});
