import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";

const fixture = Bun.spawn({
  cmd: [
    process.execPath,
    new URL("../../../fixtures/mcp-http-server.ts", import.meta.url).pathname,
  ],
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
let endpoint: URL;
beforeAll(async () => {
  const reader = fixture.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const { value, done } = await reader.read();
    if (done)
      throw new Error(
        `HTTP fixture exited before startup (exit ${await fixture.exited})`,
      );
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  endpoint = new URL(JSON.parse(output.split("\n")[0]).url);
}, 15_000);
afterAll(async () => {
  fixture.kill();
  await fixture.exited;
});

type Era = "legacy" | "modern";
type Exchange = {
  request: Request;
  body: Record<string, unknown> | null;
  response: Response;
  text: string;
};
class OAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = "http://localhost:9876/callback";
  readonly clientMetadata = {
    client_name: "dual-era-test",
    redirect_uris: [this.redirectUrl],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "openid",
  };
  info?: StoredOAuthClientInformation;
  savedTokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: URL;
  verifier = "";
  readonly expectedState = crypto.randomUUID();
  state() {
    return this.expectedState;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.discovery = discovery;
  }
  discoveryState() {
    return this.discovery;
  }
  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "discovery" | "verifier",
  ) {
    if (scope === "all" || scope === "client") this.info = undefined;
    if (scope === "all" || scope === "tokens") this.savedTokens = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = "";
  }
}

function connection(
  era: Era,
  {
    provider,
    token,
    apps = false,
    session,
  }: {
    provider?: OAuthProvider;
    token?: string;
    apps?: boolean;
    session?: string;
  } = {},
) {
  const exchanges: Exchange[] = [];
  const options = {
    authProvider: provider,
    requestInit: {
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(session && { "Mcp-Session-Id": session }),
      },
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => null)
          : null;
      const response = await fetch(request);
      exchanges.push({
        request,
        body,
        response,
        text: await response.clone().text(),
      });
      return response;
    },
  };
  const capabilities = {
    experimental: {},
    ...(apps && { extensions: { "io.modelcontextprotocol/ui": {} } }),
  };
  if (era === "legacy") {
    const client = new LegacyClient(
      { name: "v1-client", version: "1" },
      { capabilities },
    );
    const transport = new LegacyTransport(endpoint, options);
    return {
      client,
      transport,
      exchanges,
      connect: () => client.connect(transport),
      finishAuth: (params: URLSearchParams) =>
        transport.finishAuth(params.get("code")!),
    };
  }
  const client = new Client(
    { name: "v2-client", version: "1" },
    {
      capabilities,
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, options);
  return {
    client,
    transport,
    exchanges,
    connect: () => client.connect(transport),
    finishAuth: (params: URLSearchParams) => transport.finishAuth(params),
  };
}
function parsedResult(value: unknown) {
  const result = CallToolResultSchema.parse(value);
  const first = result.content[0];
  if (first.type !== "text") throw new Error("Expected text content");
  return JSON.parse(first.text);
}
function wireResult(exchange: Exchange) {
  const data = exchange.text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : exchange.text).result;
}

