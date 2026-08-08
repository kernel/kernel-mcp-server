import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";

export type McpDependencies = {
  createKernelClient: (token: string) => KernelClient;
};

export const defaultMcpDependencies: McpDependencies = {
  createKernelClient,
};
