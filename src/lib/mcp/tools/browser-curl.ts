import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

type BrowserCurlParams = Parameters<KernelClient["browsers"]["curl"]>[1];

function curlUrlError(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "error: url must be a valid url.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "error: url must use http or https.";
  }
  return undefined;
}

export function registerBrowserCurlTool(server: McpServer) {
  server.registerTool(
    "browser_curl",
    {
      description:
        "send an http request through an existing KERNEL browser session's chrome network stack. use when the request needs that browser session's cookies, proxy, network context, or origin behavior; do not use for general documentation lookup or web search.",
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        session_id: z.string().describe("browser session id or name."),
        url: z.string().url().describe("target http or https url."),
        method: z
          .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
          .describe('http method. defaults to "GET".')
          .optional(),
        headers: z
          .record(z.string(), z.string())
          .describe("custom headers merged with browser defaults.")
          .optional(),
        body: z
          .string()
          .describe('request body for "POST", "PUT", or "PATCH" requests.')
          .optional(),
        response_encoding: z
          .enum(["utf8", "base64"])
          .describe("response body encoding. use base64 for binary content.")
          .optional(),
        timeout_ms: z
          .number()
          .int()
          .min(1)
          .describe("request timeout in milliseconds.")
          .optional(),
      }),
      annotations: {
        title: "send http request via browser",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        const {
          session_id,
          project: _project,
          project_id: _projectID,
          ...curlParams
        } = params satisfies {
          session_id: string;
        } & BrowserCurlParams;
        const urlError = curlUrlError(curlParams.url);
        if (urlError) return errorResponse(urlError);

        const response = await client.browsers.curl(session_id, curlParams);
        return jsonResponse(response);
      } catch (error) {
        throwToolError("browser_curl", "request", error);
      }
    },
  );
}
