import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const vaultEntitlementSchema = z.object({
  features: z.object({
    vaults: z.object({ enabled: z.boolean() }),
  }),
});

export async function resolveMcpVaultAccess({
  token,
  signal,
  dependencies = defaultMcpDependencies,
}: {
  token: string;
  signal?: AbortSignal;
  dependencies?: Pick<McpDependencies, "createKernelClient">;
}): Promise<boolean> {
  try {
    const entitlements = await dependencies
      .createKernelClient(token)
      .organization.entitlements.retrieve({
        signal,
        maxRetries: 0,
        timeout: 5_000,
      });
    // Older APIs may not advertise vaults yet. Only explicit access enables tools.
    const parsed = vaultEntitlementSchema.safeParse(entitlements);
    return parsed.success && parsed.data.features.vaults.enabled;
  } catch {
    // Do not expose upstream error bodies or interrupt unrelated toolsets.
    console.warn(
      "Unable to resolve MCP vault entitlement; vault tools disabled",
    );
    return false;
  }
}
