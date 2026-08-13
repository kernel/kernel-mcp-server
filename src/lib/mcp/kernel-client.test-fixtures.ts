import { mock } from "bun:test";

export const unusedKernelClient = new Proxy(
  {},
  {
    get: () => {
      throw new Error("unexpected Kernel client use");
    },
  },
);

export const kernelClientMock: {
  factory: (token: string, project?: string) => any;
} = {
  factory: () => unusedKernelClient,
};

export function resetKernelClientFactory() {
  kernelClientMock.factory = () => unusedKernelClient;
}

mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: (token: string, project?: string) =>
    kernelClientMock.factory(token, project),
}));
