import { describe, expect, spyOn, test } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import { resolveMcpVaultAccess } from "@/lib/mcp/entitlements";

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

describe("MCP vault entitlement", () => {
  test.each([
    { body: { features: { vaults: { enabled: true } } }, enabled: true },
    { body: { features: { vaults: { enabled: false } } }, enabled: false },
    { body: { features: {} }, enabled: false },
    { body: {}, enabled: false },
    { body: null, enabled: false },
    { body: { features: { vaults: null } }, enabled: false },
    { body: { features: { vaults: { enabled: "true" } } }, enabled: false },
    { body: { features: { vaults: { enabled: 1 } } }, enabled: false },
    { body: { features: { vaults: { enabled: null } } }, enabled: false },
  ])("requires an explicit boolean entitlement", async ({ body, enabled }) => {
    const { requests, dependencies } = fixture(body);
    expect(
      await resolveMcpVaultAccess({ token: "sk_project_key", dependencies }),
    ).toBe(enabled);
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
          await resolveMcpVaultAccess({ token: "sk_secret", dependencies }),
        ).toBe(false);
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
      features: { vaults: { enabled: true } },
    });
    const client = dependencies.createKernelClient("sk_key");
    const retrieve = spyOn(client.organization.entitlements, "retrieve");
    const controller = new AbortController();
    try {
      expect(
        await resolveMcpVaultAccess({
          token: "sk_key",
          signal: controller.signal,
          dependencies: { createKernelClient: () => client },
        }),
      ).toBe(true);
      expect(retrieve).toHaveBeenCalledWith({
        signal: controller.signal,
        maxRetries: 0,
        timeout: 5_000,
      });
      controller.abort();
      expect(
        await resolveMcpVaultAccess({
          token: "sk_key",
          signal: controller.signal,
          dependencies: { createKernelClient: () => client },
        }),
      ).toBe(false);
    } finally {
      retrieve.mockRestore();
    }
  });

  test("does not reuse access across credentials or after revocation", async () => {
    let enabled = true;
    const tokens: string[] = [];
    const dependencies = {
      createKernelClient: (token: string) => {
        tokens.push(token);
        return fixture({
          features: { vaults: { enabled: token === "org_a" && enabled } },
        }).dependencies.createKernelClient(token);
      },
    };
    expect(await resolveMcpVaultAccess({ token: "org_a", dependencies })).toBe(
      true,
    );
    expect(await resolveMcpVaultAccess({ token: "org_b", dependencies })).toBe(
      false,
    );
    enabled = false;
    expect(await resolveMcpVaultAccess({ token: "org_a", dependencies })).toBe(
      false,
    );
    expect(tokens).toEqual(["org_a", "org_b", "org_a"]);
  });
});
