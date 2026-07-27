import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import {
  MANAGED_AUTH_MIME_TYPE,
  MANAGED_AUTH_RESOURCE_URI,
  managedAuthResourceMeta,
  registerAuthLoginApp,
} from "@/lib/mcp/tools/auth-login-app";

type ToolRegistration = {
  config: Record<string, any>;
  handler: (params: any, extra: any) => Promise<any>;
};

function captureRegistration() {
  const tools = new Map<string, ToolRegistration>();
  let resource:
    | {
        uri: string;
        config: Record<string, any>;
        handler: (uri: URL) => Promise<any>;
      }
    | undefined;
  const appCapability = {
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: [MANAGED_AUTH_MIME_TYPE],
      },
    },
  };
  const registrationHandle = () => ({
    enable() {},
    disable() {},
  });
  const server = {
    server: {
      getClientCapabilities: () => appCapability,
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
  process.env.MCP_APP_SIGNING_SECRET = "test-app-signing-secret";

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
    expect(
      tools.get("get_auth_login_status")?.config._meta.ui.visibility,
    ).toEqual(["app"]);
    expect(
      tools.get("delete_auth_login_connection")?.config._meta.ui.visibility,
    ).toEqual(["app"]);
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
      app_capability: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain("?code=");
    expect(JSON.stringify(result)).not.toContain("handoff_code");
    expect(JSON.stringify(result)).not.toContain("hosted_url");
    expect(result._meta.auth_login_launcher.app_capability).toBeString();
    expect(JSON.stringify(result.content)).not.toContain("app_capability");
    expect(result.structuredContent.app_capability).toBe(
      result._meta.auth_login_launcher.app_capability,
    );
  });

  test("destructive app-only cleanup rejects calls without the private launcher capability", async () => {
    const { tools } = captureRegistration();
    const result = await tools.get("delete_auth_login_connection")!.handler(
      {
        connection_id: "connection-id",
        app_capability: "not-valid",
      },
      { authInfo: { token: "unused-api-key" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("authorization is invalid");
  });

  test("bundle is self-contained and has no hosted iframe", () => {
    expect(MANAGED_AUTH_APP_HTML.length).toBeGreaterThan(100_000);
    expect(MANAGED_AUTH_APP_HTML).not.toContain("<iframe");
    expect(MANAGED_AUTH_APP_HTML).not.toContain(
      "managed-auth.onkernel.com/login",
    );
  });

  test("terminal model context excludes internal identifiers", () => {
    expect(MANAGED_AUTH_APP_HTML).toContain("profile_name");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("connectionId");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("claimedOutcome");
    expect(MANAGED_AUTH_APP_HTML).not.toContain("resumeId");
  });
});
