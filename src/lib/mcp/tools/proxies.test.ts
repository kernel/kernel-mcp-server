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

  test("rejects a non-ipv4 ip_address in the schema", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient(creates),
    );
    try {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { action: "move", id_or_name: "prx_1", ip_address: "2001:db8::1" },
          "ip_address",
        ],
        [
          {
            action: "create",
            type: "isp",
            config: { ip_address: "not-an-ip" },
          },
          "config.ip_address",
        ],
      ];
      for (const [args, field] of cases) {
        const result = await client.callTool({
          name: "manage_proxies",
          arguments: args,
        });
        expect(result.isError).toBe(true);
        expect(toolResultText(result)).toContain(field);
      }
      expect(creates).toEqual([]);
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
        arguments: { action: "list", ip_address: "203.0.113.10" },
      });
      expect(lists).toEqual([
        { name: "us-residential" },
        { query: "residential", limit: 5 },
        { ip_address: "203.0.113.10" },
      ]);
    } finally {
      await close();
    }
  });

  test("pins a new isp proxy only through config.ip_address", async () => {
    const creates: unknown[] = [];
    const { client, close } = await connectTestMcp(
      registerProxyTools,
      proxyClient(creates),
    );
    try {
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "create",
          type: "isp",
          config: { ip_address: "203.0.113.10" },
        },
      });
      const result = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "create",
          type: "isp",
          ip_address: "203.0.113.10",
        },
      });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toBe(
        "error: use config.ip_address to pin a new isp proxy to a reserved ip.",
      );
      expect(creates).toEqual([
        { type: "isp", config: { ip_address: "203.0.113.10" } },
      ]);
    } finally {
      await close();
    }
  });

  test("moves an isp proxy to a reserved ip", async () => {
    const updates: unknown[] = [];
    const { client, close } = await connectTestMcp(registerProxyTools, {
      proxies: {
        update: async (idOrName: string, params: unknown) => {
          updates.push([idOrName, params]);
          return { id: idOrName };
        },
      },
    });
    try {
      const moved = await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "move",
          id_or_name: "prx_1",
          ip_address: "203.0.113.10",
        },
      });
      expect(toolResultJSON(moved)).toEqual({ id: "prx_1" });

      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { ip_address: "203.0.113.10" },
          "error: id_or_name is required for move.",
        ],
        [{ id_or_name: "prx_1" }, "error: ip_address is required for move."],
      ];
      for (const [args, message] of cases) {
        const result = await client.callTool({
          name: "manage_proxies",
          arguments: { action: "move", ...args },
        });
        expect(result.isError).toBe(true);
        expect(toolResultText(result)).toBe(message);
      }
      expect(updates).toEqual([
        ["prx_1", { config: { ip_address: "203.0.113.10" } }],
      ]);
    } finally {
      await close();
    }
  });

  test("lists and gets reserved ips", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerProxyTools, {
      proxyIPs: {
        list: async (params: unknown) => {
          calls.push(["list", params]);
          return {
            getPaginatedItems: () => [
              { ip_address: "203.0.113.10", country: "US", status: "active" },
            ],
            has_more: false,
          };
        },
        retrieve: async (ip: string) => {
          calls.push(["get", ip]);
          return { ip_address: ip, proxy_count: 0, proxies: [] };
        },
      },
    });
    try {
      await client.callTool({
        name: "manage_proxies",
        arguments: {
          action: "list_reserved_ips",
          ip_country: "GB",
          status: "active",
          limit: 5,
        },
      });
      const got = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "get_reserved_ip", ip_address: "203.0.113.10" },
      });
      expect(toolResultJSON(got)).toEqual({
        ip_address: "203.0.113.10",
        proxy_count: 0,
        proxies: [],
      });
      const missing = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "get_reserved_ip" },
      });
      expect(missing.isError).toBe(true);
      expect(toolResultText(missing)).toBe(
        "error: ip_address is required for get_reserved_ip.",
      );
      const deprecatedCountry = await client.callTool({
        name: "manage_proxies",
        arguments: { action: "list_reserved_ips", country: "GB" },
      });
      expect(deprecatedCountry.isError).toBe(true);
      expect(toolResultText(deprecatedCountry)).toBe(
        "error: use ip_country to filter reserved ips by country.",
      );
      expect(calls).toEqual([
        ["list", { country: "GB", status: "active", limit: 5 }],
        ["get", "203.0.113.10"],
      ]);
    } finally {
      await close();
    }
  });
});
