import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Kernel } from "@onkernel/sdk";
import { projectScopedAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import { registerVaultCapabilities } from "@/lib/mcp/tools/vaults";

export const vault = {
  id: "vlt_123",
  name: "checkout",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
export const item = {
  id: "vi_123",
  key: "order-1",
  type: "card",
  spec: { provider: "link", wallet: "wallet-1" },
  state: { provider: "link", status: "requested" },
  available_operations: [
    {
      type: "authorize",
      description: "Obtain explicit user approval before authorizing.",
    },
  ],
  available_expansions: [],
};
export const linkSpec = {
  wallet: "wallet-1",
  payment_method_id: "pm_example",
  amount: 1234,
  currency: "USD",
  merchant_name: "Example Shop",
  merchant_url: "https://shop.example",
  context:
    "Purchase the selected office supplies from Example Shop for the approved order, with a total spending limit of 1234 minor currency units.",
};
export const agentcardSpec = {
  wallet: "wallet-1",
  merchant: "Example Shop",
  amount: 1234,
  currency: "USD",
};

type RequestRecord = {
  method: string;
  path: string;
  headers: Headers;
  body?: unknown;
};

export async function connectVaultTest(
  replies: Response[],
  authInfo: AuthInfo | null = projectScopedAuthInfo(),
) {
  const requests: RequestRecord[] = [];
  const server = new McpServer({ name: "vault-test", version: "0.0.0" });
  registerVaultCapabilities(server, {
    createKernelClient: (token, project) =>
      new Kernel({
        apiKey: token,
        project,
        baseURL: "https://api.example",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const text = await request.text();
          requests.push({
            method: request.method,
            path: url.pathname + url.search,
            headers: request.headers,
            ...(text && { body: JSON.parse(text) }),
          });
          return (
            replies.shift() ??
            Response.json(
              { message: "Unexpected extra request" },
              { status: 500 },
            )
          );
        },
      }),
  });
  const client = new Client({ name: "vault-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, { ...options, authInfo: authInfo ?? undefined });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    requests,
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }),
    close: () => Promise.all([client.close(), server.close()]),
  };
}
