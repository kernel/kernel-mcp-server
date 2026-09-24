import { describe, expect, spyOn, test } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import { resolveMcpEntitlements } from "@/lib/mcp/entitlements";

function fixture(body: unknown, status = 200) {
  const requests: Request[] = [];
  const dependencies = {
    createKernelClient: (token: string) =>
      new Kernel({
        apiKey: token,
        project: "proj_pinned",
        baseURL: "https://api.example.test",
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(body, { status });
        },
      }),
  };
  return { requests, dependencies };
}

describe("MCP feature entitlements", () => {
  test.each([
    {
      body: {
        features: {
          vaults: { enabled: true },
          search: { enabled: true },
        },
      },
      expected: { vaults: true, search: true },
    },
    {
      body: {
        features: {
          vaults: { enabled: false },
          search: { enabled: false },
        },
      },
      expected: { vaults: false, search: false },
    },
    {
      body: { features: { vaults: { enabled: true } } },
      expected: { vaults: true, search: false },
    },
    { body: { features: {} }, expected: { vaults: false, search: false } },
    { body: {}, expected: { vaults: false, search: false } },
    { body: null, expected: { vaults: false, search: false } },
    {
      body: {
        features: {
          vaults: { enabled: true },
          search: { enabled: "true" },
        },
      },
      expected: { vaults: true, search: false },
    },
  ])("requires explicit boolean entitlements", async ({ body, expected }) => {
    const { requests, dependencies } = fixture(body);
    expect(
      await resolveMcpEntitlements({ token: "sk_project_key", dependencies }),
    ).toEqual(expected);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(new URL(requests[0].url).pathname).toBe("/org/entitlements");
    expect(requests[0].headers.get("Authorization")).toBe(
      "Bearer sk_project_key",
    );
    expect(requests[0].headers.get("X-Kernel-Project")).toBe("proj_pinned");
  });

  test.each([401, 403, 404, 429, 500, 503])(
    "fails closed without retrying HTTP %s",
    async (status) => {
      const { requests, dependencies } = fixture(
        { message: "hidden-provider-secret" },
        status,
      );
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          await resolveMcpEntitlements({ token: "sk_secret", dependencies }),
        ).toEqual({ vaults: false, search: false });
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          "hidden-provider-secret",
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("bounds the lookup and forwards cancellation", async () => {
    const { dependencies } = fixture({
      features: {
        vaults: { enabled: true },
        search: { enabled: true },
      },
    });
    const client = dependencies.createKernelClient("sk_key");
    const get = spyOn(client, "get");
    const controller = new AbortController();
    try {
      expect(
        await resolveMcpEntitlements({
          token: "sk_key",
          signal: controller.signal,
          dependencies: { createKernelClient: () => client },
        }),
      ).toEqual({ vaults: true, search: true });
      expect(get).toHaveBeenCalledWith("/org/entitlements", {
        signal: controller.signal,
        maxRetries: 0,
        timeout: 5_000,
      });
      controller.abort();
      expect(
        await resolveMcpEntitlements({
          token: "sk_key",
          signal: controller.signal,
          dependencies: { createKernelClient: () => client },
        }),
      ).toEqual({ vaults: false, search: false });
    } finally {
      get.mockRestore();
    }
  });

  test("does not reuse access across credentials or after revocation", async () => {
    let enabled = true;
    const tokens: string[] = [];
    const dependencies = {
      createKernelClient: (token: string) => {
        tokens.push(token);
        return fixture({
          features: {
            vaults: { enabled: token === "org_a" && enabled },
            search: { enabled: token === "org_a" && enabled },
          },
        }).dependencies.createKernelClient(token);
      },
    };
    expect(
      await resolveMcpEntitlements({ token: "org_a", dependencies }),
    ).toEqual({
      vaults: true,
      search: true,
    });
    expect(
      await resolveMcpEntitlements({ token: "org_b", dependencies }),
    ).toEqual({
      vaults: false,
      search: false,
    });
    enabled = false;
    expect(
      await resolveMcpEntitlements({ token: "org_a", dependencies }),
    ).toEqual({
      vaults: false,
      search: false,
    });
    expect(tokens).toEqual(["org_a", "org_b", "org_a"]);
  });
});
