import { describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import {
  initializeDeclaresMcpApps,
  MANAGED_AUTH_MIME_TYPE,
  MANAGED_AUTH_RESOURCE_URI,
  managedAuthResourceMeta,
  registerAuthLoginApp,
} from "@/lib/mcp/tools/auth-login-app";

// Tests that exercise API-backed handlers substitute a fake Kernel client.
// The default stub errors if any API method is actually invoked.
const unusedKernelClient = new Proxy(
  {},
  {
    get: () => {
      throw new Error("unexpected Kernel client use");
    },
  },
);
let kernelClientFactory: (token: string) => any = () => unusedKernelClient;
function resetKernelClientFactory() {
  kernelClientFactory = () => unusedKernelClient;
}

// The capability gate falls back to a Redis marker (recorded by the route
// layer at initialize) on stateless transports. Tests control it directly.
let redisMarkerPresent = false;
mock.module("@/lib/redis", () => ({
  hasMcpAppsClient: async () => redisMarkerPresent,
  markMcpAppsClient: async () => {},
}));
mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: (token: string) => kernelClientFactory(token),
}));

type ToolRegistration = {
  config: Record<string, any>;
  handler: (params: any, extra: any) => Promise<any>;
};

function captureRegistration({ appsSupport = true } = {}) {
  const tools = new Map<string, ToolRegistration>();
  let resource:
    | {
        uri: string;
        config: Record<string, any>;
        handler: (uri: URL) => Promise<any>;
      }
    | undefined;
  const clientCapabilities = appsSupport
    ? {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: [MANAGED_AUTH_MIME_TYPE],
          },
        },
      }
    : {};
  const registrationHandle = () => ({
    enable() {},
    disable() {},
  });
  const server = {
    server: {
      getClientCapabilities: () => clientCapabilities,
    },
    registerResource(
      _name: string,
      uri: string,
      config: Record<string, any>,
      handler: (uri: URL) => Promise<any>,
    ) {
      resource = { uri, config, handler };
      return registrationHandle();
    },
    registerTool(
      name: string,
      config: Record<string, any>,
      handler: ToolRegistration["handler"],
    ) {
      tools.set(name, { config, handler });
      return registrationHandle();
    },
  } as unknown as McpServer;
  registerAuthLoginApp(server);
  return {
    tools,
    get resource() {
      return resource;
    },
  };
}

