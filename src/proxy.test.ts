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

  test("keeps organization selection protected by Clerk", async () => {
    const protect = mock(async () => {});
    await handleRequest(
      { protect },
      new NextRequest("https://mcp.example.test/select-org"),
    );
    expect(protect).toHaveBeenCalledTimes(1);
  });
});
