import { describe, expect, test } from "bun:test";
import { DEPRECATED_TOOL_PARAMS } from "@/lib/mcp/deprecated-params";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
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
});
