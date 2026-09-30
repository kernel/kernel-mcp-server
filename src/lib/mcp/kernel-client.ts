import { Kernel } from "@onkernel/sdk";

export function createKernelClient(apiKey: string, project?: string) {
  return new Kernel({
    apiKey,
    // SDK debug logging includes request bodies, which can contain vault secrets.
    logLevel: "off",
    project: project ?? process.env.KERNEL_PROJECT,
    baseURL: process.env.API_BASE_URL,
    defaultHeaders: {
      "X-Source": "mcp-server",
      "X-Referral-Source": "mcp.onkernel.com",
    },
  });
}

export type KernelClient = ReturnType<typeof createKernelClient>;
