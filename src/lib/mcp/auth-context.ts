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

type AuthContextResolution =
  | { context: AuthContext; transientFailure: false }
  | { context: null; transientFailure: boolean };

function isTransientAuthContextError(error: unknown) {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status !== "number") return true;
  return status === 408 || status === 429 || status >= 500;
}

async function resolveMcpAuthContext({
  token,
  signal,
  dependencies = defaultMcpDependencies,
}: ResolveAuthContextOptions): Promise<AuthContextResolution> {
  try {
    const context = await dependencies
      .createKernelClient(token)
      .auth.context.retrieve({ signal });
    const parsed = authContextSchema.safeParse(context);
    if (parsed.success) {
      return { context: parsed.data, transientFailure: false };
    }
    console.warn("Received invalid MCP auth context", parsed.error.issues);
    return { context: null, transientFailure: false };
  } catch (error) {
    console.warn(
      "Failed to resolve MCP auth context",
      error instanceof Error ? error.message : error,
    );
    return {
      context: null,
      transientFailure: isTransientAuthContextError(error),
    };
  }
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
const CONNECTION_CONTEXT_STALE_TTL_MS = 30 * 60 * 1000;
const MAX_CONNECTION_CONTEXT_CACHE_ENTRIES = 1_000;
const connectionContextCache = new Map<
  string,
  { context: McpConnectionContext; expiresAt: number; staleUntil: number }
>();

function connectionContextCacheKey(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function readConnectionContextCache(identity: string, allowExpired = false) {
  const cached = connectionContextCache.get(
    connectionContextCacheKey(identity),
  );
  if (!cached) return null;
  const now = Date.now();
  if (allowExpired ? cached.staleUntil <= now : cached.expiresAt <= now) {
    return null;
  }
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
  const now = Date.now();
  connectionContextCache.set(key, {
    context,
    expiresAt: now + CONNECTION_CONTEXT_CACHE_TTL_MS,
    staleUntil: now + CONNECTION_CONTEXT_STALE_TTL_MS,
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

  const resolution = await resolveMcpAuthContext({
    token,
    signal,
    dependencies,
  });
  if (!resolution.context) {
    if (cacheIdentity && !resolution.transientFailure) {
      connectionContextCache.delete(connectionContextCacheKey(cacheIdentity));
    }
    return resolution.transientFailure ? stale : null;
  }

  const scope = connectionScopeFromAuthContext(resolution.context);
  if (!scope) {
    console.warn("Received inconsistent MCP connection scope");
    if (cacheIdentity) {
      connectionContextCache.delete(connectionContextCacheKey(cacheIdentity));
    }
    return null;
  }

  const context = { authContext: resolution.context, scope };
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
