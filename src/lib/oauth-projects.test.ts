import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  listOAuthProjectsPage,
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
  test("forwards search and pagination to the API", async () => {
    let requestedUrl: URL | undefined;
    const fetcher = mock(async (input: RequestInfo | URL) => {
      requestedUrl = new URL(input.toString());
      return Response.json(
        [
          { id: "proj_1", name: "one", status: "active" },
          { id: "proj_old", name: "old", status: "archived" },
        ],
        { headers: { "X-Has-More": "true", "X-Next-Offset": "40" } },
      );
    });

    const page = await listOAuthProjectsPage({
      clerkSessionToken: "session-token",
      query: "prod",
      limit: 20,
      offset: 20,
      fetcher,
    });

    expect(requestedUrl?.pathname).toBe("/org/projects");
    expect(requestedUrl?.searchParams.get("query")).toBe("prod");
    expect(requestedUrl?.searchParams.get("limit")).toBe("20");
    expect(requestedUrl?.searchParams.get("offset")).toBe("20");
    expect(page).toEqual({
      projects: [{ id: "proj_1", name: "one", status: "active" }],
      hasMore: true,
      nextOffset: 40,
    });
  });

  test("validates the selected project directly by ID", async () => {
    let requestedUrl: URL | undefined;
    const fetcher = mock(async (input: RequestInfo | URL) => {
      requestedUrl = new URL(input.toString());
      return Response.json({ id: "proj_1", name: "one", status: "active" });
    });

    expect(
      await requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_1",
        fetcher,
      }),
    ).toEqual({ id: "proj_1", name: "one", status: "active" });
    expect(requestedUrl?.pathname).toBe("/org/projects/proj_1");
  });

  test("rejects missing, inactive, and mismatched projects", async () => {
    const missing = mock(async () => new Response(null, { status: 404 }));
    await expect(
      requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_1",
        fetcher: missing,
      }),
    ).rejects.toMatchObject({ status: 404 });

    const forbidden = mock(async () => new Response(null, { status: 403 }));
    await expect(
      requireActiveOAuthProject({
        clerkSessionToken: "session-token",
        projectId: "proj_1",
        fetcher: forbidden,
      }),
    ).rejects.toMatchObject({ status: 403 });

    for (const project of [
      { id: "proj_1", name: "one", status: "archived" },
      { id: "proj_2", name: "two", status: "active" },
    ]) {
      const fetcher = mock(async () => Response.json(project));
      await expect(
        requireActiveOAuthProject({
          clerkSessionToken: "session-token",
          projectId: "proj_1",
          fetcher,
        }),
      ).rejects.toBeInstanceOf(OAuthProjectsError);
    }
  });

  test("fails on API and pagination errors", async () => {
    const unavailable = mock(async () => new Response(null, { status: 503 }));
    await expect(
      listOAuthProjectsPage({
        clerkSessionToken: "session-token",
        fetcher: unavailable,
      }),
    ).rejects.toMatchObject({ status: 502 });

    const invalidPagination = mock(async () =>
      Response.json([], {
        headers: { "X-Has-More": "true", "X-Next-Offset": "0" },
      }),
    );
    await expect(
      listOAuthProjectsPage({
        clerkSessionToken: "session-token",
        fetcher: invalidPagination,
      }),
    ).rejects.toThrow("Invalid project pagination response");
  });
});
