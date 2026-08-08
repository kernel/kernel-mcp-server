/// <reference types="bun-types" />

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
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

async function connectApps(kernelClient: InvocationClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const tokens: string[] = [];
  registerAppCapabilities(server, {
    createKernelClient: (token) => {
      tokens.push(token);
      return kernelClient as unknown as KernelClient;
    },
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: "test-token",
        clientId: "test-client",
        scopes: [],
      },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server, tokens };
}

function resultJSON(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

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
    const { client, server, tokens } = await connectApps(kernelClient);

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
      expect(resultJSON(result)).toEqual({
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
    } finally {
      await Promise.all([client.close(), server.close()]);
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
              },
            ],
          };
        },
      },
    };
    const { client, server, tokens } = await connectApps(kernelClient);

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
      expect(resultJSON(result)).toEqual({
        browsers: [
          {
            session_id: "brr_123",
            browser_live_view_url:
              "https://api.onkernel.com/browser/live/signed",
          },
        ],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
