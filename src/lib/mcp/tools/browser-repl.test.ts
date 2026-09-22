/// <reference types="bun-types" />

import { APIConnectionTimeoutError } from "@onkernel/sdk";
import { expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerBrowserReplTool } from "@/lib/mcp/tools/browser-repl";

const TRANSPORT_HEADROOM_MS = 30_000;

type ReplCall = {
  sessionId: string;
  body: Record<string, unknown>;
  options: Record<string, unknown>;
};

function browserReplClient(
  calls: ReplCall[],
  result: () => unknown = () => ({
    success: true,
    repl_id: "abcdefghijklmnopqrstuvwx",
    duration_ms: 12,
  }),
) {
  return {
    browsers: {
      repl: async (
        sessionId: string,
        body: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        calls.push({ sessionId, body, options });
        return result();
      },
    },
  };
}

test("execute_browser_repl sends one cell with aligned execution and transport deadlines", async () => {
  const calls: ReplCall[] = [];
  const { client, close } = await connectTestMcp(
    registerBrowserReplTool,
    browserReplClient(calls),
  );

  try {
    await client.callTool({
      name: "execute_browser_repl",
      arguments: {
        session_id: "browser-name",
        code: 'repl.write("ready")',
        reset: true,
      },
    });
  } finally {
    await close();
  }

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    sessionId: "browser-name",
    body: {
      code: 'repl.write("ready")',
      reset: true,
      timeout_sec: 60,
    },
    options: {
      maxRetries: 0,
      timeout: 60_000 + TRANSPORT_HEADROOM_MS,
    },
  });
});

test("execute_browser_repl returns structured ordered output and MCP images", async () => {
  const { client, close } = await connectTestMcp(
    registerBrowserReplTool,
    browserReplClient([], () => ({
      success: true,
      repl_id: "abcdefghijklmnopqrstuvwx",
      duration_ms: 7,
      content_truncated: false,
      content: [
        {
          type: "text",
          channel: "write",
          text: '{"title":"Example Domain"}',
        },
        {
          type: "image",
          mime_type: "image/png",
          data_b64: "aGVsbG8=",
        },
        { type: "text", channel: "stderr", text: "warning" },
      ],
    })),
  );

  try {
    const result = await client.callTool({
      name: "execute_browser_repl",
      arguments: { session_id: "ses_1", code: "run()" },
    });
    const content = result.content as Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;
    expect(content).toHaveLength(2);
    expect(JSON.parse((content[0] as { text: string }).text)).toEqual({
      success: true,
      repl_id: "abcdefghijklmnopqrstuvwx",
      content: [
        {
          index: 0,
          type: "text",
          channel: "write",
          text: '{"title":"Example Domain"}',
        },
        { index: 1, type: "image", mime_type: "image/png" },
        { index: 2, type: "text", channel: "stderr", text: "warning" },
      ],
      content_truncated: false,
      duration_ms: 7,
    });
    expect(content[1]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
  } finally {
    await close();
  }
});

test("execute_browser_repl keeps JavaScript failures structured instead of turning them into transport errors", async () => {
  const { client, close } = await connectTestMcp(
    registerBrowserReplTool,
    browserReplClient([], () => ({
      success: false,
      repl_id: "abcdefghijklmnopqrstuvwx",
      error: "Error: boom",
      stack: "Error: boom\n    at repl:1:1",
      repl_terminated: false,
    })),
  );

  try {
    const result = await client.callTool({
      name: "execute_browser_repl",
      arguments: { session_id: "ses_1", code: 'throw new Error("boom")' },
    });
    expect(result.isError).not.toBe(true);
    const summary = JSON.parse(
      (result.content as Array<{ type: "text"; text: string }>)[0].text,
    );
    expect(summary).toMatchObject({
      success: false,
      repl_id: "abcdefghijklmnopqrstuvwx",
      error: "Error: boom",
      repl_terminated: false,
    });
  } finally {
    await close();
  }
});

test("execute_browser_repl allows reset without code and rejects an empty normal cell", async () => {
  const calls: ReplCall[] = [];
  const { client, close } = await connectTestMcp(
    registerBrowserReplTool,
    browserReplClient(calls),
  );

  try {
    await client.callTool({
      name: "execute_browser_repl",
      arguments: { session_id: "ses_1", reset: true },
    });
    expect(calls[0].body).toEqual({
      code: "",
      reset: true,
      timeout_sec: 60,
    });

    const rejected = await client.callTool({
      name: "execute_browser_repl",
      arguments: { session_id: "ses_1" },
    });
    expect(rejected.isError).toBe(true);
    expect(calls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("execute_browser_repl advertises persistent semantics and complete Playwright and CDP examples", async () => {
  const { client, close } = await connectTestMcp(
    registerBrowserReplTool,
    browserReplClient([]),
  );

  try {
    const { tools } = await client.listTools();
    const tool = tools.find(
      (candidate) => candidate.name === "execute_browser_repl",
    );
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("persistent Node.js Browser REPL");
    expect(tool?.description).not.toContain("execute_playwright_code");
    expect(tool?.description).toContain("JavaScript only");
    expect(tool?.description).toContain("Expression values are ignored");
    expect(tool?.description).toContain("filter accessibilitySnapshot().nodes");
    expect(tool?.description).toContain(
      'pwPage.locator("main").ariaSnapshot()',
    );
    expect(tool?.description).toContain("Do not dump the full DOM");
    expect(tool?.description).toContain('repl.help("click")');
    expect(tool?.description).toContain(
      'var playwright = await import("patchright")',
    );
    expect(tool?.description).toContain('cdp("Target.createTarget"');
    expect(tool?.description).toContain('cdp("Runtime.evaluate"');
    expect(tool?.description).toContain("unrestricted code execution");

    const schema = tool?.inputSchema as {
      properties: Record<
        string,
        {
          default?: unknown;
          minimum?: number;
          maximum?: number;
          description?: string;
        }
      >;
    };
    expect(schema.properties.code.description).toContain(
      "region-scoped Playwright ariaSnapshot()",
    );
    expect(schema.properties.code.default).toBe("");
    expect(schema.properties.reset.default).toBe(false);
    expect(schema.properties.timeout_sec).toMatchObject({
      default: 60,
      minimum: 1,
      maximum: 150,
    });
  } finally {
    await close();
  }
});

test("execute_browser_repl reports transport failures through the shared classifier", async () => {
  const { client, close } = await connectTestMcp(registerBrowserReplTool, {
    browsers: {
      repl: async () => {
        throw new APIConnectionTimeoutError();
      },
    },
  });

  try {
    const result = await client.callTool({
      name: "execute_browser_repl",
      arguments: { session_id: "ses_1", code: "sideEffect()" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toStartWith("Error in execute_browser_repl (execute):");
  } finally {
    await close();
  }
});
