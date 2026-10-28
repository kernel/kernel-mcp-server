import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest } from "./vaults.test-fixtures";

const target = { vault: "user-123", key: "example-login" };
const connectionID = "conn_example";

const managedAuthCredential = {
  id: "vi_managed_auth",
  key: target.key,
  type: "credential",
  version: 1,
  spec: {
    provider: "managed_auth",
    connection_id: connectionID,
    description: "Example",
  },
  state: {
    provider: "managed_auth",
    status: "ready",
    fields: {
      username: { type: "text", value: "private-user" },
      password: { type: "password", value: "private-password" },
      totp: { type: "totp", value: "private-seed" },
    },
  },
  available_operations: [
    { type: "fill", description: "Fill the current saved credential." },
  ],
  available_expansions: [],
};

describe("managed auth vault credentials", () => {
  test("creates a value-free reference to a saved managed auth credential", async () => {
    const fixture = await connectVaultTest([
      Response.json(managedAuthCredential),
    ]);
    try {
      const credentialTool = (await fixture.client.listTools()).tools.find(
        ({ name }) => name === "manage_vault_credentials",
      );
      expect(credentialTool?.inputSchema.properties?.provider).toMatchObject({
        enum: ["kernel", "1password", "managed_auth"],
      });
      expect(credentialTool?.description).toContain(
        'provider:"managed_auth"',
      );
      expect(credentialTool?.description).toContain(
        "follows future saved-credential changes",
      );

      const result = await fixture.call("manage_vault_credentials", {
        ...target,
        action: "create",
        provider: "managed_auth",
        spec: {
          connection_id: connectionID,
          description: "Example",
        },
      });

      expect(result.isError).toBeUndefined();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        path: "/vaults/user-123/items/example-login",
        body: {
          type: "credential",
          spec: {
            provider: "managed_auth",
            connection_id: connectionID,
            description: "Example",
          },
        },
      });
      const body = toolResultJSON(result);
      expect(body.item).toMatchObject({
        type: "credential",
        spec: {
          provider: "managed_auth",
          connection_id: connectionID,
          description: "Example",
        },
        state: {
          provider: "managed_auth",
          status: "ready",
          fields: {
            username: { type: "text" },
            password: { type: "password" },
            totp: { type: "totp" },
          },
        },
      });
      const text = JSON.stringify(body);
      expect(text).not.toContain("private-user");
      expect(text).not.toContain("private-password");
      expect(text).not.toContain("private-seed");
      const guidance = body.guidance.join(" ");
      expect(guidance).toContain("stores no values of its own");
      expect(guidance).toContain("manage_auth_connections");
      expect(guidance).toContain("there is no collection form");
      expect(guidance).toContain("totp field produces a current code");
      expect(guidance).not.toContain("present the collection url");
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      action: "create",
      provider: "managed_auth",
      spec: { description: "Missing connection" },
    },
    {
      action: "update",
      provider: "managed_auth",
      version: 1,
      spec: { description: "Replacement" },
    },
    { action: "connect_account", provider: "managed_auth" },
  ])(
    "rejects invalid managed auth $action input before sending",
    async (args) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_credentials", {
          ...target,
          ...args,
        });
        expect(result.isError).toBe(true);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );
});
