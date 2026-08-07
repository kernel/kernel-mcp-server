/// <reference types="bun-types" />

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  kernelClientMock,
  resetKernelClientFactory,
} from "@/lib/mcp/kernel-client.test-fixtures";

const { registerBrowserPoolCapabilities } = await import(
  "@/lib/mcp/tools/browser-pools"
);

type ToolHandler = (
  params: Record<string, unknown>,
  extra: { authInfo?: { token: string } },
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureBrowserPoolTool() {
  let handler: ToolHandler | undefined;
  let schema: z.ZodRawShape | undefined;
  const server = {
    resource() {},
    registerResource() {},
    tool(name: string, ...args: unknown[]) {
      if (name !== "manage_browser_pools") return;
      schema = args[1] as z.ZodRawShape;
      handler = args.at(-1) as ToolHandler;
    },
  } as unknown as McpServer;

  registerBrowserPoolCapabilities(server);
  if (!handler || !schema)
    throw new Error("manage_browser_pools was not registered");
  return { handler, schema };
}

const auth = { authInfo: { token: "test-token" } };

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
        { type: "text", text: "Error: at least one update field is required." },
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
            text: "Error: clear_profile and clear_extensions are update-only.",
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
        { type: "text", text: "Error: an empty start_url is update-only." },
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

  test.each([
    [
      { clear_profile: true, profile_id: "profile_1" },
      "Error: clear_profile cannot be combined with profile_id or profile_name.",
    ],
    [
      { clear_extensions: true, extension_name: "ublock" },
      "Error: clear_extensions cannot be combined with extension_id or extension_name.",
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
});
