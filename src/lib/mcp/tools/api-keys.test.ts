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
          status: "all",
          sort_by: "expires_at",
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
          status: "all",
          sort_by: "expires_at",
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
    const create = async () => {
      calls++;
    };

    const results = await callAPIKeys({ create }, [
      {
        action: "create",
        name: "conflict",
        days_to_expire: 30,
        expires_at: "2030-01-01T00:00:00Z",
      },
      { action: "create", name: "bad-expiry", expires_at: 30 },
    ]);

    for (const result of results) expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test.each([
    [
      "rotate",
      { expires_at: "2027-01-01T00:00:00Z" },
      "error: expires_at and policy are create-only.",
    ],
    [
      "rotate",
      {
        policy: {
          statements: [{ action: "browsers:use", resource: "*" }],
        },
      },
      "error: expires_at and policy are create-only.",
    ],
    [
      "update",
      {
        name: "renamed",
        policy: {
          statements: [{ action: "browsers:use", resource: "*" }],
        },
      },
      "error: expires_at and policy are create-only.",
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