for (const era of ["legacy", "modern"] as const) {
  describe(`${era === "legacy" ? "v1 SDK" : "v2 SDK"} against the shared /mcp handler`, () => {
    test("authenticates an API key, lists all toolsets, and returns usable successes and errors", async () => {
      const { client, connect, exchanges } = connection(era, {
        token: "sk_valid",
      });
      try {
        await connect();
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toContain("manage_projects");
        expect(tools.map((tool) => tool.name)).toContain(
          "manage_vault_credentials",
        );
        expect(tools.map((tool) => tool.name)).not.toContain("open_auth_login");
        expect(tools.every((tool) => !tool.outputSchema)).toBe(true);
        const context = parsedResult(
          await client.callTool({
            name: "get_connection_context",
            arguments: {},
          }),
        );
        expect(context.authentication.method).toBe("api_key");
        expect(context.connection_scope.kind).toBe("organization");
        const success = await client.callTool({
          name: "manage_projects",
          arguments: { action: "get", project: "project_test" },
        });
        expect(success.isError).not.toBe(true);
        expect(parsedResult(success)).toMatchObject({
          id: "project_test",
          name: "Test project",
        });
        for (const args of [
          { action: "get" },
          { action: "invalid" },
          { action: "get", project: "missing" },
        ]) {
          const result = CallToolResultSchema.parse(
            await client.callTool({ name: "manage_projects", arguments: args }),
          );
          expect(result.isError).toBe(true);
          expect(result.content).toContainEqual(
            expect.objectContaining({ type: "text", text: expect.any(String) }),
          );
        }
        await expect(
          client.callTool({ name: "unknown_tool" }),
        ).rejects.toMatchObject({ code: -32602 });
        expect(
          parsedResult(
            await client.callTool({
              name: "get_connection_context",
              arguments: {},
            }),
          ).organization.id,
        ).toBe("org_test");
        expect(
          (await client.listPrompts()).prompts.map((prompt) => prompt.name),
        ).toContain("kernel-concepts");
        expect(
          (
            await client.getPrompt({
              name: "kernel-concepts",
              arguments: { concept: "browsers" },
            })
          ).messages.length,
        ).toBeGreaterThan(0);
        expect(
          (await client.listResourceTemplates()).resourceTemplates.length,
        ).toBeGreaterThan(0);

        const calls = exchanges.filter(
          (exchange) =>
            exchange.body?.method === "tools/call" && exchange.response.ok,
        );
        const completed = calls.find(
          (exchange) => exchange.body && wireResult(exchange)?.content,
        );
        expect(completed).toBeDefined();
        expect(wireResult(completed!).resultType).toBe(
          era === "modern" ? "complete" : undefined,
        );
        if (era === "modern") {
          expect(
            exchanges.some(
              (exchange) => exchange.body?.method === "initialize",
            ),
          ).toBe(false);
          expect(
            exchanges.every(
              (exchange) => !exchange.response.headers.has("mcp-session-id"),
            ),
          ).toBe(true);
          expect(completed!.request.headers.get("mcp-method")).toBe(
            "tools/call",
          );
          expect(completed!.request.headers.get("mcp-name")).toBeTruthy();
          expect(JSON.stringify(completed!.body)).toContain(
            "io.modelcontextprotocol/protocolVersion",
          );
        } else {
          const initialize = exchanges.find(
            (exchange) => exchange.body?.method === "initialize",
          )!;
          expect(
            initialize.response.headers.get("mcp-session-id"),
          ).toBeTruthy();
        }
      } finally {
        await client.close();
      }
    });

    test("completes OAuth discovery, PKCE authorization, token exchange, and refresh", async () => {
      const provider = new OAuthProvider();
      const opening = connection(era, { provider });
      try {
        const authError = await opening.connect().then(
          () => null,
          (error) => error,
        );
        expect(authError).toBeInstanceOf(Error);
        if (!provider.authorizationUrl) throw authError;
        expect(
          opening.exchanges.some(
            (exchange) => exchange.response.status === 401,
          ),
        ).toBe(true);
        expect(
          provider.authorizationUrl!.searchParams.get("code_challenge_method"),
        ).toBe("S256");
        expect(provider.authorizationUrl!.searchParams.get("resource")).toBe(
          endpoint.href,
        );
        const authorized = await fetch(provider.authorizationUrl!, {
          redirect: "manual",
        });
        expect(authorized.status).toBe(302);
        const callback = new URL(authorized.headers.get("location")!);
        expect(callback.searchParams.get("state")).toBe(provider.expectedState);
        await opening.finishAuth(callback.searchParams);
        expect(provider.savedTokens?.access_token).toBeTruthy();
      } finally {
        await opening.client.close();
      }

      const authenticated = connection(era, { provider });
      try {
        await authenticated.connect();
        expect(
          (await authenticated.client.listTools()).tools.length,
        ).toBeGreaterThan(20);
        const result = parsedResult(
          await authenticated.client.callTool({
            name: "get_connection_context",
            arguments: {},
          }),
        );
        expect(result.authentication).toMatchObject({
          method: "jwt",
          source: "oauth",
        });
        expect(result.connection_scope).toMatchObject({
          kind: "project",
          project_id: "project_test",
        });
        expect(
          parsedResult(
            await authenticated.client.callTool({
              name: "manage_projects",
              arguments: { action: "get", project: "project_test" },
            }),
          ).id,
        ).toBe("project_test");
        const denied = await authenticated.client.callTool({
          name: "manage_browsers",
          arguments: {
            action: "get",
            session_id: "unused",
            project: "other_project",
          },
        });
        expect(denied.isError).toBe(true);
      } finally {
        await authenticated.client.close();
      }

      const previousRefresh = provider.savedTokens!.refresh_token;
      provider.savedTokens = {
        ...provider.savedTokens!,
        access_token: "sk_revoked",
      };
      const refreshed = connection(era, { provider });
      try {
        await refreshed.connect();
        expect(provider.savedTokens!.refresh_token).not.toBe(previousRefresh);
        expect(
          parsedResult(
            await refreshed.client.callTool({
              name: "get_connection_context",
              arguments: {},
            }),
          ).connection_scope.project_id,
        ).toBe("project_test");
        expect(
          refreshed.exchanges.some(
            (exchange) => exchange.response.status === 401,
          ),
        ).toBe(true);
      } finally {
        await refreshed.client.close();
      }
    }, 15_000);

    test("rejects absent, revoked, and invalid JWT credentials before tools dispatch", async () => {
      for (const token of [
        undefined,
        "sk_revoked",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.invalid",
      ]) {
        const attempt = connection(era, { token });
        try {
          await expect(attempt.connect()).rejects.toThrow();
          const rejected = attempt.exchanges.find(
            (exchange) => exchange.response.status === 401,
          )!;
          expect(rejected).toBeDefined();
          expect(rejected.response.headers.get("www-authenticate")).toContain(
            "/.well-known/oauth-protected-resource/mcp",
          );
        } finally {
          await attempt.client.close();
        }
      }
    });

    test("keeps MCP Apps available only to clients declaring the extension", async () => {
      const withApps = connection(era, { token: "sk_valid", apps: true });
      const withoutApps = connection(era, { token: "sk_valid" });
      try {
        await Promise.all([withApps.connect(), withoutApps.connect()]);
        const [allowed, denied] = await Promise.all([
          withApps.client.listTools(),
          withoutApps.client.listTools(),
        ]);
        expect(allowed.tools.map((tool) => tool.name)).toContain(
          "open_auth_login",
        );
        expect(denied.tools.map((tool) => tool.name)).not.toContain(
          "begin_auth_login",
        );
        const launcher = await withApps.client.callTool({
          name: "open_auth_login",
          arguments: {
            mode: "new_login",
            domain: "example.com",
            profile_name: "test",
          },
        });
        expect(
          CallToolResultSchema.parse(launcher).structuredContent,
        ).toMatchObject({ kind: "kernel.managed_auth.launcher" });
        const resources = await withApps.client.listResources();
        const app = resources.resources.find(
          (resource) => resource.mimeType === "text/html;profile=mcp-app",
        )!;
        expect(app).toBeDefined();
        expect(
          (await withApps.client.readResource({ uri: app.uri })).contents
            .length,
        ).toBe(1);
        await expect(
          withoutApps.client.callTool({
            name: "begin_auth_login",
            arguments: { mode: "reauth", connection_id: "unused" },
          }),
        ).rejects.toMatchObject({ code: -32602 });
      } finally {
        await Promise.all([
          withApps.client.close(),
          withoutApps.client.close(),
        ]);
      }
    });
  });
}

test("modern requests cannot reuse a legacy Apps session to bypass per-request capabilities", async () => {
  const legacy = connection("legacy", { token: "sk_valid", apps: true });
  try {
    await legacy.connect();
    const session = legacy.exchanges
      .find((exchange) => exchange.body?.method === "initialize")!
      .response.headers.get("mcp-session-id")!;
    const modern = connection("modern", { token: "sk_valid", session });
    try {
      await modern.connect();
      expect(
        (await modern.client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain("begin_auth_login");
    } finally {
      await modern.client.close();
    }
  } finally {
    await legacy.client.close();
  }
});

test("supports browser preflights for both eras and rejects mismatched modern headers", async () => {
  const preflight = await fetch(endpoint, { method: "OPTIONS" });
  expect(preflight.status).toBe(204);
  for (const header of [
    "MCP-Protocol-Version",
    "Mcp-Method",
    "Mcp-Name",
    "Authorization",
  ]) {
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      header,
    );
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_valid",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe(-32020);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
});
