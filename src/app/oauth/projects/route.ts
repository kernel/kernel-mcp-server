import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  listOAuthProjectsPage,
  OAuthProjectsError,
} from "@/lib/oauth-projects";

export interface OAuthProjectsRouteDependencies {
  getAuth: () => Promise<{
    userId: string | null | undefined;
    orgId: string | null | undefined;
    getToken: () => Promise<string | null>;
  }>;
  listProjects: typeof listOAuthProjectsPage;
}

const routeDependencies: OAuthProjectsRouteDependencies = {
  getAuth: async () => auth(),
  listProjects: listOAuthProjectsPage,
};

function integerParameter(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function oauthProjectsRequest(
  request: NextRequest,
  dependencies: OAuthProjectsRouteDependencies = routeDependencies,
): Promise<NextResponse> {
  const { userId, orgId, getToken } = await dependencies.getAuth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const requestedOrgId = request.nextUrl.searchParams.get("org_id");
  if (!requestedOrgId || requestedOrgId !== orgId) {
    return NextResponse.json(
      { error: "organization_mismatch" },
      { status: 403 },
    );
  }

  const limit = integerParameter(request.nextUrl.searchParams.get("limit"), 20);
  const offset = integerParameter(
    request.nextUrl.searchParams.get("offset"),
    0,
  );
  if (limit === null || limit < 1 || limit > 20 || offset === null) {
    return NextResponse.json({ error: "invalid_pagination" }, { status: 400 });
  }
  const query = request.nextUrl.searchParams.get("query")?.trim() || undefined;
  if (query && query.length > 255) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  const token = await getToken();
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const page = await dependencies.listProjects({
      clerkSessionToken: token,
      query,
      limit,
      offset,
    });
    return NextResponse.json({
      projects: page.projects,
      has_more: page.hasMore,
      next_offset: page.nextOffset,
    });
  } catch (error) {
    const status = error instanceof OAuthProjectsError ? error.status : 500;
    console.error("[oauth/projects] failed to list projects", { error });
    return NextResponse.json({ error: "projects_unavailable" }, { status });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return oauthProjectsRequest(request);
}
