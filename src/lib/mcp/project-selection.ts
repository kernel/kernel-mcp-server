import { createHash } from "crypto";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

export interface ProjectSelectionOptions {
  projectSelection?: boolean;
}

export interface ProjectSelectionParams {
  project_id?: string;
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
  return (enabled ? { project_id: projectIDSchema } : {}) as {
    project_id: typeof projectIDSchema;
  };
}

export function projectIDFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const projectID = (params as ProjectSelectionParams).project_id;
  return typeof projectID === "string" && projectID.length > 0
    ? projectID
    : undefined;
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
  if (scopeCache.size >= MAX_SCOPE_CACHE_ENTRIES) {
    const oldest = scopeCache.keys().next().value;
    if (oldest) scopeCache.delete(oldest);
  }
  scopeCache.set(scopeCacheKey(token), {
    allowsProjectSelection,
    expiresAt: Date.now() + SCOPE_CACHE_TTL_MS,
  });
}

type ScopeResolutionDependencies = Pick<McpDependencies, "createKernelClient">;

export async function connectionAllowsProjectSelection(
  token: string,
  dependencies: ScopeResolutionDependencies = defaultMcpDependencies,
  cacheIdentity?: string,
) {
  if (process.env.KERNEL_PROJECT) return false;

  const cacheKey = cacheIdentity ?? token;
  const cached = readScopeCache(cacheKey);
  if (cached !== undefined) return cached;
  const stale = readScopeCache(cacheKey, true);

  try {
    const context = await dependencies
      .createKernelClient(token)
      .auth.context.retrieve();
    const allowsProjectSelection =
      context.authorization.credential_scope.project_id === null;
    writeScopeCache(cacheKey, allowsProjectSelection);
    return allowsProjectSelection;
  } catch {
    console.warn("Failed to resolve MCP connection project scope");
    return stale ?? false;
  }
}

export function clearProjectSelectionScopeCacheForTests() {
  scopeCache.clear();
}

export function expireProjectSelectionScopeCacheForTests() {
  for (const entry of scopeCache.values()) entry.expiresAt = 0;
}
