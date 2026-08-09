/// <reference types="bun-types" />

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import { registerConnectionContextTool } from "@/lib/mcp/tools/connection-context";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
};

describe("get_connection_context", () => {
  test("returns the authoritative API auth context through MCP", async () => {
    const context = {
      authentication: {
        credential_id: "key_123",
        method: "api_key",
        source: "api_key",
      },
      authorization: {
        credential_scope: { project_id: "proj_123" },
        effective_scope: { project_id: "proj_123" },
      },
      organization: { id: "org_123" },
      principal: { id: "key_123", type: "api_key" },
    };
    const tokens: string[] = [];
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerConnectionContextTool(server, {
      createKernelClient: (token) => {
        tokens.push(token);
        return {
          auth: {
            context: { retrieve: async () => context },
          },
        } as unknown as KernelClient;
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
          token: "secret-token",
          clientId: "test-client",
          scopes: [],
        },
      });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "get_connection_context",
      );

      const result = (await client.callTool({
        name: "get_connection_context",
        arguments: {},
      })) as ToolResult;
      expect(tokens).toEqual(["secret-token"]);
      expect(JSON.parse(result.content[0].text)).toEqual(context);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
