import { describe, expect, test } from "bun:test";
import {
  DEPRECATED_TOOL_PARAMS,
  REMOVED_TOOL_PARAMS,
  removedParamMessage,
} from "@/lib/mcp/deprecated-params";
import { connectTestMcp, toolResultText } from "@/lib/mcp/mcp-test-fixtures";
import { registerMcpCapabilities } from "@/lib/mcp/register";

describe("deprecated tool params", () => {
  test("tracked tools advertise each deprecated param without schema references", async () => {
    const mcp = await connectTestMcp((server) => {
      registerMcpCapabilities(server, {
        mcpApps: true,
        vaults: true,
        search: true,
      });
    }, {});
    try {
      const { tools } = await mcp.client.listTools();
      for (const [toolName, params] of Object.entries(DEPRECATED_TOOL_PARAMS)) {
        const properties = tools.find((tool) => tool.name === toolName)
          ?.inputSchema.properties as
          | Record<string, { description?: string }>
          | undefined;
        expect(
          JSON.stringify(properties),
          `${toolName} input schema`,
        ).not.toContain('"$ref"');
        for (const param of params) {
          expect(
            properties?.[param]?.description,
            `${toolName}.${param}`,
          ).toStartWith("deprecated: ");
        }
      }
    } finally {
      await mcp.close();
    }
  });

  test("removed params are not advertised and fail with their replacement", async () => {
    const mcp = await connectTestMcp((server) => {
      registerMcpCapabilities(server, {
        mcpApps: true,
        vaults: true,
        search: true,
      });
    }, {});
    const validArgs: Record<keyof typeof REMOVED_TOOL_PARAMS, object> = {
      manage_browsers: { action: "create" },
      manage_auth_connections: { action: "list" },
      open_auth_login: { mode: "new_login", domain: "example.com" },
      begin_auth_login: { mode: "new_login", domain: "example.com" },
      manage_proxies: { action: "create", type: "isp" },
    };
    try {
      const { tools } = await mcp.client.listTools();
      for (const [toolName, removed] of Object.entries(REMOVED_TOOL_PARAMS)) {
        const name = toolName as keyof typeof REMOVED_TOOL_PARAMS;
        const properties = tools.find((tool) => tool.name === name)?.inputSchema
          .properties;
        for (const param of Object.keys(removed)) {
          expect(properties, `${name} input schema`).not.toHaveProperty(param);
          const result = await mcp.client.callTool({
            name,
            arguments: { ...validArgs[name], [param]: "removed" },
          });
          expect(result.isError, `${name}.${param}`).toBe(true);
          expect(toolResultText(result)).toContain(
            removedParamMessage(name, param)!,
          );
        }
      }
    } finally {
      await mcp.close();
    }
  });
});
