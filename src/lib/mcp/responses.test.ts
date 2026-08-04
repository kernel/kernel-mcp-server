/// <reference types="bun-types" />

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@onkernel/sdk";
import { describe, expect, test } from "bun:test";

import { errorResponse, throwToolError } from "@/lib/mcp/responses";

function apiError(status: number, message: string) {
  return APIError.generate(status, undefined, message, new Headers());
}

function caught(error: unknown) {
  try {
    throwToolError("manage_browsers", "get", error);
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("throwToolError did not throw");
}

describe("throwToolError classification", () => {
  test("names Kernel API failures after their status", () => {
    expect(caught(apiError(404, "not found")).name).toBe("KernelApiError404");
    expect(caught(apiError(429, "too many requests")).name).toBe(
      "KernelApiError429",
    );
    expect(caught(apiError(502, "bad gateway")).name).toBe("KernelApiError502");
  });

  test("names transport failures without relying on class names", () => {
    // The SDK's error classes are minified in the production bundle, so
    // constructor.name reads as a mangled identifier there. These come from
    // instanceof checks instead.
    expect(caught(new APIConnectionTimeoutError({})).name).toBe(
      "KernelApiTimeout",
    );
    expect(
      caught(new APIConnectionError({ message: "socket hang up" })).name,
    ).toBe("KernelApiConnectionError");
    expect(caught(new APIUserAbortError({})).name).toBe("KernelApiAborted");
  });

  test("falls back to a generic name for everything else", () => {
    expect(caught(new Error("boom")).name).toBe("Error");
    expect(caught(new TypeError("bad arg")).name).toBe("TypeError");
    expect(caught("plain string").name).toBe("Error");
  });

  test("keeps the message the tool already produced", () => {
    expect(caught(apiError(404, "not found")).message).toBe(
      "Error in manage_browsers (get): 404 not found",
    );
    expect(caught("plain string").message).toBe(
      "Error in manage_browsers (get): plain string",
    );
  });
});

describe("what the client receives", () => {
  async function callTool(name: string) {
    const server = new McpServer({ name: "test", version: "0.0.0" });

    server.tool("api_failure", {}, async () => {
      throwToolError(
        "manage_browsers",
        "get",
        apiError(404, "browser session not found"),
      );
    });

    server.tool("input_guard", {}, async () =>
      errorResponse("Error: session_id is required for get action."),
    );

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({ name, arguments: {} });
    await client.close();
    return result;
  }

  test("a thrown API failure still arrives as an isError text result", async () => {
    const result = await callTool("api_failure");

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Error in manage_browsers (get): 404 browser session not found",
      },
    ]);
  });

  test("input guards are unchanged", async () => {
    const result = await callTool("input_guard");

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Error: session_id is required for get action." },
    ]);
  });
});