describe("managed-auth MCP App registration", () => {
  test("uses exact resource MIME, URI, and CSP on registration and read", async () => {
    process.env.MANAGED_AUTH_APP_ORIGIN = "http://localhost:3002";
    const captured = captureRegistration();
    expect(captured.resource?.uri).toBe(MANAGED_AUTH_RESOURCE_URI);
    expect(captured.resource?.config.mimeType).toBe(MANAGED_AUTH_MIME_TYPE);
    expect(captured.resource?.config._meta).toEqual(managedAuthResourceMeta());
    const read = await captured.resource!.handler(
      new URL(MANAGED_AUTH_RESOURCE_URI),
    );
    expect(read.contents[0].mimeType).toBe(MANAGED_AUTH_MIME_TYPE);
    expect(read.contents[0]._meta).toEqual(captured.resource?.config._meta);
    expect(read.contents[0]._meta.ui.csp.connectDomains).toEqual([
      "http://localhost:3002",
    ]);
    expect(read.contents[0]._meta.ui.csp.frameDomains).toBeUndefined();
    expect(read.contents[0]._meta.ui.csp.resourceDomains).toBeUndefined();
  });

  test("links only the public launcher and hides helpers from the model", () => {
    const { tools } = captureRegistration();
    expect(tools.get("open_auth_login")?.config._meta.ui).toEqual({
      resourceUri: MANAGED_AUTH_RESOURCE_URI,
      visibility: ["model", "app"],
    });
    expect(tools.get("open_auth_login")?.config._meta["ui/resourceUri"]).toBe(
      MANAGED_AUTH_RESOURCE_URI,
    );
    expect(tools.get("begin_auth_login")?.config._meta.ui.visibility).toEqual([
      "app",
    ]);
    // The App polls the baseline-guarded manage_auth_connections wait action;
    // there is no duplicate app-only status tool.
    expect(tools.has("get_auth_login_status")).toBe(false);
    expect(tools.has("delete_auth_login_connection")).toBe(false);
    expect([...tools.keys()].sort()).toEqual([
      "begin_auth_login",
      "open_auth_login",
    ]);
  });

  test("app-only tool schema rejects an empty connection identifier", () => {
    const { tools } = captureRegistration();
    const beginSchema = z.object(
      tools.get("begin_auth_login")!.config.inputSchema,
    );
    expect(
      beginSchema.safeParse({ mode: "reauth", connection_id: "" }).success,
    ).toBe(false);
  });

  test("login schemas reject empty proxy identifiers", () => {
    const { tools } = captureRegistration();
    const base = {
      mode: "new_login",
      domain: "example.com",
      profile_name: "work",
    };
    for (const name of ["open_auth_login", "begin_auth_login"]) {
      const schema = z.object(tools.get(name)!.config.inputSchema);
      expect(schema.safeParse({ ...base, proxy_id: "" }).success).toBe(false);
      expect(schema.safeParse({ ...base, proxy_name: "" }).success).toBe(false);
      expect(schema.safeParse({ ...base, proxy_id: "proxy_1" }).success).toBe(
        true,
      );
    }
  });

  test("normal launcher creates no backend flow or managed-auth handoff", async () => {
    const { tools } = captureRegistration();
    const result = await tools.get("open_auth_login")!.handler(
      {
        mode: "new_login",
        domain: "example.com",
        profile_name: "work",
        text_only: false,
      },
      { authInfo: { token: "unused-api-key" } },
    );
    expect(result.structuredContent).toEqual({
      kind: "kernel.managed_auth.launcher",
      version: 1,
      mode: "new_login",
      connection: { domain: "example.com", profile_name: "work" },
      text_only: false,
      next_action: {
        tool: "manage_auth_connections",
        arguments: {
          action: "wait",
          domain_filter: "example.com",
          profile_name: "work",
          wait_seconds: 25,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("?code=");
    expect(JSON.stringify(result)).not.toContain("handoff_code");
    expect(JSON.stringify(result)).not.toContain("hosted_url");
    expect(result._meta).toBeUndefined();
  });

  test("app-only tools fail closed on hosts without MCP Apps support", async () => {
    const { tools } = captureRegistration({ appsSupport: false });
    const result = await tools
      .get("begin_auth_login")!
      .handler(
        { mode: "reauth", connection_id: "conn_1" },
        { authInfo: { token: "unused-api-key" } },
      );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("MCP Apps-capable hosts");
    expect(JSON.stringify(result)).not.toContain("handoff_code");
    expect(JSON.stringify(result)).not.toContain("hosted_url");
  });

  test("stateless transports pass the gate via the recorded initialize marker", async () => {
    // Simulates the streamable-HTTP path: no client capabilities on the
    // per-request server, but the route layer recorded the capability.
    redisMarkerPresent = true;
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => ({
            id: "conn_1",
            domain: "example.com",
            profile_name: "work",
            status: "AUTHENTICATED",
            flow_expires_at: "2026-01-01T00:00:00Z",
          }),
          login: async () => ({
            id: "conn_1",
            flow_type: "REAUTH",
            flow_expires_at: "2099-01-01T00:00:00Z",
            hosted_url:
              "https://managed-auth.onkernel.com/login/conn_1?code=handoff-secret",
            handoff_code: "handoff-secret",
          }),
        },
      },
    });
    try {
      const { tools } = captureRegistration({ appsSupport: false });
      const result = await tools
        .get("begin_auth_login")!
        .handler(
          { mode: "reauth", connection_id: "conn_1" },
          { authInfo: { token: "unused-api-key" } },
        );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.kind).toBe("kernel.managed_auth.begin");
      // The begin result carries the pre-flow baseline so the App can keep
      // its wait polling guarded after a new flow starts.
      expect(result.structuredContent.previous_flow_expires_at).toBe(
        "2026-01-01T00:00:00Z",
      );
      // Capability-bearing material stays in App-private channels only.
      expect(JSON.stringify(result.content)).not.toContain("handoff-secret");
    } finally {
      redisMarkerPresent = false;
      resetKernelClientFactory();
    }
  });

  test("detects MCP Apps declarations in initialize payloads", () => {
    expect(
      initializeDeclaresMcpApps({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: [MANAGED_AUTH_MIME_TYPE],
              },
            },
          },
          clientInfo: { name: "qa", version: "1" },
        },
      }),
    ).toBe(true);
    expect(
      initializeDeclaresMcpApps([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            capabilities: {
              extensions: { "io.modelcontextprotocol/ui": {} },
            },
          },
        },
      ]),
    ).toBe(false);
    expect(
      initializeDeclaresMcpApps({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: {} },
      }),
    ).toBe(false);
    expect(
      initializeDeclaresMcpApps({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "begin_auth_login",
          arguments: {
            capabilities: {
              extensions: { "io.modelcontextprotocol/ui": {} },
            },
          },
        },
      }),
    ).toBe(false);
    expect(initializeDeclaresMcpApps(null)).toBe(false);
    expect(initializeDeclaresMcpApps("not json")).toBe(false);
  });

  test("reauth launcher guards the wait with the pre-flow baseline, never a guessed flow type", async () => {
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => ({
            id: "conn_1",
            domain: "example.com",
            profile_name: "work",
            status: "AUTHENTICATED",
            flow_status: "SUCCESS",
            flow_type: "LOGIN",
            flow_expires_at: "2026-01-01T00:00:00Z",
          }),
        },
      },
    });
    try {
      const { tools } = captureRegistration();
      const result = await tools
        .get("open_auth_login")!
        .handler(
          { mode: "reauth", connection_id: "conn_1", text_only: false },
          { authInfo: { token: "unused-api-key" } },
        );
      expect(result.structuredContent.next_action.arguments).toEqual({
        action: "wait",
        id: "conn_1",
        wait_seconds: 25,
        previous_flow_expires_at: "2026-01-01T00:00:00Z",
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "required_flow_type",
      );
    } finally {
      resetKernelClientFactory();
    }
  });

  test("reauth launcher includes a timeline baseline when flow expiry is null", async () => {
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => ({
            id: "conn_1",
            domain: "example.com",
            profile_name: "work",
            status: "AUTHENTICATED",
            flow_status: "SUCCESS",
            flow_type: "LOGIN",
            flow_expires_at: null,
          }),
          timeline: async () => ({
            getPaginatedItems: () => [
              {
                id: "flow_old",
                type: "login",
                status: "SUCCESS",
                timestamp: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        },
      },
    });
    try {
      const { tools } = captureRegistration();
      const result = await tools
        .get("open_auth_login")!
        .handler(
          { mode: "reauth", connection_id: "conn_1", text_only: false },
          { authInfo: { token: "unused-api-key" } },
        );
      expect(result.structuredContent.next_action.arguments).toEqual({
        action: "wait",
        id: "conn_1",
        wait_seconds: 25,
        previous_flow_expires_at: null,
        previous_flow_event_id: "flow_old",
        flow_wait_started_at: expect.any(String),
      });
    } finally {
      resetKernelClientFactory();
    }
  });

  test("reauth launcher observing a live flow emits no baseline guard", async () => {
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => ({
            id: "conn_1",
            domain: "example.com",
            profile_name: "work",
            status: "AUTHENTICATED",
            flow_status: "IN_PROGRESS",
            flow_type: "REAUTH",
            flow_expires_at: "2099-01-01T00:00:00Z",
          }),
        },
      },
    });
    try {
      const { tools } = captureRegistration();
      const result = await tools
        .get("open_auth_login")!
        .handler(
          { mode: "reauth", connection_id: "conn_1", text_only: false },
          { authInfo: { token: "unused-api-key" } },
        );
      expect(result.structuredContent.next_action.arguments).toEqual({
        action: "wait",
        id: "conn_1",
        wait_seconds: 25,
      });
    } finally {
      resetKernelClientFactory();
    }
  });

  test("text_only fallback emits baseline-guarded wait arguments and keeps handoff material out of model content", async () => {
    const initial = {
      id: "conn_1",
      domain: "example.com",
      profile_name: "work",
      status: "NEEDS_AUTH",
      flow_status: "FAILED",
      flow_type: "LOGIN",
      flow_expires_at: "2020-01-01T00:00:00Z",
    };
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => initial,
          login: async () => ({
            id: "conn_1",
            flow_type: "LOGIN",
            flow_expires_at: "2099-01-01T00:00:00Z",
            hosted_url:
              "https://managed-auth.onkernel.com/login/conn_1?code=handoff-secret",
            handoff_code: "handoff-secret",
          }),
        },
      },
    });
    try {
      const { tools } = captureRegistration({ appsSupport: false });
      const result = await tools
        .get("open_auth_login")!
        .handler(
          { mode: "reauth", connection_id: "conn_1", text_only: true },
          { authInfo: { token: "unused-api-key" } },
        );
      expect(result.content[0].text).toContain(
        JSON.stringify({
          action: "wait",
          id: "conn_1",
          wait_seconds: 25,
          previous_flow_expires_at: "2020-01-01T00:00:00Z",
        }),
      );
      // The hosted URL is delivered only as user-audience text; nothing
      // capability-bearing appears in structuredContent.
      expect(result.content[1].text).toContain("handoff-secret");
      expect(result.content[1].annotations).toEqual({ audience: ["user"] });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "handoff-secret",
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "hosted_url",
      );
    } finally {
      resetKernelClientFactory();
    }
  });

  test("bundle is self-contained and has no hosted iframe", () => {
    expect(MANAGED_AUTH_APP_HTML.length).toBeGreaterThan(100_000);
    expect(MANAGED_AUTH_APP_HTML).not.toContain("<iframe");
    expect(MANAGED_AUTH_APP_HTML).not.toContain(
      "managed-auth.onkernel.com/login",
    );
  });

  test("terminal model context excludes internal identifiers and never writes the prompt", () => {
    expect(MANAGED_AUTH_APP_HTML).toContain("profile_name");
    expect(MANAGED_AUTH_APP_HTML).toContain("manage_auth_connections");
    expect(MANAGED_AUTH_APP_HTML).toContain("flow_wait_started_at");
    expect(MANAGED_AUTH_APP_HTML).toContain(
      "Connection status saved for Claude",
    );
    expect(MANAGED_AUTH_APP_HTML).toContain("Close panel");
    // The App polls the shared wait action; the deleted duplicate status tool
    // is gone from the bundle.
    expect(MANAGED_AUTH_APP_HTML).not.toContain("get_auth_login_status");
    expect(MANAGED_AUTH_APP_HTML).not.toContain('sendRequest("ui/message"');
    expect(MANAGED_AUTH_APP_HTML).not.toContain("Agent notified");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("Continue agent");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("connectionId");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("claimedOutcome");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("resumeId");
  });
});
