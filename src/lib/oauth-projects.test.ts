import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  listOAuthProjects,
  OAuthProjectsError,
  requireActiveOAuthProject,
} from "./oauth-projects";

const originalApiBaseUrl = process.env.API_BASE_URL;

beforeEach(() => {
  process.env.API_BASE_URL = "https://api.example.test";
});

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBaseUrl;
});

describe("OAuth project lookup", () => {
  test("paginates and returns only active projects", async () => {
    const calls: string[] = [];
    const fetcher = mock(async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes("offset=0")) {
        return Response.json(
          [
            { id: "proj_1", name: "one", status: "active" },
            { id: "proj_old", name: "old", status: "archived" },
          ],
          { headers: { "X-Has-More": "true", "X-Next-Offset": "2" } },
        );
      }
      return Response.json([{ id: "proj_2", name: "two", status: "active" }], {
        headers: { "X-Has-More": "false" },
      });
    });

    expect(await listOAuthProjects("session-token", fetcher)).toEqual([
      { id: "proj_1", name: "one", status: "active" },
      { id: "proj_2", name: "two", status: "active" },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("requires the selected project to be active and visible", async () => {
    const fetcher = mock(async () =>
      Response.json([{ id: "proj_1", name: "one", status: "active" }], {
        headers: { "X-Has-More": "false" },
      }),
    );

    expect(
      await requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_1",
        fetcher,
      }),
    ).toEqual({ id: "proj_1", name: "one", status: "active" });

    await expect(
      requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_2",
        fetcher,
      }),
    ).rejects.toBeInstanceOf(OAuthProjectsError);
  });

  test("fails on API and pagination errors", async () => {
    const unavailable = mock(async () => new Response(null, { status: 503 }));
    await expect(
      listOAuthProjects("session-token", unavailable),
    ).rejects.toMatchObject({
      status: 502,
    });

    const invalidPagination = mock(async () =>
      Response.json([], {
        headers: { "X-Has-More": "true", "X-Next-Offset": "0" },
      }),
    );
    await expect(
      listOAuthProjects("session-token", invalidPagination),
    ).rejects.toThrow("Invalid project pagination response");
  });
});
