import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let kernelClient: any;

mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: () => kernelClient,
}));

const { registerAppCapabilities } = await import("@/lib/mcp/tools/apps");

type ToolHandler = (params: any, extra: any) => Promise<any>;

function captureManageAppsHandler() {
  let handler: ToolHandler | undefined;
  const server = {
    resource() {},
    tool(name: string, ...args: any[]) {
      if (name === "manage_apps") {
        handler = args.at(-1);
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
        create: async (input: unknown) => {
          createInput = input;
          return { id: "inv_123", status: "pending" };
        },
        follow: () => {
          followCalls += 1;
          throw new Error("invoke must not wait for completion");
        },
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
      status: "pending",
      invocation_id: "inv_123",
      next_action: {
        action: "get_invocation",
        invocation_id: "inv_123",
      },
    });
  });
});
