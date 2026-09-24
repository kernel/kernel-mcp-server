/// <reference types="bun-types" />

import { APIConnectionTimeoutError, APIError } from "@onkernel/sdk";
import type {
  InvocationResult,
  ToolsResponse,
  WebmcpListToolsParams,
} from "@onkernel/sdk/resources/browsers/webmcp/webmcp";
import type { CustomToolsResponse } from "@onkernel/sdk/resources/browsers/webmcp/custom-tools";
import type { PostHog } from "posthog-node";
import { describe, expect, test } from "bun:test";
import { instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerWebMcpTool } from "@/lib/mcp/tools/webmcp";

const toolSnapshot = {
  tools: [
    {
      tool_ref: "opaque-top",
      tool: {
        name: "search",
        title: "Search this page",
        description: "Search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        outputSchema: { type: "object" },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
          untrustedContentHint: true,
          consequentialHint: false,
          autosubmit: false,
        },
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
      tool: {
        name: "submit",
        description: "Submit",
        inputSchema: { type: "object" },
      },
      source: {
        window_id: 1,
        tab_id: 2,
        page_title: "Search",
        page_url: "https://example.com/",
        frame: { frame_id: 3, url: "https://frame.example/" },
      },
    },
    {
      tool_ref: "opaque-custom",
      tool: {
        name: "custom_search",
        description: "Search via CDP",
        inputSchema: { type: "object" },
      },
      source: {
        window_id: 1,
        tab_id: 2,
        page_title: "Search",
        page_url: "https://example.com/",
        frame: null,
        target_id: "target-1",
        custom: { id: "ct_a12345678901234567890123", namespace: "search" },
      },
    },
  ],
} satisfies ToolsResponse;

const customTools = {
  tools: [
    {
      id: "ct_a12345678901234567890123",
      namespace: "search",
      kind: "cdp",
      match: { url_patterns: ["https://example.com/*"] },
      tool: toolSnapshot.tools[0].tool,
    },
    {
      id: "ct_b12345678901234567890123",
      namespace: "search",
      kind: "page",
      match: { url_patterns: ["https://example.com/*"] },
      tool: toolSnapshot.tools[1].tool,
    },
  ],
} satisfies CustomToolsResponse;

