/// <reference types="bun-types" />

import Kernel from "@onkernel/sdk";
import { expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";

test("attaches vault references only at creation and disables automatic retries", async () => {
  const calls: unknown[] = [];
  const vaults = [{ id: "vault_1" }, { name: "checkout" }];
  const { client, close } = await connectTestMcp(registerBrowserCapabilities, {
    browsers: {
      create: async (...args: unknown[]) => {
        calls.push(args);
        return { session_id: "browser_1", vaults };
      },
      update: async () => {
        throw new Error("must not change vault bindings");
      },
    },
  });
  try {
    const result = toolResultJSON(
      await client.callTool({
        name: "manage_browsers",
        arguments: { action: "create", vaults, headless: false },
      }),
    );
    expect(result.browser.vaults).toEqual(vaults);
    expect(calls).toEqual([
      [
        { vaults, headless: false },
        { maxRetries: 0, signal: expect.any(AbortSignal) },
      ],
    ]);
    const update = await client.callTool({
      name: "manage_browsers",
      arguments: {
        action: "update",
        session_id: "browser_1",
        vaults: [],
        name: "renamed",
      },
    });
    expect(update.isError).toBeTrue();
    expect(update.content).toEqual([
      {
        type: "text",
        text: "Error: vaults is create-only; browser vault bindings are immutable.",
      },
    ]);
  } finally {
    await close();
  }
});

test("rejects ambiguous, empty, oversized, and secret-bearing vault references", async () => {
  let creates = 0;
  const { client, close } = await connectTestMcp(registerBrowserCapabilities, {
    browsers: {
      create: async () => {
        creates++;
        return { session_id: "browser_1" };
      },
    },
  });
  try {
    for (const vaults of [
      [{}],
      [{ id: "vault_1", name: "checkout" }],
      [{ id: "" }],
      [{ name: "" }],
      [{ id: "vault_1", secret: "sensitive-value" }],
      Array(21).fill({ name: "checkout" }),
    ]) {
      expect(
        (
          await client.callTool({
            name: "manage_browsers",
            arguments: { action: "create", vaults },
          })
        ).isError,
      ).toBeTrue();
    }
    expect(creates).toBe(0);
  } finally {
    await close();
  }
});

test("forwards browser vaults through the real preview SDK and withholds provider errors", async () => {
  const requests: unknown[] = [];
  const sdk = new Kernel({
    apiKey: "test-key",
    baseURL: "https://api.example.test",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json(
        { message: "sensitive-value", provider_secret: "sensitive-value" },
        { status: 500 },
      );
    },
  });
  const { client, close } = await connectTestMcp(
    registerBrowserCapabilities,
    sdk,
  );
  try {
    const result = await client.callTool({
      name: "manage_browsers",
      arguments: { action: "create", vaults: [{ name: "checkout" }] },
    });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/browsers",
        body: { vaults: [{ name: "checkout" }] },
      },
    ]);
    expect(result.isError).toBeTrue();
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
    expect(JSON.stringify(result)).toContain("Do not retry a payment");
  } finally {
    await close();
  }
});
