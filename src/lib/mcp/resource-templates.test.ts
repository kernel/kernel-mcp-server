import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { organizationWideAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  registerJsonResourceCollection,
  registerJsonResourceTemplate,
} from "@/lib/mcp/resource-templates";

type ResourceHandler = (
  uri: URL,
  variables: Record<string, string>,
  extra: { authInfo: ReturnType<typeof organizationWideAuthInfo> },
) => Promise<{ contents: Array<{ text: string }> }>;

function captureResources() {
  const resources = new Map<
    string,
    { template: ResourceTemplate; handler: ResourceHandler }
  >();
  const server = {
    resource(
      name: string,
      template: ResourceTemplate,
      handler: ResourceHandler,
    ) {
      resources.set(name, { template, handler });
    },
  } as unknown as McpServer;
  return { server, resources };
}

describe("project-qualified resources", () => {
  test("uses project identity from the URI for collections and items", async () => {
    const { server, resources } = captureResources();
    const projects: Array<string | undefined> = [];
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

    expect(resources.get("widgets")?.template.uriTemplate.toString()).toBe(
      "kernel://orgs/{organizationId}/projects/{projectId}/widgets",
    );
    const variables = {
      organizationId: "org_123",
      projectId: "proj_123",
    };
    const extra = { authInfo: organizationWideAuthInfo("org_123") };
    const collection = await resources
      .get("widgets")!
      .handler(
        new URL("kernel://orgs/org_123/projects/proj_123/widgets"),
        variables,
        extra,
      );
    const item = await resources
      .get("widget")!
      .handler(
        new URL("kernel://orgs/org_123/projects/proj_123/widgets/widget_1"),
        { ...variables, widgetId: "widget_1" },
        extra,
      );

    expect(JSON.parse(collection.contents[0].text)).toEqual([
      { id: "widget_1" },
    ]);
    expect(JSON.parse(item.contents[0].text)).toEqual({ id: "widget_1" });
    expect(projects).toEqual(["proj_123", "proj_123"]);
  });

  test("rejects a resource from another organization", async () => {
    const { server, resources } = captureResources();
    registerJsonResourceCollection(server, {
      name: "widgets",
      uriTemplate:
        "kernel://orgs/{organizationId}/projects/{projectId}/widgets",
      emptyText: "No widgets found",
      read: async () => [],
    });

    await expect(
      resources
        .get("widgets")!
        .handler(
          new URL("kernel://orgs/org_other/projects/proj_123/widgets"),
          { organizationId: "org_other", projectId: "proj_123" },
          { authInfo: organizationWideAuthInfo("org_123") },
        ),
    ).rejects.toThrow("Resource organization must match");
  });
});
