import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  oauthProjectsRequest,
  type OAuthProjectsRouteDependencies,
} from "./route";

function request(query: string) {
  return new NextRequest(`https://mcp.example.test/oauth/projects?${query}`);
}

function dependencies() {
  const listCalls: Parameters<
    OAuthProjectsRouteDependencies["listProjects"]
  >[0][] = [];
  return {
    listCalls,
    value: {
      getAuth: async () => ({
        userId: "user_1",
        orgId: "org_1",
        getToken: async () => "session-token",
      }),
      listProjects: async (input) => {
        listCalls.push(input);
        return {
          projects: [{ id: "proj_1", name: "production", status: "active" }],
          hasMore: true,
          nextOffset: 40,
        };
      },
    } satisfies OAuthProjectsRouteDependencies,
  };
}

describe("GET /oauth/projects", () => {
  test("forwards server-side search and pagination", async () => {
    const deps = dependencies();
    const response = await oauthProjectsRequest(
      request("org_id=org_1&query=prod&limit=20&offset=20"),
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(deps.listCalls).toEqual([
      {
        clerkSessionToken: "session-token",
        query: "prod",
        limit: 20,
        offset: 20,
      },
    ]);
    expect(await response.json()).toEqual({
      projects: [{ id: "proj_1", name: "production", status: "active" }],
      has_more: true,
      next_offset: 40,
    });
  });

  test("rejects organization and pagination mismatches", async () => {
    const deps = dependencies();
    const wrongOrg = await oauthProjectsRequest(
      request("org_id=org_2"),
      deps.value,
    );
    expect(wrongOrg.status).toBe(403);

    for (const query of [
      "org_id=org_1&limit=21",
      "org_id=org_1&limit=0",
      "org_id=org_1&offset=-1",
    ]) {
      const response = await oauthProjectsRequest(request(query), deps.value);
      expect(response.status).toBe(400);
    }
    expect(deps.listCalls).toHaveLength(0);
  });
});
