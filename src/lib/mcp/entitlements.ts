import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const entitlementsSchema = z.object({
  features: z.record(z.string(), z.unknown()),
});
const featureSchema = z.object({ enabled: z.boolean() });

function featureEnabled(value: unknown): boolean {
  const parsed = featureSchema.safeParse(value);
  return parsed.success && parsed.data.enabled;
}

export async function resolveMcpEntitlements({
  token,
  signal,
  dependencies = defaultMcpDependencies,
}: {
  token: string;
  signal?: AbortSignal;
  dependencies?: Pick<McpDependencies, "createKernelClient">;
}): Promise<{ vaults: boolean; search: boolean }> {
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
    return {
      vaults: featureEnabled(parsed.data.features.vaults),
      search: featureEnabled(parsed.data.features.search),
    };
  } catch {
    // Do not expose upstream error bodies or interrupt unrelated toolsets.
    console.warn("Unable to resolve MCP feature entitlements; tools disabled");
    return { vaults: false, search: false };
  }
}
