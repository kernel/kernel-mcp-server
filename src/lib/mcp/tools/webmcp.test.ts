/// <reference types="bun-types" />

import { APIConnectionTimeoutError, APIError } from "@onkernel/sdk";
import type { PostHog } from "posthog-node";
import { describe, expect, test } from "bun:test";
import { instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";
import { registerWebMcpTool } from "@/lib/mcp/tools/webmcp";

const toolSnapshot = {
  tools: [
    {
      tool_ref: "opaque-top",
      name: "search",
      description: "Search",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      annotations: {
        read_only: true,
        untrusted_content: false,
        consequential: false,
        autosubmit: false,
      },
      source: {
        window_id: 1,
        tab_id: 2,
        page_title: "Search",
        page_url: "https://example.com/",
        frame: null,
      },
    },
    {
      tool_ref: "opaque-frame",
      name: "submit",
      description: "Submit",
      input_schema: { type: "object" },
      source: {
        window_id: 1,
        tab_id: 2,
        page_title: "Search",
        page_url: "https://example.com/",
        frame: { frame_id: 3, url: "https://frame.example/" },
      },
    },
  ],
};

describe("webmcp", () => {
  test("lists the browser-wide native tool snapshot without reshaping it", async () => {
    const calls: string[] = [];
    const { client, tokens, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          listTools: async (sessionId: string) => {
            calls.push(sessionId);
            return toolSnapshot;
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: { action: "list", session_id: "ses_1" },
      });

      expect(calls).toEqual(["ses_1"]);
      expect(tokens).toEqual(["test-token"]);
      expect(toolResultJSON(result)).toEqual(toolSnapshot);
    } finally {
      await close();
    }
  });

  test("invokes the exact tool reference synchronously with retries disabled", async () => {
    const calls: unknown[][] = [];
    const invocationResult = {
      invocation_id: "invoke-1",
      status: "completed" as const,
      output: { matches: 2 },
    };
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          invokeTool: async (...args: unknown[]) => {
            calls.push(args);
            return invocationResult;
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "invoke",
          session_id: "ses_1",
          tool_ref: "opaque-ref",
          input: { query: "kernel" },
          timeout_sec: 30,
        },
      });

      expect(calls).toEqual([
        [
          "ses_1",
          {
            tool_ref: "opaque-ref",
            input: { query: "kernel" },
            timeout_sec: 30,
          },
          { timeout: 60_000, maxRetries: 0 },
        ],
      ]);
      expect(toolResultJSON(result)).toEqual(invocationResult);
    } finally {
      await close();
    }
  });

  test("validates arguments before calling the SDK", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          listTools: async () => {
            calls += 1;
            return { tools: [] };
          },
          invokeTool: async () => {
            calls += 1;
          },
        },
      },
    });

    try {
      for (const arguments_ of [
        { action: "invoke", session_id: "ses_1", input: {} },
        {
          action: "invoke",
          session_id: "ses_1",
          tool_ref: "opaque-ref",
        },
        {
          action: "invoke",
          session_id: "ses_1",
          tool_ref: "opaque-ref",
          input: {},
          timeout_sec: 121,
        },
        { action: "other", session_id: "ses_1" },
        {
          action: "list",
          session_id: "ses_1",
          project_id: "proj_other",
        },
      ]) {
        const result = await client.callTool({
          name: "webmcp",
          arguments: arguments_,
        });
        expect(result.isError).toBe(true);
      }
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });

  test("accepts the analytics-injected context argument", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(
      (server, dependencies) => {
        instrumentMcpAnalytics(server, {
          capture: () => undefined,
        } as unknown as PostHog);
        registerWebMcpTool(server, dependencies);
      },
      {
        browsers: {
          webmcp: {
            listTools: async () => {
              calls += 1;
              return { tools: [] };
            },
          },
        },
      },
    );

    try {
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "webmcp",
      );
      expect(tool?.inputSchema.required).toContain("context");
      expect(tool?.inputSchema.properties).not.toHaveProperty("project_id");

      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "list",
          session_id: "ses_1",
          context: "Discovering available browser-native actions.",
        },
      });

      expect(result.isError).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("preserves outcome_unknown details and never retries", async () => {
    let calls = 0;
    let requestBody: unknown;
    let requestOptions: unknown;
    const failure = {
      code: "outcome_unknown",
      message: "do not retry automatically",
      invocation_id: "invoke-2",
    };
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          invokeTool: async (
            _sessionId: string,
            body: unknown,
            options: unknown,
          ) => {
            calls += 1;
            requestBody = body;
            requestOptions = options;
            throw new APIError(504, failure, undefined, new Headers());
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "invoke",
          session_id: "ses_1",
          tool_ref: "opaque-ref",
          input: {},
        },
      });

      expect(result.isError).toBe(true);
      expect(calls).toBe(1);
      expect(requestBody).toEqual({
        tool_ref: "opaque-ref",
        input: {},
        timeout_sec: 60,
      });
      expect(requestOptions).toEqual({ timeout: 90_000, maxRetries: 0 });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain(JSON.stringify(failure));
    } finally {
      await close();
    }
  });

  test("warns against retrying a transport failure", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          invokeTool: async () => {
            calls += 1;
            throw new APIConnectionTimeoutError();
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "invoke",
          session_id: "ses_1",
          tool_ref: "opaque-ref",
          input: {},
        },
      });

      expect(result.isError).toBe(true);
      expect(calls).toBe(1);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain(
        "The invocation may have started; do not retry automatically.",
      );
    } finally {
      await close();
    }
  });

  test("registers the public action schema", async () => {
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: { webmcp: {} },
    });

    try {
      const { tools } = await client.listTools();
      const tool = tools.find((candidate) => candidate.name === "webmcp");
      const schema = tool?.inputSchema as {
        required?: string[];
        properties?: Record<
          string,
          {
            description?: string;
            enum?: string[];
            minimum?: number;
            maximum?: number;
            default?: number;
          }
        >;
      };

      expect(tool?.description).toContain("untrusted page-provided data");
      expect(tool?.description).toContain("Never retry invoke automatically");
      expect(schema.properties).toHaveProperty("project");
      expect(schema.properties).not.toHaveProperty("project_id");
      expect(schema.properties?.action.enum).toEqual(["list", "invoke"]);
      expect(schema.properties?.session_id.description).toBe(
        "Browser session ID or name.",
      );
      expect(schema.required).toContain("action");
      expect(schema.required).toContain("session_id");
      expect(schema.required).not.toContain("tool_ref");
      expect(schema.properties?.timeout_sec.minimum).toBe(1);
      expect(schema.properties?.timeout_sec.maximum).toBe(120);
      expect(schema.properties?.timeout_sec.default).toBe(60);
    } finally {
      await close();
    }
  });
});

