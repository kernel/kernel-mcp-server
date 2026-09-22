import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const providersSchema = z.array(
  z.object({
    slug: z.string().min(1),
  }),
);

export async function resolveMcpSearchAccess({
  token,
  signal,
  dependencies = defaultMcpDependencies,
}: {
  token: string;
  signal?: AbortSignal;
  dependencies?: Pick<McpDependencies, "createKernelClient">;
}): Promise<boolean> {
  try {
    // Provider discovery is gated by the same org flag as search execution.
    // Use the SDK transport until its generated resources include Search.
    const providers = await dependencies
      .createKernelClient(token)
      .get<unknown>("/search/providers", {
        signal,
        maxRetries: 0,
        timeout: 5_000,
      });
    return providersSchema.safeParse(providers).success;
  } catch {
    console.warn("Unable to resolve MCP search access; search tools disabled");
    return false;
  }
}
