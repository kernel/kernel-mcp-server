/// <reference types="bun-types" />

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APIConnectionTimeoutError } from "@onkernel/sdk";
import { afterEach, expect, mock, test } from "bun:test";

import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";
import { registerShellTool } from "@/lib/mcp/tools/shell";

// Registered here rather than shared, because two other test files mock this same module
// and the freshest registration wins for whichever file is running.
let client: unknown;
mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: () => client,
}));

type Handler = (params: any, extra: any) => Promise<any>;

function capture(register: (server: McpServer) => void) {
  let handler: Handler | undefined;
  let schema: Record<string, any> | undefined;
  const server = {
    tool(
      _name: string,
      _description: string,
      inputSchema: Record<string, any>,
      ...rest: any[]
    ) {
      schema = inputSchema;
      handler = rest[rest.length - 1];
    },
  } as unknown as McpServer;
  register(server);
  return { handler: handler!, schema: schema! };
}

const extra = { authInfo: { token: "sk-test" } };

afterEach(() => {
  client = undefined;
});

test("execute_playwright_code outlasts the script budget and is never replayed", async () => {
  let options: any;
  client = {
    browsers: {
      playwright: {
        execute: async (_id: string, _body: unknown, opts: unknown) => {
          options = opts;
          return { success: true, result: "ok" };
        },
      },
    },
  };

  const { handler } = capture(registerPlaywrightTool);
  await handler({ code: "return 1", session_id: "ses_1" }, extra);

  expect(options.maxRetries).toBe(0);
  expect(options.timeout).toBeGreaterThan(60_000);
});

test("a playwright transport timeout is classified rather than generic", async () => {
  client = {
    browsers: {
      playwright: {
        execute: async () => {
          throw new APIConnectionTimeoutError();
        },
      },
    },
  };

  const { handler } = capture(registerPlaywrightTool);
  const error = await handler(
    { code: "return 1", session_id: "ses_1" },
    extra,
  ).catch((err: Error) => err);

  expect(error.name).toBe("KernelApiTimeout");
  expect(error.message).toStartWith(
    "Error in execute_playwright_code (execute):",
  );
});

test("exec_command waits out the command it asked for and is never replayed", async () => {
  let body: any;
  let options: any;
  client = {
    browsers: {
      process: {
        exec: async (_id: string, params: unknown, opts: unknown) => {
          body = params;
          options = opts;
          return { exit_code: 0, duration_ms: 1 };
        },
      },
    },
  };

  const { handler } = capture(registerShellTool);
  await handler(
    { session_id: "ses_1", command: "sleep", args: ["120"], timeout_sec: 120 },
    extra,
  );

  expect(body.timeout_sec).toBe(120);
  expect(options.maxRetries).toBe(0);
  expect(options.timeout).toBeGreaterThan(120_000);
});

test("exec_command sends a timeout the transport can honour", () => {
  const { schema } = capture(registerShellTool);

  expect(schema.timeout_sec.parse(undefined)).toBe(60);
  expect(schema.timeout_sec.safeParse(600).success).toBe(false);
});
