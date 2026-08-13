/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerAppCapabilities } from "@/lib/mcp/tools/apps";
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

describe("manage_apps invocation contract", () => {
  test("returns the invocation ID immediately without following the run", async () => {
    let createInput: unknown;
    let followCalls = 0;
    const kernelClient: InvocationClient = {
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
    const { client, tokens, close } = await connectTestMcp(
      registerAppCapabilities,
      kernelClient,
    );

    try {
      const tools = await client.listTools();
      expect(
        tools.tools.some((tool) => tool.name === "manage_apps"),
      ).toBeTrue();

      const result = await client.callTool({
        name: "manage_apps",
        arguments: {
          action: "invoke",
          app_name: "ts-cua",
          action_name: "cua-task",
          payload: '{"query":"open example.com"}',
        },
      });

      expect(tokens).toEqual(["test-token"]);
      expect(createInput).toEqual({
        app_name: "ts-cua",
        action_name: "cua-task",
        payload: '{"query":"open example.com"}',
        version: "latest",
        async: true,
      });
      expect(followCalls).toBe(0);
      expect(toolResultJSON(result)).toEqual({
        id: "inv_123",
        action_name: "cua-task",
        status: "queued",
        invocation_id: "inv_123",
      });
    } finally {
      await close();
    }
  });

  test("returns browsers created by an invocation", async () => {
    let requestedInvocationId = "";
    const kernelClient: InvocationClient = {
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
                region: "us-east",
              },
            ],
          };
        },
      },
    };
    const { client, tokens, close } = await connectTestMcp(
      registerAppCapabilities,
      kernelClient,
    );

    try {
      const result = await client.callTool({
        name: "manage_apps",
        arguments: {
          action: "list_invocation_browsers",
          invocation_id: "inv_123",
        },
      });

      expect(tokens).toEqual(["test-token"]);
      expect(requestedInvocationId).toBe("inv_123");
      expect(toolResultJSON(result)).toEqual({
        browsers: [
          {
            session_id: "brr_123",
            browser_live_view_url:
              "https://api.onkernel.com/browser/live/signed",
          },
        ],
      });
    } finally {
      await close();
    }
  });
});
