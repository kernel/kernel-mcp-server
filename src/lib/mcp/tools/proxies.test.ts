/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import {
  connectTestMcp,
  toolResultJSON,
  toolResultText,
} from "@/lib/mcp/mcp-test-fixtures";
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

  test("rejects an empty id_or_name in the schema", async () => {
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient([]),
    );
    try {
      const result = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "get", id_or_name: "" },
      });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toContain("id_or_name");
    } finally {
      await close();
    }
  });

  test("rejects an empty deprecated proxy_id in the schema", async () => {
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient([]),
    );
    try {
      const result = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "get", proxy_id: "" },
      });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toContain("proxy_id");
    } finally {
      await close();
    }
  });

  test("names id_or_name when a proxy selector is missing", async () => {
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient([]),
    );
    try {
      const result = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "delete" },
      });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toBe(
        "error: id_or_name is required for delete.",
      );
    } finally {
      await close();
    }
  });

  test("rejects removed flat fields or missing custom host and port", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient(creates),
    );
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { type: "isp", country: "US" },
          "country was removed; use `config.country` instead.",
        ],
        [
          {
            type: "custom",
            custom_host: "proxy.example.com",
            custom_port: 8080,
          },
          "custom_host was removed; use `config.host` instead.",
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

  test("forwards id_or_name to get and write actions", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerProxyTools, {
      proxies: {
        retrieve: async (idOrName: string) => {
          calls.push(["get", idOrName]);
          return { id: "proxy-1", name: idOrName };
        },
        update: async (idOrName: string, params: unknown) => {
          calls.push(["rename", idOrName, params]);
          return { id: idOrName };
        },
        check: async (idOrName: string, params: unknown) => {
          calls.push(["check", idOrName, params]);
          return { ok: true };
        },
        delete: async (idOrName: string) => {
          calls.push(["delete", idOrName]);
        },
      },
    });
    try {
      await client.callTool({
        name: "manage_proxies",
        arguments: { action: "get", id_or_name: "exact-name" },
      });
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "rename",
          id_or_name: "prx_1",
          name: "renamed",
        },
      });
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "check",
          id_or_name: "prx_1",
          check_url: "https://example.com",
        },
      });
      await client.callTool({
        name: "manage_proxies",
        arguments: { action: "delete", id_or_name: "prx_1" },
      });

      expect(calls).toEqual([
        ["get", "exact-name"],
        ["rename", "prx_1", { name: "renamed" }],
        ["check", "prx_1", { url: "https://example.com" }],
        ["delete", "prx_1"],
      ]);
    } finally {
      await close();
    }
  });

  test("rejects id_or_name mixed with the legacy proxy_id", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerProxyTools, {
      proxies: {
        retrieve: async () => {
          calls++;
          return {};
        },
      },
    });
    try {
      const result = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "get",
          id_or_name: "proxy-name",
          proxy_id: "prx_1",
        },
      });
      expect(result.isError).toBe(true);
      expect(calls).toBe(0);
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
      await client.callTool({
        name: "manage_proxies",
        arguments: { action: "list", ip_address: "203.0.113.10", offset: 0 },
      });
      expect(lists).toEqual([
        { name: "us-residential" },
        { query: "residential", limit: 5 },
        { ip_address: "203.0.113.10", offset: 0 },
      ]);
    } finally {
      await close();
    }
  });

  test("pins, filters, and moves reserved IPv4 addresses", async () => {
    const creates: unknown[] = [];
    const updates: unknown[][] = [];
    const { client, close } = await connectTestMcp(registerProxyTools, {
      proxies: {
        create: async (params: unknown) => {
          creates.push(params);
          return { id: "prx_1" };
        },
        update: async (...args: unknown[]) => {
          updates.push(args);
          return { id: args[0] };
        },
      },
    });
    try {
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "create",
          type: "isp",
          config: { ip_address: "203.0.113.10" },
        },
      });
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "move",
          id_or_name: "prx_1",
          ip_address: "203.0.113.11",
        },
      });
      expect(creates).toEqual([
        { type: "isp", config: { ip_address: "203.0.113.10" } },
      ]);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.slice(0, 2)).toEqual([
        "prx_1",
        { config: { ip_address: "203.0.113.11" } },
      ]);
      expect(updates[0]?.[2]).toMatchObject({ maxRetries: 0 });

      const wrongCreateField = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "create",
          type: "isp",
          ip_address: "203.0.113.12",
        },
      });
      expect(toolResultText(wrongCreateField)).toBe(
        "error: use config.ip_address to pin a new isp proxy to a reserved ip.",
      );

      const wrongType = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "create",
          type: "residential",
          config: { ip_address: "203.0.113.12" },
        },
      });
      expect(toolResultText(wrongType)).toBe(
        "error: config.ip_address is supported only for isp proxies.",
      );
    } finally {
      await close();
    }
  });

  test("rejects non-IPv4 reserved IP inputs", async () => {
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient([]),
    );
    try {
      for (const arguments_ of [
        {
          action: "move",
          id_or_name: "prx_1",
          ip_address: "2001:db8::1",
        },
        {
          action: "create",
          type: "isp",
          config: { ip_address: "not-an-ip" },
        },
      ]) {
        const result = await client.callTool({
          name: "manage_proxies",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
        expect(toolResultText(result)).toContain("ip_address");
      }
    } finally {
      await close();
    }
  });

  test("rejects reserved-IP filters on actions that would ignore them", async () => {
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient([]),
    );
    try {
      const wrongStatus = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "list", status: "active" },
      });
      expect(toolResultText(wrongStatus)).toBe(
        "error: ip_country and status apply only to list_reserved_ips.",
      );

      const wrongIP = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "rename",
          id_or_name: "prx_1",
          name: "renamed",
          ip_address: "203.0.113.10",
        },
      });
      expect(toolResultText(wrongIP)).toContain(
        "ip_address applies only to list, move, and get_reserved_ip",
      );
    } finally {
      await close();
    }
  });

  test("lists and retrieves reserved ISP IPs with pagination filters", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerProxyTools, {
      proxyIPs: {
        list: async (params: unknown) => {
          calls.push(["list", params]);
          return {
            getPaginatedItems: () => [
              { ip_address: "203.0.113.10", country: "GB", status: "active" },
            ],
            has_more: false,
            next_offset: null,
          };
        },
        retrieve: async (ipAddress: string) => {
          calls.push(["get", ipAddress]);
          return {
            ip_address: ipAddress,
            country: "GB",
            status: "active",
            proxy_count: 1,
            proxies: [{ id: "prx_1" }],
          };
        },
      },
    });
    try {
      const listed = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "list_reserved_ips",
          ip_country: "GB",
          status: "active",
          limit: 5,
          offset: 0,
        },
      });
      expect(toolResultJSON(listed).items).toHaveLength(1);

      const got = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "get_reserved_ip",
          ip_address: "203.0.113.10",
        },
      });
      expect(toolResultJSON(got)).toMatchObject({
        ip_address: "203.0.113.10",
        proxy_count: 1,
      });
      expect(calls).toEqual([
        [
          "list",
          { country: "GB", status: "active", limit: 5, offset: 0 },
        ],
        ["get", "203.0.113.10"],
      ]);
    } finally {
      await close();
    }
  });
});
