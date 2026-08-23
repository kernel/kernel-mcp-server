import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { registerRequest, type RegisterDependencies } from "./route";

function request(body: unknown, contentType = "application/json") {
  return new NextRequest("https://auth.example.test/register", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /register", () => {
  test("registers a public client and expands localhost redirects", async () => {
    const createCalls: Parameters<
      RegisterDependencies["createOAuthApplication"]
    >[0][] = [];
    const storedRegistrations: Parameters<
      RegisterDependencies["storeRedirectUris"]
    >[0][] = [];
    const response = await registerRequest(
      request({
        client_name: "Test Client",
        redirect_uris: ["http://localhost:58432/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp",
      }),
      {
        createOAuthApplication: async (value) => {
          createCalls.push(value);
          return {
            id: "oauth_app_1",
            clientId: "client_1",
            clientSecret: null,
          };
        },
        storeRedirectUris: async (value) => {
          storedRegistrations.push(value);
        },
      },
    );

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "Test Client",
        redirectUris: [
          "http://localhost:58432/callback",
          "http://127.0.0.1:58432/callback",
          "https://auth.example.test/oauth/callback",
        ],
        scopes: "openid",
        public: true,
      },
    ]);
    expect(storedRegistrations).toEqual([
      {
        clientId: "client_1",
        redirectUris: [
          "http://localhost:58432/callback",
          "http://127.0.0.1:58432/callback",
        ],
      },
    ]);
    expect(await response.json()).toMatchObject({
      client_id: "client_1",
      redirect_uris: ["http://localhost:58432/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      scope: "mcp",
    });
  });

  test("rejects malformed and unsafe registrations before Clerk", async () => {
    let called = false;
    const deps: RegisterDependencies = {
      createOAuthApplication: async () => {
        called = true;
        return { id: "unexpected", clientId: "unexpected" };
      },
      storeRedirectUris: async () => {
        called = true;
      },
    };

    const contentType = await registerRequest(request({}, "text/plain"), deps);
    expect(contentType.status).toBe(400);

    const missingRedirect = await registerRequest(request({}), deps);
    expect(missingRedirect.status).toBe(400);

    const insecureRedirect = await registerRequest(
      request({ redirect_uris: ["http://example.com/callback"] }),
      deps,
    );
    expect(insecureRedirect.status).toBe(400);

    const unsupportedScope = await registerRequest(
      request({
        redirect_uris: ["https://client.example/callback"],
        scope: "profile",
      }),
      deps,
    );
    expect(unsupportedScope.status).toBe(400);
    expect(called).toBe(false);
  });
});
