export type OAuthProjectsFetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface OAuthProject {
  id: string;
  name: string;
  status: "active" | "archived";
}

export class OAuthProjectsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function listOAuthProjects(
  clerkSessionToken: string,
  fetcher: OAuthProjectsFetcher = fetch,
): Promise<OAuthProject[]> {
  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) {
    throw new OAuthProjectsError("API_BASE_URL is not configured", 500);
  }

  const projects: OAuthProject[] = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const url = new URL("/org/projects", apiBaseUrl);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${clerkSessionToken}`,
        "X-Source": "oauth-server",
      },
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

    const page = (await response.json()) as OAuthProject[];
    projects.push(...page.filter((project) => project.status === "active"));

    if (response.headers.get("X-Has-More") !== "true") break;
    const nextOffset = Number(response.headers.get("X-Next-Offset"));
    if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
      throw new OAuthProjectsError("Invalid project pagination response", 502);
    }
    offset = nextOffset;
  }

  return projects;
}

export async function requireActiveOAuthProject({
  clerkSessionToken,
  projectId,
  fetcher,
}: {
  clerkSessionToken: string;
  projectId: string;
  fetcher?: OAuthProjectsFetcher;
}): Promise<OAuthProject> {
  const projects = await listOAuthProjects(clerkSessionToken, fetcher);
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new OAuthProjectsError("Project not found or inactive", 404);
  }
  return project;
}
