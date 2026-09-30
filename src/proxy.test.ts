import { describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

let handleRequest: (
  auth: { protect: () => Promise<void> },
  request: NextRequest,
) => Promise<void>;
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
