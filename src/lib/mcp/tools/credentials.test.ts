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
});
