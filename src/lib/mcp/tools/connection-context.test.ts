/// <reference types="bun-types" />
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";

import { describe, expect, test } from "bun:test";
import { registerConnectionContextTool } from "@/lib/mcp/tools/connection-context";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
};

describe("get_connection_context", () => {
  test("returns the canonical request scope through MCP", async () => {
    const authContext = {
      authentication: {
        credential_id: "key_123",
        method: "api_key",
        source: "api_key",
      },
      authorization: {
        credential_scope: { project_id: null },
        effective_scope: { project_id: null },
        effective_policy: {
          statements: [
            {
              action: "browsers:use",
              resource: "projects/proj_1/browsers/*",
              condition: {
                key: "source_ip",
                operator: "in",
                values: ["203.0.113.0/24"],
              },
            },
          ],
        },
      },
      organization: { id: "org_123" },
      principal: { id: "svc_123", type: "service_account" },
      workload_identity: {
        external_subject_digest: "sha256:subject-digest",
        federation_rule_id: "wfr_123",
        issuer_id: "wii_123",
      },
    };
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerConnectionContextTool(server);

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
          extra: {
            connectionContext: {
              authContext,
              scope: {
                kind: "organization",
                organizationId: "org_123",
                projectId: null,
                source: "credential",
              },
            },
          },
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
      const contextTool = tools.tools.find(
        (tool) => tool.name === "get_connection_context",
      );
      expect(contextTool?.description).toContain("current effective policy");
      expect(contextTool?.description).toContain("workload_identity");

      const result = (await client.callTool({
        name: "get_connection_context",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(result.content[0].text)).toEqual({
        ...authContext,
        connection_scope: {
          kind: "organization",
          organization_id: "org_123",
          project_id: null,
          source: "credential",
          project_id_required: false,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
