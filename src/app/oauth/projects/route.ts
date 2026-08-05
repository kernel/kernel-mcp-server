import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { listOAuthProjects, OAuthProjectsError } from "@/lib/oauth-projects";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { userId, orgId, getToken } = await auth();
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

  const token = await getToken();
  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({ projects: await listOAuthProjects(token) });
  } catch (error) {
    const status = error instanceof OAuthProjectsError ? error.status : 500;
    console.error("[oauth/projects] failed to list projects", { error });
    return NextResponse.json({ error: "projects_unavailable" }, { status });
  }
}
