/// <reference types="bun-types" />
import { Client } from "@modelcontextprotocol/client";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { APIError } from "@onkernel/sdk";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { throwToolError } from "@/lib/mcp/responses";
import { returnScopeChallenges } from "@/lib/mcp/scope-challenge-results";
import { apiScopeChallenge, mcpScopeChallenge } from "@/lib/scope-challenge";

const API_CHALLENGE =
  'Bearer error="insufficient_scope", scope="browsers:use profiles:create", resource_metadata="https://api.onkernel.com/.well-known/oauth-protected-resource", error_description="Sign in again and grant profiles:create"';
const MCP_CHALLENGE =
  'Bearer error="insufficient_scope", scope="browsers:use profiles:create", resource_metadata="https://mcp.onkernel.com/.well-known/oauth-protected-resource/mcp", error_description="Sign in again and grant profiles:create"';

function forbidden(headers: Record<string, string>) {
  return APIError.generate(
    403,
    {
      code: "insufficient_scope",
      message: "This operation requires profiles:create on projects/p/*",
      missing_scopes: ["profiles:create"],
    },
    undefined,
    new Headers(headers),
  );
}

describe("scope challenges", () => {
  test("reads the API's insufficient_scope challenge", () => {
    expect(
      apiScopeChallenge(new Headers({ "WWW-Authenticate": API_CHALLENGE })),
    ).toEqual({
      scope: "browsers:use profiles:create",
      description: "Sign in again and grant profiles:create",
    });
    expect(
      apiScopeChallenge(
        new Headers({
          "WWW-Authenticate":
            'bearer scope=profiles:create, error="insufficient_scope"',
        }),
      ),
    ).toEqual({ scope: "profiles:create", description: undefined });
  });

  test("ignores anything else", () => {
    for (const header of [
      'Bearer error="invalid_token"',
      'Bearer resource_metadata="https://api.onkernel.com/.well-known/oauth-protected-resource"',
      'Basic realm="oauth"',
      "",
    ]) {
      expect(
        apiScopeChallenge(new Headers({ "WWW-Authenticate": header })),
      ).toBeNull();
    }
    expect(apiScopeChallenge(new Headers())).toBeNull();
  });

  test("points the client at this server's resource metadata", () => {
    expect(
      mcpScopeChallenge(
        apiScopeChallenge(new Headers({ "WWW-Authenticate": API_CHALLENGE }))!,
        "https://mcp.onkernel.com/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBe(MCP_CHALLENGE);
    expect(
      mcpScopeChallenge(
        { description: 'a "quoted" \\ value' },
        "https://mcp.onkernel.com/.well-known/oauth-protected-resource/mcp",
      ),
    ).toBe(
      'Bearer error="insufficient_scope", resource_metadata="https://mcp.onkernel.com/.well-known/oauth-protected-resource/mcp", error_description="a quoted  value"',
    );
  });
});

describe("tool calls the API refuses", () => {
  async function callTool(error: unknown) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    returnScopeChallenges(server);
    server.registerTool(
      "manage_profiles",
      { inputSchema: z.object({}) },
      async () => {
        throwToolError("manage_profiles", "create", error);
      },
    );
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.callTool({
      name: "manage_profiles",
      arguments: {},
    });
    await client.close();
    return result;
  }

  test("carry the challenge in _meta when signing in again can grant it", async () => {
    const result = await callTool(
      forbidden({ "WWW-Authenticate": API_CHALLENGE }),
    );
    expect(result.isError).toBe(true);
    expect(result._meta).toEqual({ "mcp/www_authenticate": [MCP_CHALLENGE] });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "error in manage_profiles (create): 403 This operation requires profiles:create on projects/p/* [code: insufficient_scope] Signing in again can grant profiles:create: ask the user to reconnect the KERNEL MCP server and allow it.",
      },
    ]);
  });

  test("stay plain tool errors otherwise", async () => {
    for (const error of [
      forbidden({}),
      APIError.generate(
        401,
        undefined,
        "unauthorized",
        new Headers({ "WWW-Authenticate": API_CHALLENGE }),
      ),
      new Error("boom"),
    ]) {
      const result = await callTool(error);
      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(JSON.stringify(result.content)).not.toContain("reconnect");
    }
  });

  test("name the metadata of the host the client connected to", async () => {
    let registered: ((...params: unknown[]) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, callback: never) => {
        registered = callback;
      },
    } as unknown as McpServer;
    returnScopeChallenges(server);
    server.registerTool(
      "manage_profiles",
      { inputSchema: z.object({}) },
      async () => {
        throwToolError(
          "manage_profiles",
          "create",
          forbidden({ "WWW-Authenticate": API_CHALLENGE }),
        );
      },
    );
    const result = (await registered!(
      {},
      { http: { req: new Request("https://preview.example.test/mcp") } },
    )) as { _meta: Record<string, string[]> };
    expect(result._meta["mcp/www_authenticate"]).toEqual([
      MCP_CHALLENGE.replace(
        "https://mcp.onkernel.com/",
        "https://preview.example.test/",
      ),
    ]);
  });
});
