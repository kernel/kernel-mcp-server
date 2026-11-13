/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerConfigRegistryTools } from "@/lib/mcp/tools/config-registry";

describe("manage_config_registry SDK parity", () => {
  test("preserves a recommended reserved ISP IP in the nested create recipe", async () => {
    const recommendation = {
      type: "recommendation",
      browser: { stealth: true },
      evidence: {},
      match_scope: "exact",
      matched_target: "https://example.com",
      proxy: {
        mode: "managed",
        create: {
          type: "isp",
          config: {
            country: "US",
            ip_address: "203.0.113.10",
          },
        },
      },
    };
    let lookupInput: unknown;
    const { client, close } = await connectTestMcp(
      registerConfigRegistryTools,
      {
        configRegistry: {
          lookup: async (input: unknown) => {
            lookupInput = input;
            return {
              target: { url: "https://example.com" },
              recommendation,
              working_configurations: [recommendation],
            };
          },
        },
      },
    );

    try {
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "manage_config_registry",
      );
      expect(tool?.description).toContain("config.ip_address");

      const result = await client.callTool({
        name: "manage_config_registry",
        arguments: {
          action: "lookup",
          url: "https://example.com",
          allowed_proxy_countries: ["US"],
        },
      });
      expect(lookupInput).toEqual({
        url: "https://example.com",
        allowed_proxy_countries: ["US"],
      });
      expect(
        toolResultJSON(result).recommendation.proxy.create.config.ip_address,
      ).toBe("203.0.113.10");
    } finally {
      await close();
    }
  });
});
