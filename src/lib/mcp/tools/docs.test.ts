/// <reference types="bun-types" />
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { registerDocsTools } from "@/lib/mcp/tools/docs";

const configured = {
  token: process.env.MINTLIFY_ASSISTANT_API_TOKEN,
  domain: process.env.MINTLIFY_DOMAIN,
};

beforeEach(() => {
  delete process.env.MINTLIFY_ASSISTANT_API_TOKEN;
  delete process.env.MINTLIFY_DOMAIN;
});

afterEach(() => {
  if (configured.token)
    process.env.MINTLIFY_ASSISTANT_API_TOKEN = configured.token;
  if (configured.domain) process.env.MINTLIFY_DOMAIN = configured.domain;
});

test("search_docs reports missing configuration as a failure", async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerDocsTools(server);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const result = await client.callTool({
    name: "search_docs",
    arguments: { query: "how to deploy an app" },
  });
  await client.close();

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: "text",
      text: "Error: Documentation search is not configured (missing MINTLIFY_ASSISTANT_API_TOKEN or MINTLIFY_DOMAIN).",
    },
  ]);
});
