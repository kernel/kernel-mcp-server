import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";

type BrowserCurlParams = Parameters<KernelClient["browsers"]["curl"]>[1];

function curlUrlError(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Error: url must be a valid URL.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: url must use http or https.";
  }
  return undefined;
}

export function registerBrowserCurlTool(server: McpServer) {
  server.tool(
    "browser_curl",
    "Send an HTTP request through an existing Kernel browser session's Chrome network stack. Use when the request needs that browser session's cookies, proxy, network context, or origin behavior; do not use for general documentation lookup or web search.",
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
        .int()
        .min(1)
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
        const urlError = curlUrlError(curlParams.url);
        if (urlError) return errorResponse(urlError);

        const response = await client.browsers.curl(session_id, curlParams);
        return jsonResponse(response);
      } catch (error) {
        return toolErrorResponse("browser_curl", "request", error);
      }
    },
  );
}
