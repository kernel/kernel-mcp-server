/// <reference types="bun-types" />

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APIConnectionTimeoutError } from "@onkernel/sdk";
import { afterEach, expect, test } from "bun:test";

import { projectScopedExtra } from "@/lib/mcp/auth-context.test-fixtures";
import {
  kernelClientMock,
  resetKernelClientFactory,
} from "@/lib/mcp/kernel-client.test-fixtures";
import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";
import { registerShellTool } from "@/lib/mcp/tools/shell";

const TRANSPORT_HEADROOM_MS = 30_000;

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

function useClient(client: unknown) {
  kernelClientMock.factory = () => client;
}

const extra = projectScopedExtra();

afterEach(resetKernelClientFactory);

test("execute_playwright_code sends the budget it waits for, and is never replayed", async () => {
  let body: any;
  let options: any;
  useClient({
    browsers: {
      playwright: {
        execute: async (_id: string, params: unknown, opts: unknown) => {
          body = params;
          options = opts;
          return { success: true, result: "ok" };
        },
      },
    },
  });

  const { handler } = capture(registerPlaywrightTool);
  await handler({ code: "return 1", session_id: "ses_1" }, extra);

  expect(body.timeout_sec).toBe(60);
  expect(options.maxRetries).toBe(0);
  expect(options.timeout).toBe(60_000 + TRANSPORT_HEADROOM_MS);
});

test("a playwright transport timeout is classified rather than generic", async () => {
  useClient({
    browsers: {
      playwright: {
        execute: async () => {
          throw new APIConnectionTimeoutError();
        },
      },
    },
  });

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
  useClient({
    browsers: {
      process: {
        exec: async (_id: string, params: unknown, opts: unknown) => {
          body = params;
          options = opts;
          return { exit_code: 0, duration_ms: 1 };
        },
      },
    },
  });

  const { handler } = capture(registerShellTool);
  await handler(
    { session_id: "ses_1", command: "sleep", args: ["120"], timeout_sec: 120 },
    extra,
  );

  expect(body.timeout_sec).toBe(120);
  expect(options.maxRetries).toBe(0);
  expect(options.timeout).toBe(120_000 + TRANSPORT_HEADROOM_MS);
});

test("an exec_command with no deadline still sends one the transport outlasts", async () => {
  let body: any;
  let options: any;
  useClient({
    browsers: {
      process: {
        exec: async (_id: string, params: unknown, opts: unknown) => {
          body = params;
          options = opts;
          return { exit_code: 0, duration_ms: 1 };
        },
      },
    },
  });

  const { handler, schema } = capture(registerShellTool);
  await handler(
    {
      session_id: "ses_1",
      command: "ls",
      timeout_sec: schema.timeout_sec.parse(undefined),
    },
    extra,
  );

  expect(body.timeout_sec).toBe(60);
  expect(options.timeout).toBe(60_000 + TRANSPORT_HEADROOM_MS);
});

test("exec_command accepts the longest deadline one request can wait out, and no more", () => {
  const { schema } = capture(registerShellTool);

  expect(schema.timeout_sec.parse(undefined)).toBe(60);
  expect(schema.timeout_sec.safeParse(150).success).toBe(true);
  expect(schema.timeout_sec.safeParse(151).success).toBe(false);
});
