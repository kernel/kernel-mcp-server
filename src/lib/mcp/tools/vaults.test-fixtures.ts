import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { Kernel } from "@onkernel/sdk";
import { projectScopedAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import { registerVaultCapabilities } from "@/lib/mcp/tools/vaults";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";
import type { McpDependencies } from "@/lib/mcp/dependencies";

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
  spec: {
    provider: "link",
    wallet: "wallet-1",
    browser_id: "browser-session-id",
    page_url: "https://shop.example/checkout",
  },
  state: { provider: "link", status: "ready" },
  available_operations: [
    {
      type: "fill",
      description:
        "Invoke fill with browser_id and page_url exactly as stored in this item's spec, and omit fields.",
    },
  ],
  available_expansions: [],
};
export const linkSpec = {
  wallet: "wallet-1",
  browser_id: "browser-session-id",
  page_url: "https://shop.example/checkout",
  payment_method_id: "pm_example",
  amount: 1234,
  currency: "USD",
  merchant_name: "Example Shop",
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
  replies: Array<Response | Error>,
  authInfo: AuthInfo | null = projectScopedAuthInfo(),
  includeBrowsers = false,
) {
  const requests: RequestRecord[] = [];
  const server = new McpServer({ name: "vault-test", version: "0.0.0" });
  const dependencies: McpDependencies = {
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
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          return (
            reply ??
            Response.json(
              { message: "Unexpected extra request" },
              { status: 500 },
            )
          );
        },
      }),
  };
  registerVaultCapabilities(server, dependencies);
  if (includeBrowsers) registerBrowserCapabilities(server, dependencies);
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
