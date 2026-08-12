import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectScopedAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import type { McpDependencies } from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";

type RegisterCapabilities = (
  server: McpServer,
  dependencies?: McpDependencies,
) => void;

export function testMcpDependencies(
  kernelClient: unknown,
  tokens?: string[],
): McpDependencies {
  return {
    createKernelClient: (token) => {
      tokens?.push(token);
      return kernelClient as KernelClient;
    },
  };
}

export async function connectTestMcp(
  register: RegisterCapabilities,
  kernelClient: unknown,
) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const tokens: string[] = [];
  register(server, testMcpDependencies(kernelClient, tokens));

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: projectScopedAuthInfo(),
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    tokens,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

export function toolResultJSON(
  result: Awaited<ReturnType<Client["callTool"]>>,
) {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}
