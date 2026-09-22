import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";

const providersSchema = z.array(
  z.object({
    slug: z.string(),
    max_results_cap: z.number().int().positive(),
    params: z.record(z.unknown()),
    content: z.object({
      inline: z.boolean(),
      post_hoc: z.boolean(),
      freshness_control: z.boolean(),
    }),
    provider_options: z.object({
      schema_ref: z.string(),
      schema: z.record(z.unknown()),
    }),
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
