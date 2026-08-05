import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  listOAuthProjects,
  OAuthProjectsError,
  requireActiveOAuthProject,
} from "./oauth-projects";

const originalFetch = globalThis.fetch;
const originalApiBaseUrl = process.env.API_BASE_URL;

beforeEach(() => {
  process.env.API_BASE_URL = "https://api.example.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBaseUrl;
});

describe("OAuth project lookup", () => {
  test("paginates and returns only active projects", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
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
    }) as typeof fetch;

    expect(await listOAuthProjects("session-token")).toEqual([
      { id: "proj_1", name: "one", status: "active" },
      { id: "proj_2", name: "two", status: "active" },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("requires the selected project to be active and visible", async () => {
    globalThis.fetch = mock(async () =>
      Response.json([{ id: "proj_1", name: "one", status: "active" }], {
        headers: { "X-Has-More": "false" },
      }),
    ) as typeof fetch;

    expect(
      await requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_1",
      }),
    ).toEqual({ id: "proj_1", name: "one", status: "active" });

    await expect(
      requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_2",
      }),
    ).rejects.toBeInstanceOf(OAuthProjectsError);
  });

  test("fails on API and pagination errors", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 503 }),
    ) as typeof fetch;
    await expect(listOAuthProjects("session-token")).rejects.toMatchObject({
      status: 502,
    });

    globalThis.fetch = mock(async () =>
      Response.json([], {
        headers: { "X-Has-More": "true", "X-Next-Offset": "0" },
      }),
    ) as typeof fetch;
    await expect(listOAuthProjects("session-token")).rejects.toThrow(
      "Invalid project pagination response",
    );
  });
});
