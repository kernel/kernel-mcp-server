import { Kernel } from "@onkernel/sdk";

export function createKernelClient(apiKey: string, projectID?: string) {
  return new Kernel({
    apiKey,
    projectID: projectID ?? process.env.KERNEL_PROJECT,
    baseURL: process.env.API_BASE_URL,
    defaultHeaders: {
      "X-Source": "mcp-server",
      "X-Referral-Source": "mcp.onkernel.com",
    },
  });
}

export type KernelClient = ReturnType<typeof createKernelClient>;
