import type { AuthContext } from "@onkernel/sdk/resources/auth/context";
import { createHash } from "crypto";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const authContextSchema: z.ZodType<AuthContext> = z.object({
  authentication: z.object({
    method: z.enum(["api_key", "jwt"]),
    source: z.enum(["api_key", "oauth", "dashboard"]),
    credential_id: z.string().nullable(),
  }),
  principal: z.object({
    type: z.enum(["api_key", "user"]),
    id: z.string().min(1),
  }),
  organization: z.object({
    id: z.string().min(1),
  }),
  authorization: z.object({
    credential_scope: z.object({ project_id: z.string().nullable() }),
    effective_scope: z.object({ project_id: z.string().nullable() }),
  }),
});

export type ConnectionScope =
  | {
      kind: "organization";
      organizationId: string;
      projectId: null;
      source: "credential";
    }
  | {
      kind: "project";
      organizationId: string;
      projectId: string;
      source: "credential" | "server_pin";
    };

export type McpConnectionContext = {
  authContext: AuthContext;
  scope: ConnectionScope;
};

export type McpConnectionAnalyticsContext = {
  authMethod: "api_key" | "oauth";
  credentialScope: "organization" | "project";
  connectionScope: "organization" | "project";
  scopeSource: "credential" | "server_pin";
  organizationId: string;
  userId: string | null;
};

type AuthContextDependencies = Pick<McpDependencies, "createKernelClient">;

type ResolveAuthContextOptions = {
  token: string;
  signal?: AbortSignal;
  dependencies?: AuthContextDependencies;
  cacheIdentity?: string;
};

export async function resolveMcpAuthContext({
  token,
  signal,
  dependencies = defaultMcpDependencies,
}: ResolveAuthContextOptions): Promise<AuthContext | null> {
  try {
    const context = await dependencies
      .createKernelClient(token)
      .auth.context.retrieve({ signal });
    const parsed = authContextSchema.safeParse(context);
    if (parsed.success) return parsed.data;
    console.warn("Received invalid MCP auth context", parsed.error.issues);
  } catch (error) {
    console.warn(
      "Failed to resolve MCP auth context",
      error instanceof Error ? error.message : error,
    );
  }
  return null;
}

export function connectionScopeFromAuthContext(
  context: AuthContext,
  serverProjectId = process.env.KERNEL_PROJECT,
): ConnectionScope | null {
  const organizationId = context.organization.id;
  const credentialProjectId = context.authorization.credential_scope.project_id;
  const effectiveProjectId = context.authorization.effective_scope.project_id;

  if (credentialProjectId) {
    if (effectiveProjectId !== credentialProjectId) return null;
    if (serverProjectId && serverProjectId !== credentialProjectId) return null;
    return {
      kind: "project",
      organizationId,
      projectId: credentialProjectId,
      source: "credential",
    };
  }

  if (serverProjectId) {
    if (effectiveProjectId !== serverProjectId) return null;
    return {
      kind: "project",
      organizationId,
      projectId: serverProjectId,
      source: "server_pin",
    };
  }

  if (effectiveProjectId) return null;
  return {
    kind: "organization",
    organizationId,
    projectId: null,
    source: "credential",
  };
}

const CONNECTION_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONNECTION_CONTEXT_CACHE_ENTRIES = 1_000;
const connectionContextCache = new Map<
  string,
  { context: McpConnectionContext; expiresAt: number }
>();

function connectionContextCacheKey(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function readConnectionContextCache(identity: string, allowExpired = false) {
  const cached = connectionContextCache.get(
    connectionContextCacheKey(identity),
  );
  if (!cached || (!allowExpired && cached.expiresAt <= Date.now())) return null;
  return cached.context;
}

function writeConnectionContextCache(
  identity: string,
  context: McpConnectionContext,
) {
  const key = connectionContextCacheKey(identity);
  connectionContextCache.delete(key);
  if (connectionContextCache.size >= MAX_CONNECTION_CONTEXT_CACHE_ENTRIES) {
    const oldest = connectionContextCache.keys().next().value;
    if (oldest) connectionContextCache.delete(oldest);
  }
  connectionContextCache.set(key, {
    context,
    expiresAt: Date.now() + CONNECTION_CONTEXT_CACHE_TTL_MS,
  });
}

export async function resolveMcpConnectionContext({
  token,
  signal,
  dependencies,
  cacheIdentity,
}: ResolveAuthContextOptions): Promise<McpConnectionContext | null> {
  if (cacheIdentity) {
    const cached = readConnectionContextCache(cacheIdentity);
    if (cached) return cached;
  }
  const stale = cacheIdentity
    ? readConnectionContextCache(cacheIdentity, true)
    : null;

  const authContext = await resolveMcpAuthContext({
    token,
    signal,
    dependencies,
  });
  if (!authContext) return stale;

  const scope = connectionScopeFromAuthContext(authContext);
  if (!scope) {
    console.warn("Received inconsistent MCP connection scope");
    return null;
  }

  const context = { authContext, scope };
  if (cacheIdentity) writeConnectionContextCache(cacheIdentity, context);
  return context;
}

export function clearMcpConnectionContextCacheForTests() {
  connectionContextCache.clear();
}

export function expireMcpConnectionContextCacheForTests() {
  for (const entry of connectionContextCache.values()) entry.expiresAt = 0;
}

export function connectionAnalyticsFromContext({
  authContext,
  scope,
}: McpConnectionContext): McpConnectionAnalyticsContext | null {
  const isApiKey =
    authContext.authentication.method === "api_key" &&
    authContext.authentication.source === "api_key" &&
    authContext.principal.type === "api_key";
  const isOAuth =
    authContext.authentication.method === "jwt" &&
    authContext.authentication.source === "oauth" &&
    authContext.principal.type === "user";
  if (!isApiKey && !isOAuth) return null;

  return {
    authMethod: isApiKey ? "api_key" : "oauth",
    credentialScope: authContext.authorization.credential_scope.project_id
      ? "project"
      : "organization",
    connectionScope: scope.kind,
    scopeSource: scope.source,
    organizationId: scope.organizationId,
    userId: isOAuth ? authContext.principal.id : null,
  };
}