test("the Playwright tool advertises browser-wide WebMCP helpers and focused page reads", async () => {
  const { client, close } = await connectTestMcp(registerPlaywrightTool, {
    browsers: { playwright: {} },
  });

  try {
    const { tools } = await client.listTools();
    const tool = tools.find(
      (candidate) => candidate.name === "execute_playwright_code",
    );
    const code = tool?.inputSchema.properties?.code as
      | { description?: string }
      | undefined;

    expect(tool?.description).toContain("browser-wide WebMCP helpers");
    expect(code?.description).toBe(
      "Playwright/TypeScript code with `page`, `context`, `browser`, and browser-wide `webmcp` helpers in scope; the value you `return` is sent back as the tool result. After navigation or interaction, return a focused `ariaSnapshot()` of the relevant region for current page state, e.g. `await page.locator('main').ariaSnapshot()`. Every invocation should return useful page state. For targeted reads, return a compact value or object. Do not dump the full DOM or body text. A global webmcp object is available for discovering and using webmcp tools across all pages open in the browser: Use `await webmcp.listTools()` to discover structured page actions and `await webmcp.invokeTool(toolRef, input, { timeoutSec })` to invoke an exact registration. If the site you're interacting with exposes webmcp tools, then you should prefer those and use `await webmcp.listTools()` in return values alongside snapshots to get feedback on what your code has done.",
    );
    expect(tool?.description).toContain("manage_browsers");
  } finally {
    await close();
  }
});
