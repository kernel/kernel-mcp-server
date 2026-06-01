import { Kernel } from "@onkernel/sdk";

export function createKernelClient(apiKey: string) {
  const headers: Record<string, string> = {
    "X-Source": "mcp-server",
    "X-Referral-Source": "mcp.onkernel.com",
  };

  const projectId = process.env.KERNEL_PROJECT;
  if (projectId) {
    headers["X-Kernel-Project-Id"] = projectId;
  }

  return new Kernel({
    apiKey,
    baseURL: process.env.API_BASE_URL,
    defaultHeaders: headers,
  });
}

export type KernelClient = ReturnType<typeof createKernelClient>;
