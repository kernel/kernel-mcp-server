import { describe, expect, test } from "bun:test";
import { Kernel } from "@onkernel/sdk";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";

describe("browser vault attachment", () => {
  test("advertises inline vault references without JSON Schema refs", async () => {
    const fixture = await connectTestMcp(registerBrowserCapabilities, {});
    try {
      const { tools } = await fixture.client.listTools();
      const browser = tools.find((tool) => tool.name === "manage_browsers");
      expect(browser?.inputSchema.properties).toHaveProperty("vaults");
      expect(JSON.stringify(browser?.inputSchema)).not.toContain('"$ref"');
    } finally {
      await fixture.close();
    }
  });

  test("forwards creation-only references by ID and name", async () => {
    const requests: Array<{ body: unknown; options: unknown }> = [];
    const fixture = await connectTestMcp(registerBrowserCapabilities, {
      browsers: {
        create: async (body: unknown, options: unknown) => {
          requests.push({ body, options });
          return { session_id: "brr_123" };
        },
      },
    });
    const vaults = [{ id: "vlt_123" }, { name: "checkout" }];
    try {
      const result = await fixture.client.callTool({
        name: "manage_browsers",
        arguments: { action: "create", vaults, headless: false },
      });
      expect(result.isError).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0].body).toEqual({ headless: false, vaults });
      expect(requests[0].options).toMatchObject({ maxRetries: 0 });
    } finally {
      await fixture.close();
    }
  });

  test.each(
    [
      [{}],
      [{ id: "vlt_123", name: "checkout" }],
      [{ name: "checkout" }, { name: "checkout" }],
      [{ name: "../other" }],
      [{ id: "" }],
      [{ name: "checkout", secret: "hidden" }],
      Array.from({ length: 21 }, (_, index) => ({ name: `vault-${index}` })),
    ].map((vaults) => ({ vaults })),
  )(
    "rejects invalid vault references without creating a browser",
    async ({ vaults }) => {
      let creates = 0;
      const fixture = await connectTestMcp(registerBrowserCapabilities, {
        browsers: {
          create: async () => {
            creates++;
            return { session_id: "brr_123" };
          },
        },
      });
      try {
        const result = await fixture.client.callTool({
          name: "manage_browsers",
          arguments: { action: "create", vaults },
        });
        expect(result.isError).toBe(true);
        expect(creates).toBe(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("accepts the 20-reference boundary and rejects mutation of existing bindings", async () => {
    let creates = 0;
    let updates = 0;
    const fixture = await connectTestMcp(registerBrowserCapabilities, {
      browsers: {
        create: async () => {
          creates++;
          return { session_id: "brr_123" };
        },
        update: async () => {
          updates++;
          return { session_id: "brr_123" };
        },
      },
    });
    try {
      const result = await fixture.client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "create",
          vaults: Array.from({ length: 20 }, (_, index) => ({
            name: `vault-${index}`,
          })),
        },
      });
      expect(result.isError).toBeUndefined();
      const update = await fixture.client.callTool({
        name: "manage_browsers",
        arguments: {
          action: "update",
          session_id: "brr_123",
          vaults: [{ name: "checkout" }],
        },
      });
      expect(update.isError).toBe(true);
      expect(JSON.stringify(update)).toContain("creation-only");
      expect(creates).toBe(1);
      expect(updates).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  test("does not retry a failed vault-bound browser creation", async () => {
    let calls = 0;
    const sdk = new Kernel({
      apiKey: "test-key",
      baseURL: "https://api.example",
      fetch: async () => {
        calls++;
        return Response.json({ message: "Unavailable" }, { status: 503 });
      },
    });
    const fixture = await connectTestMcp(registerBrowserCapabilities, sdk);
    try {
      const result = await fixture.client.callTool({
        name: "manage_browsers",
        arguments: { action: "create", vaults: [{ name: "checkout" }] },
      });
      expect(result.isError).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
