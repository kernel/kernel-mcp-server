export type OAuthProjectsFetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface OAuthProject {
  id: string;
  name: string;
  status: "active" | "archived";
}

export interface OAuthProjectsPage {
  projects: OAuthProject[];
  hasMore: boolean;
  nextOffset?: number;
}

export class OAuthProjectsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

async function fetchProjectsApi(
  fetcher: OAuthProjectsFetcher,
  input: URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (error) {
    throw new OAuthProjectsError("Project API request failed", 502, {
      cause: error,
    });
  }
}

async function parseProjectsJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new OAuthProjectsError("Invalid project API response", 502, {
      cause: error,
    });
  }
}

function parseOAuthProject(value: unknown): OAuthProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthProjectsError("Invalid project API response", 502);
  }
  const project = value as Record<string, unknown>;
  if (
    typeof project.id !== "string" ||
    typeof project.name !== "string" ||
    (project.status !== "active" && project.status !== "archived")
  ) {
    throw new OAuthProjectsError("Invalid project API response", 502);
  }
  return {
    id: project.id,
    name: project.name,
    status: project.status,
  };
}

function apiBaseUrl(): string {
  const value = process.env.API_BASE_URL;
  if (!value) {
    throw new OAuthProjectsError("API_BASE_URL is not configured", 500);
  }
  return value;
}

function projectHeaders(clerkSessionToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${clerkSessionToken}`,
    "X-Source": "oauth-server",
  };
}

export async function listOAuthProjectsPage({
  clerkSessionToken,
  query,
  limit = 20,
  offset = 0,
  fetcher = fetch,
}: {
  clerkSessionToken: string;
  query?: string;
  limit?: number;
  offset?: number;
  fetcher?: OAuthProjectsFetcher;
}): Promise<OAuthProjectsPage> {
  const url = new URL("/org/projects", apiBaseUrl());
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (query) url.searchParams.set("query", query);

  const response = await fetchProjectsApi(fetcher, url, {
    headers: projectHeaders(clerkSessionToken),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new OAuthProjectsError(
      `Failed to load projects (${response.status})`,
      response.status === 401 || response.status === 403
        ? response.status
        : 502,
    );
  }

  const value = await parseProjectsJson(response);
  if (!Array.isArray(value)) {
    throw new OAuthProjectsError("Invalid project API response", 502);
  }
  const page = value.map(parseOAuthProject);
  const hasMore = response.headers.get("X-Has-More") === "true";
  const nextOffsetValue = response.headers.get("X-Next-Offset");
  const nextOffset = nextOffsetValue ? Number(nextOffsetValue) : undefined;
  if (
    hasMore &&
    (nextOffset === undefined ||
      !Number.isInteger(nextOffset) ||
      nextOffset <= offset)
  ) {
    throw new OAuthProjectsError("Invalid project pagination response", 502);
  }

  return {
    projects: page.filter((project) => project.status === "active"),
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
  };
}

export async function requireActiveOAuthProject({
  clerkSessionToken,
  projectId,
  fetcher = fetch,
}: {
  clerkSessionToken: string;
  projectId: string;
  fetcher?: OAuthProjectsFetcher;
}): Promise<OAuthProject> {
  const url = new URL(
    `/org/projects/${encodeURIComponent(projectId)}`,
    apiBaseUrl(),
  );
  const response = await fetchProjectsApi(fetcher, url, {
    headers: projectHeaders(clerkSessionToken),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new OAuthProjectsError(
      "Project not found or inactive",
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
        ? response.status
        : 502,
    );
  }

  const project = parseOAuthProject(await parseProjectsJson(response));
  if (project.status !== "active" || project.id !== projectId) {
    throw new OAuthProjectsError("Project not found or inactive", 404);
  }
  return project;
}
