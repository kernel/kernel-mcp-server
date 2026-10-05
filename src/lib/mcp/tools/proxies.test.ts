/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerProxyTools } from "@/lib/mcp/tools/proxies";

function proxyClient(creates: unknown[], lists: unknown[] = []) {
  return {
    proxies: {
      create: async (params: unknown) => {
        creates.push(params);
        return { id: "proxy-1" };
      },
      list: async (params: unknown) => {
        lists.push(params);
        return { getPaginatedItems: () => [], has_more: false };
      },
    },
  };
}

describe("manage_proxies", () => {
  test("passes config, bypass_hosts, and protocol through SDK create", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient(creates),
    );
    try {
      const residential = {
        action: "create",
        type: "residential",
        name: "us-residential",
        config: { country: "US", state: "OH", zip: "45202", asn: "7922" },
        bypass_hosts: ["internal.example.com"],
        protocol: "https",
      };
      const custom = {
        action: "create",
        type: "custom",
        config: { host: "proxy.example.com", port: 8080, ca_bundle: "pem" },
      };
      for (const args of [residential, custom]) {
        const result = await client.callTool({
          name: "manage_proxies",
          arguments: args,
        });
        expect(toolResultJSON(result)).toEqual({ id: "proxy-1" });
      }
      expect(creates).toEqual([
        {
          type: "residential",
          name: "us-residential",
          config: residential.config,
          bypass_hosts: residential.bypass_hosts,
          protocol: "https",
        },
        { type: "custom", config: custom.config },
      ]);
    } finally {
      await close();
    }
  });

  test("keeps the deprecated flat create fields working", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient(creates),
    );
    try {
      await client.callTool({
        name: "manage_proxies",
        arguments: { action: "create", type: "isp", country: "US" },
      });
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "create",
          type: "custom",
          custom_host: "proxy.example.com",
          custom_port: 8080,
        },
      });
      expect(creates).toEqual([
        { type: "isp", config: { country: "US" } },
        {
          type: "custom",
          config: { host: "proxy.example.com", port: 8080 },
        },
      ]);
    } finally {
      await close();
    }
  });

  test("rejects config mixed with deprecated fields or missing custom host and port", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient(creates),
    );
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { type: "isp", config: { country: "US" }, country: "CA" },
          "config cannot be combined with country",
        ],
        [
          { type: "custom", config: { host: "proxy.example.com" } },
          "config.host and config.port are required",
        ],
      ];
      for (const [args, message] of cases) {
        const result = await client.callTool({
          name: "manage_proxies",
          arguments: { action: "create", ...args },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(message);
      }
      expect(creates).toEqual([]);
    } finally {
      await close();
    }
  });

  test("passes name and query filters to list", async () => {
    const lists: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient([], lists),
    );
    try {
      await client.callTool({
        name: "manage_proxies",
        arguments: { action: "list", name: "us-residential" },
      });
      await client.callTool({
        name: "manage_proxies",
        arguments: { action: "list", query: "residential", limit: 5 },
      });
      expect(lists).toEqual([
        { name: "us-residential" },
        { query: "residential", limit: 5 },
      ]);
    } finally {
      await close();
    }
  });
});
