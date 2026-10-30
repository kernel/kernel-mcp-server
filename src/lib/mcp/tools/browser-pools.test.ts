/// <reference types="bun-types" />
import type { McpServer } from "@modelcontextprotocol/server";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod";
import { projectScopedExtra } from "@/lib/mcp/auth-context.test-fixtures";
import {
  kernelClientMock,
  resetKernelClientFactory,
} from "@/lib/mcp/kernel-client.test-fixtures";

const { registerBrowserPoolCapabilities } = await import(
  "@/lib/mcp/tools/browser-pools"
);

type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ReturnType<typeof projectScopedExtra>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureBrowserPoolTool() {
  let handler: ToolHandler | undefined;
  let schema: Record<string, z.ZodType> | undefined;
  let description: string | undefined;
  const server = {
    registerResource() {},
    registerTool(
      name: string,
      config: {
        description: string;
        inputSchema: z.ZodObject<Record<string, z.ZodType>>;
      },
      callback: ToolHandler,
    ) {
      if (name !== "manage_browser_pools") return;
      description = config.description;
      schema = config.inputSchema.shape;
      handler = callback;
    },
  } as unknown as McpServer;

  registerBrowserPoolCapabilities(server);
  if (!handler || !schema || !description)
    throw new Error("manage_browser_pools was not registered");
  return { handler, schema, description };
}

const auth = projectScopedExtra();

function pool() {
  return {
    id: "pool_1",
    name: "production",
    created_at: "2026-08-06T12:00:00Z",
    available_count: 2,
    acquired_count: 1,
    profile_id: "profile_resolved",
    extension_ids: ["extension_resolved"],
    browser_pool_config: {
      size: 3,
      profile: { name: "configured-profile-name" },
      extensions: [{ name: "configured-extension-name" }],
    },
  };
}

