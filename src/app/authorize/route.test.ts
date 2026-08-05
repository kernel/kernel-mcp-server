import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import type { AuthorizeDependencies } from "./route";

process.env.KERNEL_CLI_PROD_CLIENT_ID ??= "cli_prod";
process.env.KERNEL_CLI_STAGING_CLIENT_ID ??= "cli_staging";
process.env.KERNEL_CLI_DEV_CLIENT_ID ??= "cli_dev";
process.env.NEXT_PUBLIC_CLERK_DOMAIN ??= "clerk.example.test";

const { authorizeRequest } = await import("./route");

function request(query: string) {
  return new NextRequest(`https://auth.example.test/authorize?${query}`);
}

function dependencies({
  userId = "user_1",
  orgId = "org_1",
}: { userId?: string | null; orgId?: string | null } = {}) {
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
      requireProject: async (value) => {
        projects.push(value);
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
        "client_id=client_1&state=opaque&resource=https%3A%2F%2Fmcp.example.test%2Fmcp&code_challenge=challenge&code_challenge_method=S256",
      ),
      deps.value,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/select-org");
    expect(location.searchParams.get("state")).toBe("opaque");
    expect(location.searchParams.get("resource")).toBe(
      "https://mcp.example.test/mcp",
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

  test("requires PKCE for shared clients", async () => {
    const deps = dependencies();
    const response = await authorizeRequest(
      request("client_id=cli_prod&org_id=org_1&access_scope=organization"),
      deps.value,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(deps.clientContexts).toHaveLength(0);
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
