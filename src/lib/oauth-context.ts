import { createHash } from "crypto";

export const OAUTH_CONTEXT_VERSION = 1;
export const ORGANIZATION_ACCESS_SCOPE = "organization";
export const PROJECT_ACCESS_SCOPE = "project";

export type OAuthAccessScope =
  | typeof ORGANIZATION_ACCESS_SCOPE
  | typeof PROJECT_ACCESS_SCOPE;

interface OAuthAuthorizationContextBase {
  version: typeof OAUTH_CONTEXT_VERSION;
  clerk_user_id?: string;
  clerk_org_id: string;
}

export type OAuthAuthorizationContext = OAuthAuthorizationContextBase &
  (
    | {
        access_scope: typeof ORGANIZATION_ACCESS_SCOPE;
        project_id?: never;
      }
    | {
        access_scope: typeof PROJECT_ACCESS_SCOPE;
        project_id: string;
      }
  );

export function organizationAuthorizationContext({
  clerkUserId,
  clerkOrgId,
}: {
  clerkUserId?: string;
  clerkOrgId: string;
}): OAuthAuthorizationContext {
  return {
    version: OAUTH_CONTEXT_VERSION,
    ...(clerkUserId ? { clerk_user_id: clerkUserId } : {}),
    clerk_org_id: clerkOrgId,
    access_scope: ORGANIZATION_ACCESS_SCOPE,
  };
}

export function projectAuthorizationContext({
  clerkUserId,
  clerkOrgId,
  projectId,
}: {
  clerkUserId?: string;
  clerkOrgId: string;
  projectId: string;
}): OAuthAuthorizationContext {
  return {
    version: OAUTH_CONTEXT_VERSION,
    ...(clerkUserId ? { clerk_user_id: clerkUserId } : {}),
    clerk_org_id: clerkOrgId,
    access_scope: PROJECT_ACCESS_SCOPE,
    project_id: projectId,
  };
}

export function parseAuthorizationContext(
  value: string,
): OAuthAuthorizationContext {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("OAuth authorization context is empty");

  // Existing access and refresh token mappings contain only a Clerk org ID.
  if (trimmed.startsWith("org_")) {
    return organizationAuthorizationContext({ clerkOrgId: trimmed });
  }

  const decoded: unknown = JSON.parse(trimmed);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("OAuth authorization context must be an object");
  }
  const parsed = decoded as Partial<OAuthAuthorizationContext>;
  if (parsed.version !== OAUTH_CONTEXT_VERSION) {
    throw new Error(
      `Unsupported OAuth authorization context version: ${String(parsed.version)}`,
    );
  }
  if (!parsed.clerk_org_id) {
    throw new Error("OAuth authorization context is missing clerk_org_id");
  }
  if (
    parsed.clerk_user_id !== undefined &&
    typeof parsed.clerk_user_id !== "string"
  ) {
    throw new Error("OAuth authorization context has invalid clerk_user_id");
  }

  if (parsed.access_scope === ORGANIZATION_ACCESS_SCOPE) {
    if (parsed.project_id) {
      throw new Error(
        "Organization-scoped OAuth context cannot include project_id",
      );
    }
    return organizationAuthorizationContext({
      clerkUserId: parsed.clerk_user_id,
      clerkOrgId: parsed.clerk_org_id,
    });
  }

  if (parsed.access_scope === PROJECT_ACCESS_SCOPE) {
    if (!parsed.project_id) {
      throw new Error("Project-scoped OAuth context is missing project_id");
    }
    return projectAuthorizationContext({
      clerkUserId: parsed.clerk_user_id,
      clerkOrgId: parsed.clerk_org_id,
      projectId: parsed.project_id,
    });
  }

  throw new Error(
    `Unsupported OAuth access scope: ${String(parsed.access_scope)}`,
  );
}

export function serializeAuthorizationContext(
  context: OAuthAuthorizationContext,
): string {
  // Validate before writing so malformed boundaries never enter Redis.
  return JSON.stringify(parseAuthorizationContext(JSON.stringify(context)));
}

export function deriveS256CodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function authorizationContextFromSelection({
  clerkUserId,
  clerkOrgId,
  accessScope,
  projectId,
}: {
  clerkUserId: string;
  clerkOrgId: string;
  accessScope: string | null;
  projectId: string | null;
}): OAuthAuthorizationContext {
  const normalizedScope = accessScope || ORGANIZATION_ACCESS_SCOPE;
  if (normalizedScope === ORGANIZATION_ACCESS_SCOPE) {
    if (projectId) {
      throw new Error("Organization-wide access cannot include a project");
    }
    return organizationAuthorizationContext({ clerkUserId, clerkOrgId });
  }
  if (normalizedScope === PROJECT_ACCESS_SCOPE) {
    if (!projectId) throw new Error("Project access requires a project");
    return projectAuthorizationContext({
      clerkUserId,
      clerkOrgId,
      projectId,
    });
  }
  throw new Error(`Unsupported OAuth access scope: ${normalizedScope}`);
}
