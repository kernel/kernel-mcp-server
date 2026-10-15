import { createHash } from "node:crypto";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const entitlementsSchema = z.object({
  features: z.record(z.string(), z.unknown()),
});
const featureSchema = z.object({ enabled: z.boolean() });
const ENTITLEMENTS_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_ENTITLEMENTS_CACHE_ENTRIES = 1_000;
const entitlementsCache = new Map<
  string,
  { value: { vaults: boolean; search: boolean }; expiresAt: number }
>();

function entitlementCacheKey(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function featureEnabled(value: unknown): boolean {
  const parsed = featureSchema.safeParse(value);
  return parsed.success && parsed.data.enabled;
}

export async function resolveMcpEntitlements({
  token,
  signal,
  dependencies = defaultMcpDependencies,
  cacheIdentity,
}: {
  token: string;
  signal?: AbortSignal;
  dependencies?: Pick<McpDependencies, "createKernelClient">;
  cacheIdentity?: string;
}): Promise<{ vaults: boolean; search: boolean }> {
  const key = cacheIdentity ? entitlementCacheKey(cacheIdentity) : undefined;
  if (key) {
    const cached = entitlementsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) entitlementsCache.delete(key);
  }

  try {
    const entitlements = await dependencies
      .createKernelClient(token)
      .get<unknown>("/org/entitlements", {
        signal,
        maxRetries: 0,
        timeout: 5_000,
      });
    const parsed = entitlementsSchema.safeParse(entitlements);
    if (!parsed.success) return { vaults: false, search: false };
    const value = {
      vaults: featureEnabled(parsed.data.features.vaults),
      search: featureEnabled(parsed.data.features.search),
    };
    if (key) {
      const now = Date.now();
      for (const [entryKey, entry] of entitlementsCache) {
        if (entry.expiresAt <= now) entitlementsCache.delete(entryKey);
      }
      if (entitlementsCache.size >= MAX_ENTITLEMENTS_CACHE_ENTRIES) {
        const oldest = entitlementsCache.keys().next().value;
        if (oldest) entitlementsCache.delete(oldest);
      }
      entitlementsCache.set(key, {
        value,
        expiresAt: now + ENTITLEMENTS_CACHE_TTL_MS,
      });
    }
    return value;
  } catch {
    // Do not expose upstream error bodies or cache transient failures.
    console.warn("Unable to resolve MCP feature entitlements; tools disabled");
    return { vaults: false, search: false };
  }
}

export function clearMcpEntitlementsCacheForTests() {
  entitlementsCache.clear();
}
