import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { organizationWideAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  registerJsonResourceCollection,
  registerJsonResourceTemplate,
} from "@/lib/mcp/resource-templates";

type TextResourceResult = {
  contents: Array<{ text: string }>;
};

async function connectResourceClient(organizationId = "org_123") {
  const projects: Array<string | undefined> = [];
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const dependencies = {
    createKernelClient: (_token: string, projectId?: string) => {
      projects.push(projectId);
      return {} as KernelClient;
    },
  };

  registerJsonResourceCollection(
    server,
    {
      name: "widgets",
      uriTemplate:
        "kernel://orgs/{organizationId}/projects/{projectId}/widgets",
      emptyText: "No widgets found",
      read: async () => [{ id: "widget_1" }],
    },
    dependencies,
  );
  registerJsonResourceTemplate(
    server,
    {
      name: "widget",
      uriTemplate:
        "kernel://orgs/{organizationId}/projects/{projectId}/widgets/{widgetId}",
      variableName: "widgetId",
      resourceLabel: "Widget",
      read: async (_client, widgetId) => ({ id: widgetId }),
    },
    dependencies,
  );

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: organizationWideAuthInfo(organizationId),
    });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server, projects };
}

describe("project-qualified resources", () => {
  test("matches templates and scopes collection and item reads over MCP", async () => {
    const { client, server, projects } = await connectResourceClient();
    try {
      const templates = await client.listResourceTemplates();
      expect(
        templates.resourceTemplates.map((template) => template.uriTemplate),
      ).toEqual([
        "kernel://orgs/{organizationId}/projects/{projectId}/widgets",
        "kernel://orgs/{organizationId}/projects/{projectId}/widgets/{widgetId}",
      ]);

      const collection = (await client.readResource({
        uri: "kernel://orgs/org_123/projects/proj_123/widgets",
      })) as TextResourceResult;
      const item = (await client.readResource({
        uri: "kernel://orgs/org_123/projects/proj_123/widgets/widget_1",
      })) as TextResourceResult;

      expect(JSON.parse(collection.contents[0].text)).toEqual([
        { id: "widget_1" },
      ]);
      expect(JSON.parse(item.contents[0].text)).toEqual({ id: "widget_1" });
      expect(projects).toEqual(["proj_123", "proj_123"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects another organization's resource over MCP", async () => {
    const { client, server } = await connectResourceClient();
    try {
      await expect(
        client.readResource({
          uri: "kernel://orgs/org_other/projects/proj_123/widgets",
        }),
      ).rejects.toThrow("Resource organization must match");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
