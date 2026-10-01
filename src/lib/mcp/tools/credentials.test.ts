import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerCredentialTools } from "./credentials";

describe("manage_credentials TOTP inputs", () => {
  test("advertises configurable settings with API bounds", async () => {
    const { client, close } = await connectTestMcp(registerCredentialTools, {});
    try {
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "manage_credentials",
      );
      expect(tool?.inputSchema.properties?.totp_algorithm).toMatchObject({
        enum: ["SHA1", "SHA256", "SHA512"],
      });
      expect(tool?.inputSchema.properties?.totp_digits).toMatchObject({
        minimum: 6,
        maximum: 9,
      });
      expect(tool?.inputSchema.properties?.totp_period).toMatchObject({
        minimum: 15,
        maximum: 300,
      });
    } finally {
      await close();
    }
  });

  test("forwards typed settings and requires a new secret for changes", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerCredentialTools, {
      credentials: {
        create: async (params: unknown) => {
          calls.push(params);
          return { id: "credential-1" };
        },
        update: async (_id: string, params: unknown) => {
          calls.push(params);
          return { id: "credential-1" };
        },
      },
    });
    try {
      const settings = {
        totp_algorithm: "SHA512",
        totp_digits: 8,
        totp_period: 60,
      };
      await client.callTool({
        name: "manage_credentials",
        arguments: {
          action: "create",
          domain: "example.com",
          name: "test",
          values: { username: "test" },
          totp_secret: "A234567A234567A2",
          ...settings,
        },
      });
      expect(calls[0]).toMatchObject(settings);

      const rejected = await client.callTool({
        name: "manage_credentials",
        arguments: {
          action: "update",
          id_or_name: "credential-1",
          totp_digits: 8,
        },
      });
      expect(JSON.stringify(rejected)).toContain("require a new totp_secret");
      expect(calls).toHaveLength(1);

      await client.callTool({
        name: "manage_credentials",
        arguments: {
          action: "update",
          id_or_name: "credential-1",
          totp_secret: "A234567A234567A2",
          ...settings,
        },
      });
      expect(calls[1]).toMatchObject(settings);
    } finally {
      await close();
    }
  });
});
