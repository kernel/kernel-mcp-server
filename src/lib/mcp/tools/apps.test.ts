import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  InvocationCreateParams,
  InvocationCreateResponse,
  InvocationListBrowsersResponse,
} from "@onkernel/sdk/resources/invocations";

type InvocationClient = {
  invocations: {
    create: (
      input: InvocationCreateParams,
    ) => Promise<InvocationCreateResponse>;
    follow: (invocationId: string) => never;
    listBrowsers: (
      invocationId: string,
    ) => Promise<InvocationListBrowsersResponse>;
  };
};

let kernelClient: InvocationClient;

mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: () => kernelClient,
}));

const { registerAppCapabilities } = await import("@/lib/mcp/tools/apps");

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (
  params: Record<string, unknown>,
  extra: { authInfo?: { token: string } },
) => Promise<ToolResult>;

function captureManageAppsHandler() {
  let handler: ToolHandler | undefined;
  const server = {
    resource() {},
    tool(name: string, ...args: unknown[]) {
      if (name === "manage_apps") {
        handler = args.at(-1) as ToolHandler;
      }
    },
  } as unknown as McpServer;

  registerAppCapabilities(server);
  if (!handler) throw new Error("manage_apps was not registered");
  return handler;
}

describe("manage_apps invoke", () => {
  test("returns the invocation ID immediately without following the run", async () => {
    let createInput: unknown;
    let followCalls = 0;
    kernelClient = {
      invocations: {
        create: async (input) => {
          createInput = input;
          return {
            id: "inv_123",
            action_name: "cua-task",
            status: "queued",
          };
        },
        follow: () => {
          followCalls += 1;
          throw new Error("invoke must not wait for completion");
        },
        listBrowsers: async () => ({ browsers: [] }),
      },
    };

    const result = await captureManageAppsHandler()(
      {
        action: "invoke",
        app_name: "ts-cua",
        action_name: "cua-task",
        payload: '{"query":"open example.com"}',
      },
      { authInfo: { token: "test-token" } },
    );

    expect(createInput).toEqual({
      app_name: "ts-cua",
      action_name: "cua-task",
      payload: '{"query":"open example.com"}',
      version: "latest",
      async: true,
    });
    expect(followCalls).toBe(0);
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: "inv_123",
      action_name: "cua-task",
      status: "queued",
      invocation_id: "inv_123",
      next_action: {
        action: "get_invocation",
        invocation_id: "inv_123",
      },
      browser_action: {
        action: "list_invocation_browsers",
        invocation_id: "inv_123",
      },
      polling: {
        interval_seconds: 5,
        max_attempts: 60,
      },
    });
  });

  test("returns browsers created by an invocation", async () => {
    let requestedInvocationId = "";
    kernelClient = {
      invocations: {
        create: async () => ({
          id: "unused",
          action_name: "unused",
          status: "queued",
        }),
        follow: () => {
          throw new Error("unused");
        },
        listBrowsers: async (invocationId) => {
          requestedInvocationId = invocationId;
          return {
            browsers: [
              {
                session_id: "brr_123",
                browser_live_view_url:
                  "https://api.onkernel.com/browser/live/signed",
                cdp_ws_url: "wss://api.onkernel.com/cdp",
                webdriver_ws_url: "wss://api.onkernel.com/webdriver",
                created_at: "2026-08-08T00:00:00Z",
                headless: false,
                stealth: true,
                timeout_seconds: 600,
              },
            ],
          };
        },
      },
    };

    const result = await captureManageAppsHandler()(
      {
        action: "list_invocation_browsers",
        invocation_id: "inv_123",
      },
      { authInfo: { token: "test-token" } },
    );

    expect(requestedInvocationId).toBe("inv_123");
    expect(JSON.parse(result.content[0].text)).toEqual({
      browsers: [
        {
          session_id: "brr_123",
          browser_live_view_url: "https://api.onkernel.com/browser/live/signed",
        },
      ],
    });
  });
});