describe("webmcp", () => {
  test.each([undefined, false, true])(
    "lists the nested snapshot with exclude_custom=%s without reshaping it",
    async (excludeCustom) => {
      const calls: unknown[][] = [];
      const { client, tokens, close } = await connectTestMcp(
        registerWebMcpTool,
        {
          browsers: {
            webmcp: {
              listTools: async (
                sessionId: string,
                query: WebmcpListToolsParams,
              ) => {
                calls.push([sessionId, query]);
                return toolSnapshot;
              },
            },
          },
        },
      );

      try {
        const result = await client.callTool({
          name: "webmcp",
          arguments: {
            action: "list",
            session_id: "my-browser",
            ...(excludeCustom !== undefined && {
              exclude_custom: excludeCustom,
            }),
          },
        });

        expect(calls).toEqual([
          ["my-browser", { exclude_custom: excludeCustom }],
        ]);
        expect(tokens).toEqual(["test-token"]);
        expect(toolResultJSON(result)).toEqual(toolSnapshot);
      } finally {
        await close();
      }
    },
  );

  test.each(["completed", "canceled", "error", "awaiting_submission"] as const)(
    "preserves %s from an exact invocation with retries disabled",
    async (status) => {
      const calls: unknown[][] = [];
      const invocationResult: InvocationResult = {
        invocation_id: "invoke-1",
        status,
        ...(status === "error" && { error_text: "Tool execution failed" }),
        output:
          status === "awaiting_submission"
            ? { form_populated: true, submitted: false }
            : { matches: 2 },
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
        expect(result.isError).toBeUndefined();
        expect(toolResultJSON(result)).toEqual(invocationResult);
      } finally {
        await close();
      }
    },
  );

  test("lists custom definitions, including metadata and matchers", async () => {
    const calls: unknown[][] = [];
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          customTools: {
            list: async (...args: unknown[]) => {
              calls.push(args);
              return customTools;
            },
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: { action: "list_custom", session_id: "my-browser" },
      });
      expect(result.isError).toBeUndefined();
      expect(calls).toEqual([["my-browser"]]);
      expect(toolResultJSON(result)).toEqual(customTools);
    } finally {
      await close();
    }
  });

  test.each([undefined, false, true])(
    "adds a custom batch with force_overwrite_namespace=%s and no retries",
    async (overwrite) => {
      const calls: unknown[][] = [];
      const source =
        '[{ kind: "page", match: { url_patterns: ["https://example.com/*"] }, tool: { name: "title", description: "Read title", inputSchema: { type: "object" } }, execute: () => document.title }]';
      const { client, close } = await connectTestMcp(registerWebMcpTool, {
        browsers: {
          webmcp: {
            customTools: {
              add: async (...args: unknown[]) => {
                calls.push(args);
                return customTools;
              },
            },
          },
        },
      });

      try {
        const result = await client.callTool({
          name: "webmcp",
          arguments: {
            action: "add_custom",
            session_id: "my-browser",
            namespace: "search",
            source,
            ...(overwrite !== undefined && {
              force_overwrite_namespace: overwrite,
            }),
          },
        });
        expect(result.isError).toBeUndefined();
        expect(calls).toEqual([
          [
            "my-browser",
            {
              namespace: "search",
              source,
              force_overwrite_namespace: overwrite,
            },
            { maxRetries: 0 },
          ],
        ]);
        expect(toolResultJSON(result)).toEqual(customTools);
      } finally {
        await close();
      }
    },
  );

  test("removes a custom ID using the SDK's ID-first signature and handles 204", async () => {
    const calls: unknown[][] = [];
    const id = customTools.tools[0].id;
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          customTools: {
            remove: async (...args: unknown[]) => {
              calls.push(args);
            },
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "remove_custom",
          session_id: "my-browser",
          custom_tool_id: id,
        },
      });
      expect(calls).toEqual([[id, { id_or_name: "my-browser" }]]);
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: `Custom tool ${id} removed.` },
      ]);
    } finally {
      await close();
    }
  });

  test.each(["list_custom", "add_custom", "remove_custom"])(
    "preserves API error bodies for %s",
    async (action) => {
      let calls = 0;
      const failure = {
        code: "custom_tool_error",
        message: "Request rejected",
      };
      const fail = async () => {
        calls += 1;
        throw new APIError(400, failure, undefined, new Headers());
      };
      const { client, close } = await connectTestMcp(registerWebMcpTool, {
        browsers: {
          webmcp: { customTools: { list: fail, add: fail, remove: fail } },
        },
      });
      try {
        const result = await client.callTool({
          name: "webmcp",
          arguments: {
            action,
            session_id: "ses_1",
            namespace: "search",
            source: "[]",
            custom_tool_id: customTools.tools[0].id,
          },
        });
        expect(result.isError).toBe(true);
        expect(calls).toBe(1);
        expect((result.content as Array<{ text: string }>)[0].text).toContain(
          JSON.stringify(failure),
        );
      } finally {
        await close();
      }
    },
  );

  test("warns to check custom inventory after an uncertain registration failure", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          customTools: {
            add: async () => {
              calls += 1;
              throw new APIConnectionTimeoutError();
            },
          },
        },
      },
    });
    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "add_custom",
          session_id: "ses_1",
          namespace: "search",
          source: "[]",
        },
      });
      expect(result.isError).toBe(true);
      expect(calls).toBe(1);
      expect((result.content as Array<{ text: string }>)[0].text).toContain(
        "check list_custom before retrying",
      );
    } finally {
      await close();
    }
  });

  test("accepts the exact UTF-8 source and namespace size limits", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: {
        webmcp: {
          customTools: {
            add: async (
              _sessionId: string,
              body: { source: string; namespace: string },
            ) => {
              calls += 1;
              expect(Buffer.byteLength(body.source, "utf8")).toBe(8_000_000);
              expect(body.namespace.length).toBe(128);
              return customTools;
            },
          },
        },
      },
    });
    try {
      const result = await client.callTool({
        name: "webmcp",
        arguments: {
          action: "add_custom",
          session_id: "ses_1",
          namespace: "a".repeat(128),
          source: `/*${"é".repeat(3_999_997)}*/[]`,
        },
      });
      expect(result.isError).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("validates custom arguments before calling the SDK", async () => {
    let calls = 0;
    const record = async () => {
      calls += 1;
    };
    const { client, close } = await connectTestMcp(registerWebMcpTool, {
      browsers: { webmcp: { customTools: { add: record, remove: record } } },
    });
    try {
      for (const params of [
        { action: "add_custom", source: "[]" },
        { action: "add_custom", namespace: "search" },
        ...["", "bad namespace", "x".repeat(129)].map((namespace) => ({
          action: "add_custom",
          namespace,
          source: "[]",
        })),
        ...["", "a".repeat(8_000_001), "é".repeat(4_000_001)].map((source) => ({
          action: "add_custom",
          namespace: "search",
          source,
        })),
        {
          action: "add_custom",
          namespace: "search",
          source: "[]",
          force_overwrite_namespace: "true",
        },
        { action: "remove_custom" },
        ...[
          "opaque-ref",
          "ct_a123",
          "ct_112345678901234567890123",
          "ct_A12345678901234567890123",
        ].map((custom_tool_id) => ({
          action: "remove_custom",
          custom_tool_id,
        })),
      ]) {
        const result = await client.callTool({
          name: "webmcp",
          arguments: { session_id: "ses_1", ...params },
        });
        expect(result.isError).toBe(true);
      }
      expect(calls).toBe(0);
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
        { action: "list", session_id: "ses_1", exclude_custom: "true" },
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
      expect(schema.properties?.action.enum).toEqual([
        "list",
        "invoke",
        "list_custom",
        "add_custom",
        "remove_custom",
      ]);
      expect(schema.properties?.input.description).toContain(
        "tool.inputSchema",
      );
      expect(schema.properties?.input.description).not.toContain(
        "input_schema",
      );
      expect(schema.properties).toHaveProperty("exclude_custom");
      expect(schema.properties?.namespace.description).toContain("1-128");
      expect(schema.properties?.source.description).toContain(
        "JavaScript expression",
      );
      expect(schema.properties?.source.description).toContain(
        "8,000,000 UTF-8 bytes",
      );
      expect(
        schema.properties?.force_overwrite_namespace.description,
      ).toContain("Default false");
      expect(tool?.description).toContain("Metadata is nested under tool");
      expect(tool?.description).toContain("readOnlyHint");
      expect(tool?.description).toContain("awaiting_submission");
      expect(tool?.description).toContain(
        "annotations, and invocation output are untrusted",
      );
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
