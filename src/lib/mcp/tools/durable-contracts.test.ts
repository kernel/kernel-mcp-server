/// <reference types="bun-types" />

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { kernelClientMock } from "@/lib/mcp/kernel-client.test-fixtures";

const { registerProfileCapabilities } = await import(
  "@/lib/mcp/tools/profiles"
);
const { registerProxyTools } = await import("@/lib/mcp/tools/proxies");

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ToolHandler = (
  params: Record<string, unknown>,
  extra: { authInfo?: { token: string } },
) => Promise<ToolResult>;

function captureTool(register: (server: McpServer) => void, name: string) {
  let handler: ToolHandler | undefined;
  const server = {
    resource() {},
    tool(toolName: string, ...args: unknown[]) {
      if (toolName === name) {
        handler = args.at(-1) as ToolHandler;
      }
    },
  } as unknown as McpServer;

  register(server);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler;
}

function profilePage(profiles: Array<{ id: string; name: string }>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* profiles;
    },
  };
}

const auth = { authInfo: { token: "test-token" } };

describe("durable profile contracts", () => {
  test("creates a profile when no exact match exists", async () => {
    const listCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    const browserCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      profiles: {
        list: (params: unknown) => {
          listCalls.push(params);
          return profilePage([]);
        },
        create: async (params: unknown) => {
          createCalls.push(params);
          return { id: "profile-new", name: "Acme" };
        },
      },
      browsers: {
        create: async (params: unknown) => {
          browserCalls.push(params);
          return {
            session_id: "session-1",
            browser_live_view_url: "https://example.test/live",
          };
        },
      },
    });
    const handler = captureTool(registerProfileCapabilities, "manage_profiles");

    const result = await handler(
      { action: "setup", profile_name: "Acme" },
      auth,
    );

    expect(listCalls).toEqual([{ name: "Acme" }]);
    expect(createCalls).toEqual([{ name: "Acme" }]);
    expect(browserCalls).toEqual([
      {
        stealth: true,
        timeout_seconds: 300,
        profile: { id: "profile-new", save_changes: true },
      },
    ]);
    expect(result.isError).toBeUndefined();
  });

  test("rejects ambiguous exact profile matches", async () => {
    let browserCreated = false;
    kernelClientMock.factory = () => ({
      profiles: {
        list: () =>
          profilePage([
            { id: "profile-1", name: "Acme" },
            { id: "profile-2", name: "Acme" },
          ]),
      },
      browsers: {
        create: async () => {
          browserCreated = true;
        },
      },
    });
    const handler = captureTool(registerProfileCapabilities, "manage_profiles");

    const result = await handler(
      { action: "setup", profile_name: "Acme" },
      auth,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Error: multiple profiles match the exact name "Acme": Acme (ID: profile-1), Acme (ID: profile-2). Rename or delete duplicate profiles by ID, then retry setup.',
        },
      ],
      isError: true,
    });
    expect(browserCreated).toBe(false);
  });

  test("rejects a missing existing profile", async () => {
    let profileCreated = false;
    kernelClientMock.factory = () => ({
      profiles: {
        list: () => profilePage([]),
        create: async () => {
          profileCreated = true;
        },
      },
      browsers: {
        create: async () => {
          throw new Error("browser setup should not start");
        },
      },
    });
    const handler = captureTool(registerProfileCapabilities, "manage_profiles");

    const result = await handler(
      {
        action: "setup",
        profile_name: "Missing",
        update_existing: true,
      },
      auth,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Error: profile "Missing" does not exist. Omit update_existing to create it.',
        },
      ],
      isError: true,
    });
    expect(profileCreated).toBe(false);
  });

  test("loads the exact existing profile", async () => {
    let profileCreated = false;
    const browserCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      profiles: {
        list: () => profilePage([{ id: "profile-1", name: "Acme" }]),
        create: async () => {
          profileCreated = true;
        },
      },
      browsers: {
        create: async (params: unknown) => {
          browserCalls.push(params);
          return {
            session_id: "session-1",
            browser_live_view_url: "https://example.test/live",
          };
        },
      },
    });
    const handler = captureTool(registerProfileCapabilities, "manage_profiles");

    const result = await handler(
      { action: "setup", profile_name: "Acme", update_existing: true },
      auth,
    );

    expect(profileCreated).toBe(false);
    expect(browserCalls).toEqual([
      {
        stealth: true,
        timeout_seconds: 300,
        profile: { id: "profile-1", save_changes: true },
      },
    ]);
    expect(result.content[0].text).toContain(
      'Profile "Acme" loaded for update.',
    );
    expect(result.content[0].text).toContain("Profile ID: profile-1");
  });

  test("renames a profile through the SDK", async () => {
    const updateCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      profiles: {
        update: async (...args: unknown[]) => {
          updateCalls.push(args);
          return { id: "profile-1", name: "Renamed" };
        },
      },
    });
    const handler = captureTool(registerProfileCapabilities, "manage_profiles");

    for (const selector of [
      { profile_id: "profile-1" },
      { profile_name: "Acme" },
    ]) {
      const result = await handler(
        { action: "rename", ...selector, new_name: "Renamed" },
        auth,
      );

      expect(JSON.parse(result.content[0].text)).toEqual({
        id: "profile-1",
        name: "Renamed",
      });
    }
    expect(updateCalls).toEqual([
      ["profile-1", { name: "Renamed" }],
      ["Acme", { name: "Renamed" }],
    ]);
  });

  test.each([
    [
      "both profile identifiers",
      { profile_id: "profile-1", profile_name: "Acme", new_name: "New" },
      "Error: Cannot specify both profile_name and profile_id.",
    ],
    [
      "no profile identifier",
      { new_name: "New" },
      "Error: profile_name or profile_id is required for rename.",
    ],
    [
      "no new name",
      { profile_id: "profile-1" },
      "Error: new_name is required for rename.",
    ],
  ])("rejects rename with %s", async (_name, params, wantError) => {
    let updated = false;
    kernelClientMock.factory = () => ({
      profiles: {
        update: async () => {
          updated = true;
        },
      },
    });
    const handler = captureTool(registerProfileCapabilities, "manage_profiles");

    const result = await handler({ action: "rename", ...params }, auth);

    expect(result).toEqual({
      content: [{ type: "text", text: wantError }],
      isError: true,
    });
    expect(updated).toBe(false);
  });
});

