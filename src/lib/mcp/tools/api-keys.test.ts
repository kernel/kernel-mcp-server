/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerAPIKeyCapabilities } from "@/lib/mcp/tools/api-keys";

async function callAPIKeys(apiKeys: unknown, args: Record<string, unknown>[]) {
  const { client, close } = await connectTestMcp(registerAPIKeyCapabilities, {
    apiKeys,
  });
  try {
    const results = [];
    for (const call of args) {
      results.push(
        await client.callTool({ name: "manage_api_keys", arguments: call }),
      );
    }
    return results;
  } finally {
    await close();
  }
}

describe("manage_api_keys SDK parity", () => {
  test("advertises last-used sorting and null ordering", async () => {
    const { client, close } = await connectTestMcp(
      registerAPIKeyCapabilities,
      {},
    );
    try {
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "manage_api_keys",
      );
      expect(tool?.inputSchema.properties?.sort_by).toMatchObject({
        enum: ["created_at", "name", "expires_at", "last_used_at"],
        description: expect.stringContaining(
          "keys missing that value sort last in either direction",
        ),
      });
      expect(tool?.description).toContain(
        "delete/immediate rotation end attributed browsers asynchronously",
      );
      expect(tool?.description).toContain("grace or natural expiry does not");
      expect(tool?.description).toContain("service-account key");
      expect(tool?.description).toContain("source_ip");
      expect(tool?.inputSchema.properties?.service_account_id).toMatchObject({
        description: expect.stringContaining("created_by"),
      });
      expect(tool?.inputSchema.properties?.expire_in_days).toMatchObject({
        description: expect.stringContaining(
          "retains its service-account principal and policy",
        ),
      });
      expect(tool?.inputSchema.properties?.status).toMatchObject({
        enum: ["active", "expired", "deleted", "all"],
        description: expect.stringContaining(
          "active excludes deleted and expired",
        ),
      });
      expect(tool?.inputSchema.properties?.principal_type).toMatchObject({
        enum: ["user", "service_account"],
      });
      expect(tool?.inputSchema.properties).toHaveProperty("created_by");
      expect(tool?.inputSchema.properties?.project_id).toMatchObject({
        description: expect.stringContaining('"org"'),
      });
      expect(tool?.inputSchema.properties?.policy).toMatchObject({
        description: expect.stringContaining("fully replaces"),
      });
    } finally {
      await close();
    }
  });

  test("rejects an empty api_key_id in the schema", async () => {
    let called = false;
    const [result] = await callAPIKeys(
      {
        retrieve: async () => {
          called = true;
          return { id: "key_1" };
        },
      },
      [{ action: "get", api_key_id: "" }],
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("Input validation error");
    expect(text).toContain("api_key_id");
    expect(called).toBe(false);
  });

  test("forwards create policy and exact expiry", async () => {
    const calls: unknown[] = [];
    const policy = {
      statements: [
        {
          action: "browsers:use",
          resource: "projects/proj_1/browsers/*",
        },
      ],
    };

    const [result] = await callAPIKeys(
      {
        create: async (params: unknown) => {
          calls.push(params);
          return { id: "key_1", key: "secret-once" };
        },
      },
      [
        {
          action: "create",
          name: "browser-only",
          project_id: null,
          expires_at: null,
          policy,
        },
      ],
    );

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        name: "browser-only",
        project_id: null,
        expires_at: null,
        policy,
      },
    ]);
  });

  test("creates a service-account key with a source-ip condition", async () => {
    const calls: unknown[] = [];
    const policy = {
      statements: [
        {
          action: "browsers:use",
          resource: "projects/proj_1/browsers/*",
          condition: {
            key: "source_ip",
            operator: "in",
            values: ["203.0.113.0/24"],
          },
        },
      ],
    };

    const [result] = await callAPIKeys(
      {
        create: async (params: unknown) => {
          calls.push(params);
          return {
            id: "key_service",
            key: "secret-once",
            created_by: null,
            principal: { type: "service_account", id: "svc_1" },
            service_account_id: "svc_1",
          };
        },
      },
      [
        {
          action: "create",
          name: "worker",
          project_id: "proj_1",
          service_account_id: "svc_1",
          policy,
        },
      ],
    );

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        name: "worker",
        project_id: "proj_1",
        service_account_id: "svc_1",
        policy,
      },
    ]);
    expect(
      JSON.parse((result.content[0] as { text: string }).text),
    ).toMatchObject({
      created_by: null,
      principal: { type: "service_account", id: "svc_1" },
      service_account_id: "svc_1",
    });
  });

  test("replaces an API key policy without requiring a rename", async () => {
    const calls: unknown[] = [];
    const policy = {
      statements: [
        {
          action: "vaults:read",
          resource: "projects/proj_1/vaults/*",
          condition: {
            key: "source_ip",
            operator: "in",
            values: ["2001:db8::/32"],
          },
        },
      ],
    };

    const [result] = await callAPIKeys(
      {
        update: async (...args: unknown[]) => {
          calls.push(args);
          return { id: "key_1", name: "unchanged", policy };
        },
      },
      [{ action: "update", api_key_id: "key_1", policy }],
    );

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([["key_1", { policy }]]);
  });

  test("forwards list/get filters including false and zero offsets", async () => {
    const calls: unknown[] = [];

    await callAPIKeys(
      {
        list: async (params: unknown) => {
          calls.push(["list", params]);
          return {
            getPaginatedItems: () => [],
            has_more: false,
            next_offset: null,
          };
        },
        retrieve: async (...args: unknown[]) => {
          calls.push(["get", ...args]);
          return { id: "key_1" };
        },
      },
      [
        {
          action: "list",
          include_deleted: false,
          name: "staging",
          query: "stage",
          service_account_id: "svc_1",
          principal_type: "service_account",
          created_by: "user_1",
          project_id: "org",
          status: "expired",
          sort_by: "last_used_at",
          sort_direction: "asc",
          limit: 5,
          offset: 0,
        },
        { action: "get", api_key_id: "key_1", include_deleted: false },
      ],
    );

    expect(calls).toEqual([
      [
        "list",
        {
          include_deleted: false,
          name: "staging",
          query: "stage",
          service_account_id: "svc_1",
          principal_type: "service_account",
          created_by: "user_1",
          project_id: "org",
          status: "expired",
          sort_by: "last_used_at",
          sort_direction: "asc",
          limit: 5,
          offset: 0,
        },
      ],
      ["get", "key_1", { include_deleted: false }],
    ]);
  });

  test("preserves last-used timestamps in list and get responses", async () => {
    const lastUsedAt = "2026-10-26T12:34:56Z";
    const [listed, retrieved] = await callAPIKeys(
      {
        list: async () => ({
          getPaginatedItems: () => [
            { id: "key_used", last_used_at: lastUsedAt },
            { id: "key_unused", last_used_at: null },
          ],
          has_more: false,
          next_offset: null,
        }),
        retrieve: async () => ({
          id: "key_unused",
          last_used_at: null,
        }),
      },
      [{ action: "list" }, { action: "get", api_key_id: "key_unused" }],
    );

    expect(listed.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          items: [
            { id: "key_used", last_used_at: lastUsedAt },
            { id: "key_unused", last_used_at: null },
          ],
          has_more: false,
          next_offset: null,
        }),
      },
    ]);
    expect(retrieved.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ id: "key_unused", last_used_at: null }),
      },
    ]);
  });

  test("rotates with an immediate zero-day grace period", async () => {
    const calls: unknown[] = [];

    const [result] = await callAPIKeys(
      {
        rotate: async (...args: unknown[]) => {
          calls.push(args);
          return { id: "key_2", key: "replacement-secret" };
        },
      },
      [
        {
          action: "rotate",
          api_key_id: "key_1",
          days_to_expire: null,
          expire_in_days: 0,
        },
      ],
    );

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      ["key_1", { days_to_expire: null, expire_in_days: 0 }],
    ]);
  });

  test("rejects invalid input before the SDK", async () => {
    let calls = 0;
    const record = async () => {
      calls++;
    };

    const results = await callAPIKeys(
      { create: record, update: record, list: record },
      [
        { action: "list", created_by: "" },
        {
          action: "create",
          name: "conflict",
          days_to_expire: 30,
          expires_at: "2030-01-01T00:00:00Z",
        },
        { action: "create", name: "bad-expiry", expires_at: 30 },
        {
          action: "create",
          name: "missing-service-scope",
          service_account_id: "svc_1",
        },
        { action: "update", api_key_id: "key_1" },
        {
          action: "create",
          name: "too-many-networks",
          policy: {
            statements: [
              {
                action: "browsers:use",
                resource: "*",
                condition: {
                  key: "source_ip",
                  operator: "in",
                  values: Array.from(
                    { length: 17 },
                    (_, index) => `203.0.${index}.0/24`,
                  ),
                },
              },
            ],
          },
        },
      ],
    );

    for (const result of results) expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test.each([
    [
      "rotate",
      { expires_at: "2027-01-01T00:00:00Z" },
      "error: expires_at is create-only.",
    ],
    [
      "rotate",
      {
        policy: {
          statements: [{ action: "browsers:use", resource: "*" }],
        },
      },
      "error: policy applies only to create and update.",
    ],
    [
      "create",
      { name: "new", expire_in_days: 1 },
      "error: expire_in_days is rotate-only.",
    ],
    [
      "update",
      { name: "renamed", days_to_expire: 30 },
      "error: days_to_expire applies only to create and rotate.",
    ],
    [
      "get",
      { principal_type: "user" },
      "error: principal_type and created_by are list-only.",
    ],
    [
      "list",
      { project_id: null },
      'error: project_id cannot be null for list; use "org" for org-wide keys.',
    ],
  ])(
    "rejects %s parameters the SDK would drop: %p",
    async (action, extra, message) => {
      let called = false;
      const record = async () => {
        called = true;
        return { id: "key_1" };
      };
      const [result] = await callAPIKeys(
        { create: record, update: record, rotate: record },
        [{ action, api_key_id: "key_1", ...extra }],
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: message }]);
      expect(called).toBe(false);
    },
  );
});
