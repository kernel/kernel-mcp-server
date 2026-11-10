/// <reference types="bun-types" />

import { APIError } from "@onkernel/sdk";
import { describe, expect, test } from "bun:test";

import {
  connectTestMcp,
  toolResultJSON,
  toolResultText,
} from "@/lib/mcp/mcp-test-fixtures";
import { registerPlaywrightTool } from "@/lib/mcp/tools/playwright";

type ExecuteCall = { sessionId: string; body: Record<string, unknown> };
type DeleteCall = { name: string; params: Record<string, unknown> };

const executors = [
  {
    name: "default",
    busy: false,
    created_at: "2026-01-01T00:00:00Z",
    last_used_at: "2026-01-01T00:01:00Z",
  },
  {
    name: "checkout",
    busy: true,
    created_at: "2026-01-01T00:02:00Z",
    last_used_at: "2026-01-01T00:03:00Z",
    target_id: "A1B2",
    url: "https://example.com/cart",
  },
];

function playwrightClient({
  executeCalls = [],
  deleteCalls = [],
  listCalls = [],
  execute = async () => ({ success: true, result: "ok" }),
}: {
  executeCalls?: ExecuteCall[];
  deleteCalls?: DeleteCall[];
  listCalls?: string[];
  execute?: () => Promise<unknown>;
} = {}) {
  return {
    browsers: {
      playwright: {
        execute: async (sessionId: string, body: Record<string, unknown>) => {
          executeCalls.push({ sessionId, body });
          return execute();
        },
        executors: {
          list: async (sessionId: string) => {
            listCalls.push(sessionId);
            return { executors };
          },
          delete: async (name: string, params: Record<string, unknown>) => {
            deleteCalls.push({ name, params });
          },
        },
      },
    },
  };
}

describe("execute_playwright_code executors", () => {
  test("omits executor from the request when the agent did not name one", async () => {
    const executeCalls: ExecuteCall[] = [];
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({ executeCalls }),
    );

    try {
      await client.callTool({
        name: "execute_playwright_code",
        arguments: { code: "return 1", session_id: "ses_1" },
      });
    } finally {
      await close();
    }

    expect(executeCalls).toHaveLength(1);
    expect("executor" in executeCalls[0].body).toBe(false);
  });

  test("passes a named executor through to the API", async () => {
    const executeCalls: ExecuteCall[] = [];
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({ executeCalls }),
    );

    try {
      await client.callTool({
        name: "execute_playwright_code",
        arguments: {
          code: "return 1",
          session_id: "ses_1",
          executor: "checkout-1",
        },
      });
    } finally {
      await close();
    }

    expect(executeCalls[0].body).toMatchObject({
      code: "return 1",
      executor: "checkout-1",
    });
  });

  test.each(["", "has space", "a".repeat(65), "tab/1"])(
    "rejects the invalid executor name %j before calling the API",
    async (executor) => {
      const executeCalls: ExecuteCall[] = [];
      const { client, close } = await connectTestMcp(
        registerPlaywrightTool,
        playwrightClient({ executeCalls }),
      );

      try {
        const result = await client.callTool({
          name: "execute_playwright_code",
          arguments: { code: "return 1", session_id: "ses_1", executor },
        });
        expect(result.isError).toBe(true);
      } finally {
        await close();
      }

      expect(executeCalls).toHaveLength(0);
    },
  );

  test("reports the tab page was bound to when the API returns one", async () => {
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({
        execute: async () => ({
          success: true,
          result: "Example Domain",
          tab: { target_id: "A1B2", created: true },
        }),
      }),
    );

    try {
      const result = await client.callTool({
        name: "execute_playwright_code",
        arguments: {
          code: "return await page.title()",
          session_id: "ses_1",
          executor: "search",
        },
      });

      expect(toolResultJSON(result)).toEqual({
        success: true,
        result: "Example Domain",
        tab: { target_id: "A1B2", created: true },
      });
    } finally {
      await close();
    }
  });

  test("leaves tab out of the result when the API did not bind one", async () => {
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({
        execute: async () => ({ success: false, error: "boom" }),
      }),
    );

    try {
      const result = await client.callTool({
        name: "execute_playwright_code",
        arguments: { code: "throw new Error('boom')", session_id: "ses_1" },
      });

      expect("tab" in toolResultJSON(result)).toBe(false);
    } finally {
      await close();
    }
  });

  test("surfaces the current executors when the browser is at its named executor limit", async () => {
    const limit = {
      message: "browser already has 8 named executors",
      executors,
    };
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({
        execute: async () => {
          throw new APIError(409, limit, undefined, new Headers());
        },
      }),
    );

    try {
      const result = await client.callTool({
        name: "execute_playwright_code",
        arguments: { code: "return 1", session_id: "ses_1", executor: "ninth" },
      });

      expect(result.isError).toBe(true);
      const text = toolResultText(result);
      expect(text).toStartWith("error in execute_playwright_code (execute):");
      expect(text).toContain(JSON.stringify(limit));
    } finally {
      await close();
    }
  });

  test("does not treat a 409 on an unnamed call as the executor limit", async () => {
    const conflict = { code: "conflict", message: "browser is busy" };
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({
        execute: async () => {
          throw new APIError(409, conflict, undefined, new Headers());
        },
      }),
    );

    try {
      const result = await client.callTool({
        name: "execute_playwright_code",
        arguments: { code: "return 1", session_id: "ses_1" },
      });

      expect(result.isError).toBe(true);
      const text = toolResultText(result);
      expect(text).toStartWith("error in execute_playwright_code (execute):");
      expect(text).not.toContain(JSON.stringify(conflict));
    } finally {
      await close();
    }
  });
});