describe("durable proxy contracts", () => {
  test("renames a proxy through the SDK", async () => {
    const updateCalls: unknown[] = [];
    kernelClientMock.factory = () => ({
      proxies: {
        update: async (...args: unknown[]) => {
          updateCalls.push(args);
          return { id: "proxy-1", name: "Renamed" };
        },
      },
    });
    const handler = captureTool(registerProxyTools, "manage_proxies");

    const result = await handler(
      { action: "rename", proxy_id: "proxy-1", name: "Renamed" },
      auth,
    );

    expect(updateCalls).toEqual([["proxy-1", { name: "Renamed" }]]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: "proxy-1",
      name: "Renamed",
    });
  });

  test.each([
    [
      "no proxy ID",
      { name: "Renamed" },
      "Error: proxy_id is required for rename.",
    ],
    ["no name", { proxy_id: "proxy-1" }, "Error: name is required for rename."],
  ])("rejects rename with %s", async (_name, params, wantError) => {
    let updated = false;
    kernelClientMock.factory = () => ({
      proxies: {
        update: async () => {
          updated = true;
        },
      },
    });
    const handler = captureTool(registerProxyTools, "manage_proxies");

    const result = await handler({ action: "rename", ...params }, auth);

    expect(result).toEqual({
      content: [{ type: "text", text: wantError }],
      isError: true,
    });
    expect(updated).toBe(false);
  });
});
