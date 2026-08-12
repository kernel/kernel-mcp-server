/// <reference types="bun-types" />

import { APIConnectionTimeoutError } from "@onkernel/sdk";
import { expect, test } from "bun:test";

import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";
import { registerShellTool } from "@/lib/mcp/tools/shell";

const TRANSPORT_HEADROOM_MS = 30_000;

type Call = { body: any; options: any };

function playwrightClient(calls: Call[], result: () => unknown) {
  return {
    browsers: {
      playwright: {
        execute: async (_id: string, body: unknown, options: unknown) => {
          calls.push({ body, options });
          return result();
        },
      },
    },
  };
}

function shellClient(calls: Call[]) {
  return {
    browsers: {
      process: {
        exec: async (_id: string, body: unknown, options: unknown) => {
          calls.push({ body, options });
          return { exit_code: 0, duration_ms: 1 };
        },
      },
    },
  };
}

test("execute_playwright_code sends the budget it waits for, and is never replayed", async () => {
  const calls: Call[] = [];
  const { client, close } = await connectTestMcp(
    registerPlaywrightTool,
    playwrightClient(calls, () => ({ success: true, result: "ok" })),
  );

  try {
    await client.callTool({
      name: "execute_playwright_code",
      arguments: { code: "return 1", session_id: "ses_1" },
    });
  } finally {
    await close();
  }

  expect(calls).toHaveLength(1);
  expect(calls[0].body.timeout_sec).toBe(60);
  expect(calls[0].options.maxRetries).toBe(0);
  expect(calls[0].options.timeout).toBe(60_000 + TRANSPORT_HEADROOM_MS);
});

// The classified name itself (KernelApiTimeout) rides on the thrown error for analytics and
// is asserted in responses.test.ts. What matters here is that playwright's catch reaches that
// shared classifier at all: before this change it returned its own hand-built content block.
test("a playwright transport failure is reported through the shared tool-error path", async () => {
  const { client, close } = await connectTestMcp(registerPlaywrightTool, {
    browsers: {
      playwright: {
        execute: async () => {
          throw new APIConnectionTimeoutError();
        },
      },
    },
  });

  try {
    const result = await client.callTool({
      name: "execute_playwright_code",
      arguments: { code: "return 1", session_id: "ses_1" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toStartWith("Error in execute_playwright_code (execute):");
  } finally {
    await close();
  }
});

test("exec_command waits out the deadline it was given and is never replayed", async () => {
  const calls: Call[] = [];
  const { client, close } = await connectTestMcp(
    registerShellTool,
    shellClient(calls),
  );

  try {
    await client.callTool({
      name: "exec_command",
      arguments: {
        session_id: "ses_1",
        command: "sleep",
        args: ["120"],
        timeout_sec: 120,
      },
    });
  } finally {
    await close();
  }

  expect(calls[0].body.timeout_sec).toBe(120);
  expect(calls[0].options.maxRetries).toBe(0);
  expect(calls[0].options.timeout).toBe(120_000 + TRANSPORT_HEADROOM_MS);
});

test("an exec_command with no deadline still sends one the transport outlasts", async () => {
  const calls: Call[] = [];
  const { client, close } = await connectTestMcp(
    registerShellTool,
    shellClient(calls),
  );

  try {
    await client.callTool({
      name: "exec_command",
      arguments: { session_id: "ses_1", command: "ls" },
    });
  } finally {
    await close();
  }

  expect(calls[0].body.timeout_sec).toBe(60);
  expect(calls[0].options.timeout).toBe(60_000 + TRANSPORT_HEADROOM_MS);
});

test("exec_command accepts the longest deadline one request can wait out, and no more", async () => {
  const calls: Call[] = [];
  const { client, close } = await connectTestMcp(
    registerShellTool,
    shellClient(calls),
  );

  try {
    await client.callTool({
      name: "exec_command",
      arguments: { session_id: "ses_1", command: "sleep", timeout_sec: 150 },
    });
    expect(calls[0].body.timeout_sec).toBe(150);

    const rejected = await client.callTool({
      name: "exec_command",
      arguments: { session_id: "ses_1", command: "sleep", timeout_sec: 151 },
    });

    expect(rejected.isError).toBe(true);
    expect(calls).toHaveLength(1);
  } finally {
    await close();
  }
});

test("the shell tool advertises the deadline bounds it enforces", async () => {
  const { client, close } = await connectTestMcp(
    registerShellTool,
    shellClient([]),
  );

  try {
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "exec_command")
      ?.inputSchema as {
      properties: Record<string, { default?: number; maximum?: number }>;
    };

    expect(schema.properties.timeout_sec.default).toBe(60);
    expect(schema.properties.timeout_sec.maximum).toBe(150);
  } finally {
    await close();
  }
});

test("a failed playwright execution does not report itself as a success", async () => {
  const { client, close } = await connectTestMcp(
    registerPlaywrightTool,
    playwrightClient([], () => ({
      success: false,
      error: "page.click: target closed",
    })),
  );

  try {
    const result = await client.callTool({
      name: "execute_playwright_code",
      arguments: { code: "await page.click('#gone')", session_id: "ses_1" },
    });

    expect(toolResultJSON(result).success).toBe(false);
  } finally {
    await close();
  }
});
