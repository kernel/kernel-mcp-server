import { describe, expect, spyOn, test } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import { resolveMcpSearchAccess } from "@/lib/mcp/search-access";

function fixture(body: unknown, status = 200) {
  const requests: Request[] = [];
  const client = new Kernel({
    apiKey: "sk_test",
    project: "proj_pinned",
    baseURL: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(body, { status });
    },
  });
  return {
    client,
    requests,
    dependencies: { createKernelClient: () => client },
  };
}

describe("MCP search access", () => {
  test.each([
    { body: [], enabled: true },
    {
      body: [
        {
          slug: "brave",
          max_results_cap: 20,
          params: {},
          content: { inline: true, post_hoc: false, freshness_control: false },
          provider_options: { schema_ref: "SearchBraveOptions", schema: {} },
        },
      ],
      enabled: true,
    },
    { body: {}, enabled: false },
    { body: null, enabled: false },
    { body: { enabled: true }, enabled: false },
    { body: [{ slug: "brave" }], enabled: true },
  ])(
    "requires successful, valid provider discovery",
    async ({ body, enabled }) => {
      const { requests, dependencies } = fixture(body);
      expect(
        await resolveMcpSearchAccess({ token: "sk_test", dependencies }),
      ).toBe(enabled);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe("GET");
      expect(new URL(requests[0].url).pathname).toBe("/search/providers");
      expect(requests[0].headers.get("Authorization")).toBe("Bearer sk_test");
      expect(requests[0].headers.get("X-Kernel-Project")).toBe("proj_pinned");
    },
  );

  test.each([401, 403, 404, 429, 500, 503])(
    "fails closed without retry or error leakage (%s)",
    async (status) => {
      const { requests, dependencies } = fixture(
        { message: "private-upstream-body" },
        status,
      );
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          await resolveMcpSearchAccess({ token: "sk_test", dependencies }),
        ).toBe(false);
        expect(requests).toHaveLength(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          "private-upstream-body",
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("bounds requests and forwards cancellation", async () => {
    const { client, dependencies } = fixture([]);
    const get = spyOn(client, "get");
    const controller = new AbortController();
    try {
      expect(
        await resolveMcpSearchAccess({
          token: "sk_test",
          dependencies,
          signal: controller.signal,
        }),
      ).toBe(true);
      expect(get).toHaveBeenCalledWith("/search/providers", {
        signal: controller.signal,
        maxRetries: 0,
        timeout: 5000,
      });
      controller.abort();
      expect(
        await resolveMcpSearchAccess({
          token: "sk_test",
          dependencies,
          signal: controller.signal,
        }),
      ).toBe(false);
    } finally {
      get.mockRestore();
    }
  });
});
