import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  jsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";

type BrowserCurlParams = Parameters<KernelClient["browsers"]["curl"]>[1];

function validateCurlUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https.");
  }
}

export function registerBrowserUtilityTools(server: McpServer) {
  server.tool(
    "browser_curl",
    "Send an HTTP request through an existing Kernel browser session's Chrome network stack.",
    {
      session_id: z.string().describe("Browser session ID."),
      url: z.string().url().describe("Target http or https URL."),
      method: z
        .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        .describe("HTTP method. Defaults to GET.")
        .optional(),
      headers: z
        .record(z.string(), z.string())
        .describe("Custom headers merged with browser defaults.")
        .optional(),
      body: z
        .string()
        .describe("Request body for POST, PUT, or PATCH requests.")
        .optional(),
      response_encoding: z
        .enum(["utf8", "base64"])
        .describe("Response body encoding. Use base64 for binary content.")
        .optional(),
      timeout_ms: z
        .number()
        .describe("Request timeout in milliseconds.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const { session_id, ...curlParams } = params satisfies {
          session_id: string;
        } & BrowserCurlParams;
        validateCurlUrl(curlParams.url);

        const response = await client.browsers.curl(session_id, curlParams);
        return jsonResponse(response);
      } catch (error) {
        return toolErrorResponse("browser_curl", "request", error);
      }
    },
  );

  server.tool(
    "read_browser_clipboard",
    "Read clipboard text from an existing Kernel browser session.",
    {
      session_id: z.string().describe("Browser session ID."),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const response = await client.browsers.computer.readClipboard(
          params.session_id,
        );
        return jsonResponse(response);
      } catch (error) {
        return toolErrorResponse("read_browser_clipboard", "read", error);
      }
    },
  );

  server.tool(
    "write_browser_clipboard",
    "Write clipboard text to an existing Kernel browser session.",
    {
      session_id: z.string().describe("Browser session ID."),
      text: z.string().describe("Text to write to the browser clipboard."),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        await client.browsers.computer.writeClipboard(params.session_id, {
          text: params.text,
        });
        return textResponse("Clipboard updated successfully");
      } catch (error) {
        return toolErrorResponse("write_browser_clipboard", "write", error);
      }
    },
  );
}