describe("browser-pool contract parity", () => {
  beforeEach(() => {
    resetKernelClientFactory();
  });

  afterEach(() => {
    resetKernelClientFactory();
  });

  test("validates API boundaries", () => {
    const { schema } = captureBrowserPoolTool();

    expect(schema.fill_rate_per_minute.safeParse(0).success).toBe(true);
    expect(schema.fill_rate_per_minute.safeParse(25).success).toBe(true);
    expect(schema.fill_rate_per_minute.safeParse(0.5).success).toBe(false);
    expect(schema.fill_rate_per_minute.safeParse(-1).success).toBe(false);
    expect(schema.timeout_seconds.safeParse(10).success).toBe(true);
    expect(schema.timeout_seconds.safeParse(259200).success).toBe(true);
    expect(schema.timeout_seconds.safeParse(9).success).toBe(false);
    expect(schema.timeout_seconds.safeParse(259201).success).toBe(false);
    expect(schema.timeout_seconds.safeParse(10.5).success).toBe(false);
    expect(schema.start_url.safeParse("").success).toBe(true);
    expect(schema.start_url.safeParse("https://example.com").success).toBe(
      true,
    );
    expect(schema.start_url.safeParse("not-a-url").success).toBe(false);
    for (const memory of ["1GiB", "2GiB", "4GiB", "8GiB", "16GiB"])
      expect(schema.memory.safeParse(memory).success).toBe(true);
    expect(schema.memory.safeParse("6GiB").success).toBe(false);
    expect(schema.expected_network.safeParse({}).success).toBe(true);
    expect(schema.id_or_name.safeParse("").success).toBe(false);
    expect(schema.name.safeParse("").success).toBe(false);
  });

  test("keeps ordinary create valid", async () => {
    const createCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      browserPools: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return pool();
        },
      },
    });
    const { handler } = captureBrowserPoolTool();

    const result = await handler({ action: "create", size: 1 }, auth);

    expect(createCalls).toEqual([{ size: 1 }]);
    expect(result.isError).toBeUndefined();
    const response = JSON.parse(result.content[0].text);
    expect(response.browser_pool.config).toMatchObject({
      profile_id: "profile_resolved",
      extension_ids: ["extension_resolved"],
    });
    expect(response.browser_pool.config).not.toHaveProperty("profile");
    expect(response.browser_pool.config).not.toHaveProperty("extensions");
  });

  test("rejects an update with no fields", async () => {
    let updated = false;
    kernelClientMock.factory = () => ({
      browserPools: {
        update: async () => {
          updated = true;
        },
      },
    });
    const { handler } = captureBrowserPoolTool();

    const result = await handler(
      { action: "update", id_or_name: "pool_1" },
      auth,
    );

    expect(result).toEqual({
      content: [
        { type: "text", text: "error: at least one update field is required." },
      ],
      isError: true,
    });
    expect(updated).toBe(false);
  });

  test.each(["clear_profile", "clear_extensions"])(
    "rejects update-only %s during create",
    async (clearField) => {
      kernelClientMock.factory = () => ({ browserPools: {} });
      const { handler } = captureBrowserPoolTool();

      const result = await handler(
        { action: "create", size: 1, [clearField]: true },
        auth,
      );

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "error: clear_profile and clear_extensions are update-only.",
          },
        ],
        isError: true,
      });
    },
  );

  test("rejects an empty start URL during create", async () => {
    kernelClientMock.factory = () => ({ browserPools: {} });
    const { handler } = captureBrowserPoolTool();

    const result = await handler(
      { action: "create", size: 1, start_url: "" },
      auth,
    );

    expect(result).toEqual({
      content: [
        { type: "text", text: "error: an empty start_url is update-only." },
      ],
      isError: true,
    });
  });

  test("sends explicit durable clears on update", async () => {
    const updateCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      browserPools: {
        update: async (...args: unknown[]) => {
          updateCalls.push(args);
          return {
            ...pool(),
            profile_id: undefined,
            extension_ids: [],
          };
        },
      },
    });
    const { handler } = captureBrowserPoolTool();

    const result = await handler(
      {
        action: "update",
        id_or_name: "pool_1",
        proxy_id: "",
        start_url: "",
        clear_profile: true,
        clear_extensions: true,
        chrome_policy: {},
      },
      auth,
    );

    expect(updateCalls).toEqual([
      [
        "pool_1",
        {
          proxy_id: "",
          start_url: "",
          profile: { id: "" },
          extensions: [],
          chrome_policy: {},
        },
      ],
    ]);
    expect(result.isError).toBeUndefined();
    const response = JSON.parse(result.content[0].text);
    expect(response.browser_pool.config.extension_ids).toEqual([]);
    expect(response.browser_pool.config).not.toHaveProperty("profile_id");
    expect(response.browser_pool.config).not.toHaveProperty("profile");
    expect(response.browser_pool.config).not.toHaveProperty("extensions");
  });

  test("forwards memory, region, optimistic network state, false, and zero", async () => {
    const createCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      browserPools: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return pool();
        },
        update: async (...args: unknown[]) => {
          updateCalls.push(args);
          return pool();
        },
      },
    });
    const { handler } = captureBrowserPoolTool();

    await handler(
      {
        action: "create",
        size: 1,
        headless: true,
        memory: "4GiB",
        region: "ap-southeast",
        fill_rate_per_minute: 0,
        refresh_on_profile_update: false,
        extensions: [{ id: "ext_1" }, { name: "second-extension" }],
        telemetry: {
          enabled: true,
          browser: { screenshot: { enabled: true } },
        },
      },
      auth,
    );
    await handler(
      {
        action: "update",
        id_or_name: "pool_1",
        headless: false,
        memory: "1GiB",
        expected_network: {},
        discard_all_idle: false,
        fill_rate_per_minute: 0,
        refresh_on_profile_update: false,
        extensions: [],
        telemetry: { enabled: false },
      },
      auth,
    );

    expect(createCalls).toEqual([
      {
        size: 1,
        headless: true,
        memory: "4GiB",
        region: "ap-southeast",
        fill_rate_per_minute: 0,
        refresh_on_profile_update: false,
        extensions: [{ id: "ext_1" }, { name: "second-extension" }],
        telemetry: {
          enabled: true,
          browser: { screenshot: { enabled: true } },
        },
      },
    ]);
    expect(updateCalls).toEqual([
      [
        "pool_1",
        {
          headless: false,
          memory: "1GiB",
          expected_network: {},
          discard_all_idle: false,
          fill_rate_per_minute: 0,
          refresh_on_profile_update: false,
          extensions: [],
          telemetry: { enabled: false },
        },
      ],
    ]);
  });

  test("passes network settings through create and update", async () => {
    const createCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const network = {
      private_hosts: ["*.preview.example.ts.net"],
      proxy_routes: [{ hosts: ["api.example.org"], proxy: { name: "backup" } }],
      allowed_hosts: ["example.com", "*.example.com"],
    };
    kernelClientMock.factory = () => ({
      browserPools: {
        create: async (params: unknown) => {
          createCalls.push(params);
          const created = pool();
          return {
            ...created,
            browser_pool_config: { ...created.browser_pool_config, network },
          };
        },
        update: async (...args: unknown[]) => {
          updateCalls.push(args);
          return pool();
        },
      },
    });
    const { handler } = captureBrowserPoolTool();

    const created = await handler({ action: "create", size: 1, network }, auth);
    const updated = await handler(
      {
        action: "update",
        id_or_name: "pool_1",
        network: { allowed_hosts: ["example.org"] },
      },
      auth,
    );
    const removed = await handler(
      { action: "update", id_or_name: "pool_1", network: {} },
      auth,
    );

    expect(createCalls).toEqual([{ size: 1, network }]);
    expect(updateCalls).toEqual([
      ["pool_1", { network: { allowed_hosts: ["example.org"] } }],
      ["pool_1", { network: {} }],
    ]);
    expect(
      JSON.parse(created.content[0].text).browser_pool.config.network,
    ).toEqual(network);
    expect(updated.isError).toBeUndefined();
    expect(removed.isError).toBeUndefined();
  });

  test("validates pool network inputs before calling the SDK", async () => {
    kernelClientMock.factory = () => ({ browserPools: {} });
    const { handler, schema } = captureBrowserPoolTool();

    expect(
      schema.network.safeParse({ allowed_hosts: ["example.com"] }).success,
    ).toBe(true);
    expect(schema.network.safeParse({ allowed_hosts: [] }).success).toBe(false);
    expect(schema.network.safeParse({ allowed_hosts: null }).success).toBe(
      false,
    );
    expect(
      schema.network.safeParse({
        allowed_hosts: Array(101).fill("example.com"),
      }).success,
    ).toBe(false);

    const result = await handler(
      {
        action: "update",
        id_or_name: "pool_1",
        network: { proxy_routes: [{ hosts: ["example.com"], proxy: {} }] },
      },
      auth,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "error: network.proxy_routes[0].proxy requires exactly one of id or name.",
        },
      ],
      isError: true,
    });
  });

  test("forwards acquire overrides and returns leased time, network, memory, and location", async () => {
    const network = { allowed_hosts: ["example.com"] };
    const location = {
      timezone: "America/New_York",
      timezone_source: "default",
      locale: "en-US",
      locale_source: "override",
    };
    const acquireCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      browserPools: {
        acquire: async (...args: unknown[]) => {
          acquireCalls.push(args);
          return {
            session_id: "brr_1",
            leased_at: "2026-08-08T12:34:56Z",
            pool: { id: "pool_1" },
            network,
            memory: "2GiB",
            location,
          };
        },
      },
    });
    const { handler, description } = captureBrowserPoolTool();

    const result = await handler(
      {
        action: "acquire",
        id_or_name: "pool_1",
        acquire_timeout_seconds: 0,
        name: "checkout-lease",
        profile_id: "profile_1",
        save_profile_changes: false,
        start_url: "https://example.com",
        tags: { flow: "checkout" },
        telemetry: { browser: { network: { enabled: false } } },
      },
      auth,
    );

    expect(description).toContain("leased_at");
    expect(acquireCalls).toEqual([
      [
        "pool_1",
        {
          acquire_timeout_seconds: 0,
          name: "checkout-lease",
          profile: { id: "profile_1", save_changes: false },
          start_url: "https://example.com",
          tags: { flow: "checkout" },
          telemetry: { browser: { network: { enabled: false } } },
        },
      ],
    ]);
    expect(JSON.parse(result.content[0].text).browser).toMatchObject({
      leased_at: "2026-08-08T12:34:56Z",
      network,
      memory: "2GiB",
      location,
    });
  });

  test("forwards list filters and pagination", async () => {
    const listCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      browserPools: {
        list: async (params: unknown) => {
          listCalls.push(params);
          return {
            getPaginatedItems: () => [],
            has_more: false,
            next_offset: null,
          };
        },
      },
    });
    const { handler } = captureBrowserPoolTool();

    await handler(
      {
        action: "list",
        name: "production",
        query: "prod",
        region: "us-west",
        limit: 5,
        offset: 0,
      },
      auth,
    );

    expect(listCalls).toEqual([
      {
        name: "production",
        query: "prod",
        region: "us-west",
        limit: 5,
        offset: 0,
      },
    ]);
  });

  test.each([
    [
      { clear_profile: true, profile_id: "profile_1" },
      "error: clear_profile cannot be combined with profile_id or profile_name.",
    ],
    [
      { clear_extensions: true, extension_name: "ublock" },
      "error: clear_extensions cannot be combined with extensions, extension_id, or extension_name.",
    ],
  ])("rejects conflicting clear and set values", async (params, wantError) => {
    kernelClientMock.factory = () => ({ browserPools: {} });
    const { handler } = captureBrowserPoolTool();

    const result = await handler(
      { action: "update", id_or_name: "pool_1", ...params },
      auth,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: wantError }],
      isError: true,
    });
  });

  test.each([
    [
      { action: "create", size: 1, tags: { team: "qa" } },
      "error: tags is acquire-only.",
    ],
    [
      { action: "update", id_or_name: "pool_1", tags: { team: "qa" } },
      "error: tags is acquire-only.",
    ],
    [
      { action: "update", id_or_name: "pool_1", region: "us-west", size: 5 },
      "error: region is fixed at create; on list it filters pools.",
    ],
    [
      { action: "update", id_or_name: "pool_1", region: "us-west" },
      "error: region is fixed at create; on list it filters pools.",
    ],
  ])("rejects fields the action would ignore: %p", async (params, text) => {
    let called = false;
    const record = async () => {
      called = true;
      return pool();
    };
    kernelClientMock.factory = () => ({
      browserPools: { create: record, update: record },
    });
    const { handler } = captureBrowserPoolTool();

    const result = await handler(params, auth);

    expect(result).toEqual({
      content: [{ type: "text", text }],
      isError: true,
    });
    expect(called).toBe(false);
  });
});
