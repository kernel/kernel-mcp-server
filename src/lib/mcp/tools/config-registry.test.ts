/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerConfigRegistryTool } from "@/lib/mcp/tools/config-registry";

const recommendation = {
  type: "recommendation",
  browser: {
    stealth: false,
    headless: false,
    gpu: false,
    viewport: { width: 1920, height: 1080 },
  },
  proxy: {
    mode: "managed",
    create: { type: "isp", config: { country: "US" } },
  },
  match_scope: "exact",
  matched_target: "https://example.com/",
  evidence: {
    success_rate: 1,
    sample_size: 3,
    accessed: 3,
    blocked: 0,
    inconclusive: 0,
    run_count: 1,
    last_observed_at: "2026-09-17T00:00:00Z",
  },
};

function configRegistryClient(
  calls: Array<{ action: string; value: unknown }>,
) {
  return {
    configRegistry: {
      lookup: async (value: unknown) => {
        calls.push({ action: "lookup", value });
        return {
          target: {
            normalized: "https://example.com/",
            host: "example.com",
            domain: "example.com",
          },
          recommendation,
          working_configurations: [recommendation],
        };
      },
      resolve: async (value: unknown) => {
        calls.push({ action: "resolve", value });
        return {
          target: {
            normalized: "https://example.com/",
            host: "example.com",
            domain: "example.com",
          },
          analysis: {
            id: "analysis_123",
            status: "running",
            failure: null,
            created_at: "2026-09-17T00:00:00Z",
            expires_at: "2026-09-17T00:10:00Z",
            finished_at: null,
          },
          recommendation: null,
          working_configurations: [],
        };
      },
      analyses: {
        retrieve: async (value: unknown) => {
          calls.push({ action: "get_analysis", value });
          return {
            target: {
              normalized: "https://example.com/",
              host: "example.com",
              domain: "example.com",
            },
            analysis: {
              id: "analysis_123",
              status: "completed",
              failure: null,
              created_at: "2026-09-17T00:00:00Z",
              expires_at: "2026-09-17T00:10:00Z",
              finished_at: "2026-09-17T00:02:00Z",
            },
            recommendation,
            working_configurations: [recommendation],
          };
        },
      },
    },
  };
}

describe("resolve_browser_config", () => {
  test("returns cached recommendations without starting an analysis", async () => {
    const calls: Array<{ action: string; value: unknown }> = [];
    const { client, close } = await connectTestMcp(
      registerConfigRegistryTool,
      configRegistryClient(calls),
    );

    try {
      const result = toolResultJSON(
        await client.callTool({
          name: "resolve_browser_config",
          arguments: {
            action: "lookup",
            url: "https://example.com/",
            allowed_proxy_countries: ["US"],
          },
        }),
      );

      expect(result.recommendation).toEqual(recommendation);
      expect(calls).toEqual([
        {
          action: "lookup",
          value: {
            url: "https://example.com/",
            allowed_proxy_countries: ["US"],
          },
        },
      ]);
    } finally {
      await close();
    }
  });

  test("starts and polls a missing analysis", async () => {
    const calls: Array<{ action: string; value: unknown }> = [];
    const { client, close } = await connectTestMcp(
      registerConfigRegistryTool,
      configRegistryClient(calls),
    );

    try {
      const started = toolResultJSON(
        await client.callTool({
          name: "resolve_browser_config",
          arguments: {
            action: "resolve",
            url: "https://example.com/",
            intent: "Sign in through the site's normal account login.",
          },
        }),
      );
      const completed = toolResultJSON(
        await client.callTool({
          name: "resolve_browser_config",
          arguments: {
            action: "get_analysis",
            analysis_id: started.analysis.id,
          },
        }),
      );

      expect(completed.analysis.status).toBe("completed");
      expect(completed.recommendation).toEqual(recommendation);
      expect(calls).toEqual([
        {
          action: "resolve",
          value: {
            url: "https://example.com/",
            intent: "Sign in through the site's normal account login.",
          },
        },
        { action: "get_analysis", value: "analysis_123" },
      ]);
    } finally {
      await close();
    }
  });

  test("requires action-specific identifiers", async () => {
    const { client, close } = await connectTestMcp(
      registerConfigRegistryTool,
      configRegistryClient([]),
    );

    try {
      const result = await client.callTool({
        name: "resolve_browser_config",
        arguments: { action: "get_analysis" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "analysis_id is required",
      );

      const empty = await client.callTool({
        name: "resolve_browser_config",
        arguments: { action: "get_analysis", analysis_id: "" },
      });
      expect(empty.isError).toBe(true);
      expect(JSON.stringify(empty.content)).toContain(
        "String must contain at least 1 character",
      );
    } finally {
      await close();
    }
  });
});
