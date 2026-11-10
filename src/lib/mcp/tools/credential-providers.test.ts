import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerCredentialProviderTools } from "./credential-providers";

describe("manage_credential_providers SDK coverage", () => {
  test("forwards list search and update false/zero values", async () => {
    const listCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerCredentialProviderTools,
      {
        credentialProviders: {
          list: async (params: unknown) => {
            listCalls.push(params);
            return {
              getPaginatedItems: () => [],
              has_more: false,
              next_offset: null,
            };
          },
          update: async (...args: unknown[]) => {
            updateCalls.push(args);
            return { id: "provider-1", name: "1Password" };
          },
        },
      },
    );

    try {
      await client.callTool({
        name: "manage_credential_providers",
        arguments: {
          action: "list",
          query: "onepassword",
          limit: 10,
          offset: 0,
        },
      });
      await client.callTool({
        name: "manage_credential_providers",
        arguments: {
          action: "update",
          id: "provider-1",
          enabled: false,
          priority: 0,
          cache_ttl_seconds: 0,
        },
      });

      expect(listCalls).toEqual([
        { query: "onepassword", limit: 10, offset: 0 },
      ]);
      expect(updateCalls).toEqual([
        ["provider-1", { enabled: false, priority: 0, cache_ttl_seconds: 0 }],
      ]);
    } finally {
      await close();
    }
  });
});
