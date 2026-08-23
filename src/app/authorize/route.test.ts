import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import type { AuthorizeDependencies } from "./route";
import { OAuthProjectsError } from "@/lib/oauth-projects";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";
process.env.OAUTH_LEGACY_NON_PKCE_CLIENT_IDS = "legacy_client";
process.env.NEXT_PUBLIC_CLERK_DOMAIN ??= "clerk.example.test";

const { authorizeRequest } = await import("./route");

function request(query: string) {
  return new NextRequest(`https://auth.example.test/authorize?${query}`);
}

function cliRequest(query: string) {
  return new NextRequest(`https://auth.onkernel.com/authorize?${query}`);
}

function dependencies({
  userId = "user_1",
  orgId = "org_1",
  projectError,
  redirectUris = null,
}: {
  userId?: string | null;
  orgId?: string | null;
  projectError?: Error;
  redirectUris?: string[] | null;
} = {}) {
  const requestContexts: Parameters<
    AuthorizeDependencies["setRequestContext"]
  >[0][] = [];
  const clientContexts: Parameters<
    AuthorizeDependencies["setClientContext"]
  >[0][] = [];
  const projects: Parameters<AuthorizeDependencies["requireProject"]>[0][] = [];
  return {
    requestContexts,
    clientContexts,
    projects,
    value: {
      getAuth: async () => ({
        userId,
        orgId,
        getToken: async () => "session-token",
      }),
      setRequestContext: async (value) => {
        requestContexts.push(value);
      },
      setClientContext: async (value) => {
        clientContexts.push(value);
      },
      getRedirectUris: async () => redirectUris,
      requireProject: async (value) => {
        projects.push(value);
        if (projectError) throw projectError;
        return { id: value.projectId, name: "project", status: "active" };
      },
    } satisfies AuthorizeDependencies,
  };
}

describe("GET /authorize", () => {
  test("redirects to selection and preserves OAuth parameters", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request(
        "client_id=client_1&state=opaque&resource=https%3A%2F%2Fauth.example.test%2Fmcp&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/select-org");
    expect(location.searchParams.get("state")).toBe("opaque");
    expect(location.searchParams.get("resource")).toBe(
      "https://auth.example.test/mcp",
    );
  });

  test("stores PKCE-bound organization scope and strips internal parameters", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request(
        "client_id=client_1&org_id=org_1&access_scope=organization&state=opaque&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(307);
    expect(deps.requestContexts).toHaveLength(1);
    expect(deps.requestContexts[0]).toMatchObject({
      clientId: "client_1",
      codeChallenge: "challenge",
      resource: "https://auth.example.test",
      authorizationContext: {
        version: 1,
        clerk_user_id: "user_1",
        clerk_org_id: "org_1",
        access_scope: "organization",
      },
    });
    const location = new URL(response.headers.get("location")!);
    expect(location.host).toBe("clerk.example.test");
    expect(location.searchParams.get("org_id")).toBeNull();
    expect(location.searchParams.get("access_scope")).toBeNull();
    expect(location.searchParams.get("project_id")).toBeNull();
    expect(location.searchParams.get("state")).toBe("opaque");
  });

  test("keeps the existing CLI authorization alias on Clerk tokens", async () => {
    const deps = dependencies({
      redirectUris: ["http://localhost:9999/callback"],
    });
    const response = await authorizeRequest(
      cliRequest(
        "client_id=cli_prod&org_id=org_1&access_scope=organization&scope=openid%20email&state=opaque&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:9999/callback",
    );
    expect(location.searchParams.get("scope")).toBe("openid email");
    expect(location.searchParams.get("state")).not.toBe("opaque");
  });

  test("routes newly registered clients through the issuer callback", async () => {
    const redirectUri = "http://localhost:58432/callback";
    const deps = dependencies({ redirectUris: [redirectUri] });
    const response = await authorizeRequest(
      request(
        `client_id=client_1&org_id=org_1&access_scope=organization&state=opaque&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=challenge&code_challenge_method=S256`,
      ),
      deps.value,
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.host).toBe("clerk.example.test");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://auth.example.test/oauth/callback",
    );
    expect(location.searchParams.get("state")).not.toBe("opaque");
  });

  test("rejects an unregistered redirect before forwarding to Clerk", async () => {
    const deps = dependencies({
      redirectUris: ["http://localhost:58432/callback"],
    });
    const response = await authorizeRequest(
      request(
        "client_id=client_1&org_id=org_1&access_scope=organization&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(deps.requestContexts).toHaveLength(0);
  });

  test("validates and stores project scope", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request(
        "client_id=client_1&org_id=org_1&access_scope=project&project_id=proj_1&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(307);
    expect(deps.projects).toEqual([
      { clerkSessionToken: "session-token", projectId: "proj_1" },
    ]);
    expect(deps.requestContexts[0].authorizationContext).toMatchObject({
      access_scope: "project",
      project_id: "proj_1",
    });
  });

  test("reports project API failures as temporarily unavailable", async () => {
    const deps = dependencies({
      projectError: new OAuthProjectsError("upstream unavailable", 502),
    });
    const response = await authorizeRequest(
      request(
        "client_id=client_1&org_id=org_1&access_scope=project&project_id=proj_1&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "server_error" });
  });

  test("rejects project scope without S256 PKCE", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request(
        "client_id=client_1&org_id=org_1&access_scope=project&project_id=proj_1",
      ),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(deps.requestContexts).toHaveLength(0);
  });

  test("rejects incomplete or unsupported PKCE parameters", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request(
        "client_id=client_1&org_id=org_1&access_scope=organization&code_challenge=challenge&code_challenge_method=plain",
      ),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(deps.clientContexts).toHaveLength(0);
    expect(deps.requestContexts).toHaveLength(0);
  });

  test("requires PKCE outside the legacy client allowlist", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request("client_id=client_1&org_id=org_1&access_scope=organization"),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(deps.clientContexts).toHaveLength(0);
  });

  test("stores organization scope for an allowlisted legacy client", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request("client_id=legacy_client&org_id=org_1&access_scope=organization"),
      deps.value,
    );

    expect(response.status).toBe(307);
    expect(deps.clientContexts).toEqual([
      expect.objectContaining({
        clientId: "legacy_client",
        authorizationContext: expect.objectContaining({
          clerk_user_id: "user_1",
          clerk_org_id: "org_1",
          access_scope: "organization",
        }),
      }),
    ]);
  });

  test("rejects an organization that is not active for the user", async () => {
    const deps = dependencies({ orgId: "org_2" });
    const response = await authorizeRequest(
      request("client_id=client_1&org_id=org_1&access_scope=organization"),
      deps.value,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "access_denied" });
  });

  test("keeps shared-client state compatible and includes scope", async () => {
    const deps = dependencies();
    const originalState = Buffer.from(
      JSON.stringify({ csrf: "csrf_1" }),
    ).toString("base64");
    const response = await authorizeRequest(
      request(
        `client_id=cli_prod&org_id=org_1&access_scope=project&project_id=proj_1&state=${encodeURIComponent(originalState)}&code_challenge=challenge&code_challenge_method=S256`,
      ),
      deps.value,
    );

    const location = new URL(response.headers.get("location")!);
    const state = JSON.parse(
      Buffer.from(location.searchParams.get("state")!, "base64").toString(),
    );
    expect(state).toEqual({
      csrf: "csrf_1",
      org_id: "org_1",
      access_scope: "project",
      project_id: "proj_1",
    });
  });
});
