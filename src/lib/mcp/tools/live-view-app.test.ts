import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLiveViewApp } from "@/lib/mcp/tools/live-view-app";

// Tests that exercise API-backed handlers substitute a fake Kernel client.
const unusedKernelClient = new Proxy(
  {},
  {
    get: () => {
      throw new Error("unexpected Kernel client use");
    },
  },
);
let kernelClientFactory: (token: string) => any = () => unusedKernelClient;

// The capability gate falls back to a Redis marker (recorded by the route
// layer at initialize) on stateless transports. Tests control it directly.
let redisMarkerPresent = false;
mock.module("@/lib/redis", () => ({
  hasMcpAppsClient: async () => redisMarkerPresent,
  markMcpAppsClient: async () => {},
}));
mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: (token: string) => kernelClientFactory(token),
}));

type ToolRegistration = {
  config: Record<string, any>;
  handler: (params: any, extra: any) => Promise<any>;
};

function captureRegistration({ appsSupport = true } = {}) {
  const tools = new Map<string, ToolRegistration>();
  const clientCapabilities = appsSupport
    ? {
        extensions: {
          "io.modelcontextprotocol/ui": {},
        },
      }
    : {};
  const registrationHandle = () => ({
    enable() {},
    disable() {},
  });
  const server = {
    server: {
      getClientCapabilities: () => clientCapabilities,
    },
    registerResource() {
      return registrationHandle();
    },
    registerTool(
      name: string,
      config: Record<string, any>,
      handler: ToolRegistration["handler"],
    ) {
      tools.set(name, { config, handler });
      return registrationHandle();
    },
  } as unknown as McpServer;
  registerLiveViewApp(server);
  return { tools };
}

const authedExtra = { authInfo: { token: "test-token" } };

function fakeScreenshotClient() {
  const png = Buffer.from("fake-png-bytes");
  return {
    browsers: {
      computer: {
        captureScreenshot: async () => ({
          blob: async () => new Blob([png], { type: "image/png" }),
        }),
      },
    },
  };
}

describe("live view MCP App", () => {
  test("capture_live_view_frame fails closed on hosts without MCP Apps support", async () => {
    redisMarkerPresent = false;
    const { tools } = captureRegistration({ appsSupport: false });
    const result = await tools
      .get("capture_live_view_frame")!
      .handler({ session_id: "sess_1" }, authedExtra);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "only available to the embedded Kernel live view App",
    );
  });

  test("capture_live_view_frame passes the gate via the recorded initialize marker", async () => {
    redisMarkerPresent = true;
    kernelClientFactory = () => fakeScreenshotClient();
    try {
      const { tools } = captureRegistration({ appsSupport: false });
      const result = await tools
        .get("capture_live_view_frame")!
        .handler({ session_id: "sess_1" }, authedExtra);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("image");
      expect(result.content[0].mimeType).toBe("image/png");
      expect(Buffer.from(result.content[0].data, "base64").toString()).toBe(
        "fake-png-bytes",
      );
    } finally {
      redisMarkerPresent = false;
      kernelClientFactory = () => unusedKernelClient;
    }
  });

  test("capture_live_view_frame executes for MCP Apps-capable hosts", async () => {
    redisMarkerPresent = false;
    kernelClientFactory = () => fakeScreenshotClient();
    try {
      const { tools } = captureRegistration({ appsSupport: true });
      const result = await tools
        .get("capture_live_view_frame")!
        .handler({ session_id: "sess_1" }, authedExtra);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("image");
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
  });
});
