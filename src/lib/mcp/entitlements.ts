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
const ENTITLEMENTS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTITLEMENTS_CACHE_ENTRIES = 1_000;
const entitlementsCache = new Map<
  string,
  { search: boolean; expiresAt: number }
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
  let cachedSearch: boolean | undefined;
  if (cacheIdentity) {
    const key = entitlementCacheKey(cacheIdentity);
    const cached = entitlementsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      cachedSearch = cached.search;
    } else if (cached) {
      entitlementsCache.delete(key);
    }
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
    if (!parsed.success)
      return { vaults: false, search: cachedSearch ?? false };
    const currentSearch = featureEnabled(parsed.data.features.search);
    if (cacheIdentity && cachedSearch === undefined) {
      if (entitlementsCache.size >= MAX_ENTITLEMENTS_CACHE_ENTRIES) {
        const oldest = entitlementsCache.keys().next().value;
        if (oldest) entitlementsCache.delete(oldest);
      }
      entitlementsCache.set(entitlementCacheKey(cacheIdentity), {
        search: currentSearch,
        expiresAt: Date.now() + ENTITLEMENTS_CACHE_TTL_MS,
      });
    }
    return {
      vaults: featureEnabled(parsed.data.features.vaults),
      search: cachedSearch ?? currentSearch,
    };
  } catch {
    // Do not expose upstream error bodies or interrupt unrelated toolsets.
    console.warn("Unable to resolve MCP feature entitlements; tools disabled");
    return { vaults: false, search: cachedSearch ?? false };
  }
}

export function clearMcpSearchEntitlementCacheForTests() {
  entitlementsCache.clear();
}
