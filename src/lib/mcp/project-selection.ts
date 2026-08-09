import type { AuthContext } from "@onkernel/sdk/resources/auth/context";
import { createHash } from "crypto";
import { z } from "zod";
import { resolveMcpAuthContext } from "@/lib/mcp/auth-context";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

export interface ProjectSelectionOptions {
  projectSelection?: boolean;
}

const projectIDSchema = z
  .string()
  .min(1)
  .describe(
    "Project ID used to scope this operation. Available only on organization-wide connections. Preserve it for subsequent operations on the same resource.",
  )
  .optional();

export function projectSelectionInputSchema(enabled = false): {
  project_id: typeof projectIDSchema;
} {
  // MCP tool registration needs one stable inferred handler type even though
  // project-scoped connections omit this property from their runtime schema.
  return (enabled ? { project_id: projectIDSchema } : {}) as {
    project_id: typeof projectIDSchema;
  };
}

const SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SCOPE_CACHE_ENTRIES = 1_000;
const scopeCache = new Map<
  string,
  { allowsProjectSelection: boolean; expiresAt: number }
>();

function scopeCacheKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function readScopeCache(token: string, allowExpired = false) {
  const cached = scopeCache.get(scopeCacheKey(token));
  if (!cached || (!allowExpired && cached.expiresAt <= Date.now())) {
    return undefined;
  }
  return cached.allowsProjectSelection;
}

function writeScopeCache(token: string, allowsProjectSelection: boolean) {
  const key = scopeCacheKey(token);
  scopeCache.delete(key);
  if (scopeCache.size >= MAX_SCOPE_CACHE_ENTRIES) {
    const oldest = scopeCache.keys().next().value;
    if (oldest) scopeCache.delete(oldest);
  }
  scopeCache.set(key, {
    allowsProjectSelection,
    expiresAt: Date.now() + SCOPE_CACHE_TTL_MS,
  });
}

type ScopeResolutionDependencies = Pick<McpDependencies, "createKernelClient">;

type ConnectionProjectSelectionOptions = {
  token: string;
  dependencies?: ScopeResolutionDependencies;
  cacheIdentity?: string;
  authContext?: Promise<AuthContext | null>;
};

export async function connectionAllowsProjectSelection({
  token,
  dependencies = defaultMcpDependencies,
  cacheIdentity,
  authContext,
}: ConnectionProjectSelectionOptions) {
  if (process.env.KERNEL_PROJECT) return false;

  const cacheKey = cacheIdentity ?? token;
  const cached = readScopeCache(cacheKey);
  if (cached !== undefined) return cached;
  // A successfully resolved capability remains authoritative during later
  // transient failures, including OAuth token refreshes in the same session.
  const stale = readScopeCache(cacheKey, true);

  const context = await (authContext ??
    resolveMcpAuthContext({ token, dependencies }));
  if (!context) {
    if (stale !== undefined) return stale;
    throw new Error("Unable to resolve MCP connection project scope");
  }

  const allowsProjectSelection =
    context.authorization.credential_scope.project_id === null;
  writeScopeCache(cacheKey, allowsProjectSelection);
  return allowsProjectSelection;
}

export function clearProjectSelectionScopeCacheForTests() {
  scopeCache.clear();
}

export function expireProjectSelectionScopeCacheForTests() {
  for (const entry of scopeCache.values()) entry.expiresAt = 0;
}
