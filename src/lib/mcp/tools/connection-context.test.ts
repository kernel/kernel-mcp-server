import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import { registerConnectionContextTool } from "@/lib/mcp/tools/connection-context";

describe("get_connection_context", () => {
  test("returns the authoritative API auth context", async () => {
    let handler:
      | ((params: unknown, extra: unknown) => Promise<any>)
      | undefined;
    const server = {
      tool(
        _name: string,
        _description: string,
        _schema: object,
        ...rest: any[]
      ) {
        handler = rest[rest.length - 1];
      },
    } as unknown as McpServer;
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
    let receivedToken: string | undefined;

    registerConnectionContextTool(server, {
      createKernelClient: (token) => {
        receivedToken = token;
        return {
          auth: {
            context: { retrieve: async () => context },
          },
        } as unknown as KernelClient;
      },
    });

    const result = await handler!({}, { authInfo: { token: "secret-token" } });
    expect(receivedToken).toBe("secret-token");
    expect(JSON.parse(result.content[0].text)).toEqual(context);
  });
});