describe("manage_playwright_executors", () => {
  test("lists the executors of a session", async () => {
    const listCalls: string[] = [];
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({ listCalls }),
    );

    try {
      const result = await client.callTool({
        name: "manage_playwright_executors",
        arguments: { action: "list", session_id: "browser-name" },
      });

      expect(result.isError).toBeFalsy();
      expect(toolResultJSON(result).items).toEqual(executors);
    } finally {
      await close();
    }

    expect(listCalls).toEqual(["browser-name"]);
  });

  test("deletes a named executor and closes its tab by default", async () => {
    const deleteCalls: DeleteCall[] = [];
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({ deleteCalls }),
    );

    try {
      const result = await client.callTool({
        name: "manage_playwright_executors",
        arguments: { action: "delete", session_id: "ses_1", name: "checkout" },
      });

      expect(result.isError).toBeFalsy();
      expect(toolResultText(result)).toBe("executor checkout deleted");
    } finally {
      await close();
    }

    expect(deleteCalls).toEqual([
      { name: "checkout", params: { id_or_name: "ses_1" } },
    ]);
  });

  test("can keep the tab open when deleting", async () => {
    const deleteCalls: DeleteCall[] = [];
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({ deleteCalls }),
    );

    try {
      await client.callTool({
        name: "manage_playwright_executors",
        arguments: {
          action: "delete",
          session_id: "ses_1",
          name: "checkout",
          close_tab: false,
        },
      });
    } finally {
      await close();
    }

    expect(deleteCalls[0].params).toEqual({
      id_or_name: "ses_1",
      close_tab: false,
    });
  });

  test("describes deleting default as a restart", async () => {
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient(),
    );

    try {
      const result = await client.callTool({
        name: "manage_playwright_executors",
        arguments: { action: "delete", session_id: "ses_1", name: "default" },
      });

      expect(toolResultText(result)).toBe("default executor restarted");
    } finally {
      await close();
    }
  });

  test("requires a name to delete", async () => {
    const deleteCalls: DeleteCall[] = [];
    const { client, close } = await connectTestMcp(
      registerPlaywrightTool,
      playwrightClient({ deleteCalls }),
    );

    try {
      const result = await client.callTool({
        name: "manage_playwright_executors",
        arguments: { action: "delete", session_id: "ses_1" },
      });

      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toBe(
        "error: name is required for delete.",
      );
    } finally {
      await close();
    }

    expect(deleteCalls).toHaveLength(0);
  });

  test("reports an unknown executor through the shared tool-error path", async () => {
    const { client, close } = await connectTestMcp(registerPlaywrightTool, {
      browsers: {
        playwright: {
          executors: {
            delete: async () => {
              throw new APIError(
                404,
                { code: "not_found", message: "executor not found" },
                undefined,
                new Headers(),
              );
            },
          },
        },
      },
    });

    try {
      const result = await client.callTool({
        name: "manage_playwright_executors",
        arguments: { action: "delete", session_id: "ses_1", name: "gone" },
      });

      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toStartWith(
        "error in manage_playwright_executors (delete):",
      );
    } finally {
      await close();
    }
  });
});
