import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";

type BrowserCurlParams = Parameters<KernelClient["browsers"]["curl"]>[1];

type BrowserUtilityAction = "curl" | "read_clipboard" | "write_clipboard";

const curlActions: readonly BrowserUtilityAction[] = ["curl"];
const writeClipboardActions: readonly BrowserUtilityAction[] = [
  "write_clipboard",
];

const utilityFieldScopes = {
  session_id: ["curl", "read_clipboard", "write_clipboard"],
  url: curlActions,
  method: curlActions,
  headers: curlActions,
  body: curlActions,
  response_encoding: curlActions,
  timeout_ms: curlActions,
  text: writeClipboardActions,
} satisfies Record<string, readonly BrowserUtilityAction[]>;

type BrowserUtilityField = keyof typeof utilityFieldScopes;

const utilityFields = Object.keys(utilityFieldScopes) as BrowserUtilityField[];

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function actionFieldError(
  params: Partial<Record<BrowserUtilityField, unknown>>,
  action: BrowserUtilityAction,
) {
  const unsupportedField = utilityFields.find(
    (field) =>
      params[field] !== undefined &&
      !utilityFieldScopes[field].includes(action),
  );

  return unsupportedField
    ? `Error: ${unsupportedField} is only supported for ${utilityFieldScopes[
        unsupportedField
      ].join(", ")}.`
    : undefined;
}

function validateCurlUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https.");
  }
}

export function registerBrowserUtilityTools(server: McpServer) {
  server.tool(
    "browser_utilities",
    'Run browser-scoped utilities against an existing Kernel browser session. Use action "curl" to send an HTTP request through Chrome\'s network stack, "read_clipboard" to read browser clipboard text, or "write_clipboard" to write browser clipboard text.',
    {
      action: z
        .enum(["curl", "read_clipboard", "write_clipboard"])
        .describe("Utility operation to perform."),
      session_id: z.string().describe("Browser session ID."),
      url: z
        .string()
        .url()
        .describe("(curl) Target http or https URL.")
        .optional(),
      method: z
        .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        .describe("(curl) HTTP method. Defaults to GET.")
        .optional(),
      headers: z
        .record(z.string(), z.string())
        .describe("(curl) Custom headers merged with browser defaults.")
        .optional(),
      body: z
        .string()
        .describe("(curl) Request body for POST, PUT, or PATCH requests.")
        .optional(),
      response_encoding: z
        .enum(["utf8", "base64"])
        .describe(
          "(curl) Response body encoding. Use base64 for binary content.",
        )
        .optional(),
      timeout_ms: z
        .number()
        .describe("(curl) Request timeout in milliseconds.")
        .optional(),
      text: z
        .string()
        .describe("(write_clipboard) Text to write to the browser clipboard.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const scopeError = actionFieldError(params, params.action);
        if (scopeError) return textResponse(scopeError);

        switch (params.action) {
          case "curl": {
            if (!params.url) return textResponse("Error: url is required.");
            validateCurlUrl(params.url);

            const curlParams: BrowserCurlParams = {
              url: params.url,
              ...(params.method !== undefined && { method: params.method }),
              ...(params.headers !== undefined && { headers: params.headers }),
              ...(params.body !== undefined && { body: params.body }),
              ...(params.response_encoding !== undefined && {
                response_encoding: params.response_encoding,
              }),
              ...(params.timeout_ms !== undefined && {
                timeout_ms: params.timeout_ms,
              }),
            };
            const response = await client.browsers.curl(
              params.session_id,
              curlParams,
            );
            return textResponse(JSON.stringify(response, null, 2));
          }
          case "read_clipboard": {
            const response = await client.browsers.computer.readClipboard(
              params.session_id,
            );
            return textResponse(JSON.stringify(response, null, 2));
          }
          case "write_clipboard": {
            if (params.text === undefined) {
              return textResponse("Error: text is required.");
            }
            await client.browsers.computer.writeClipboard(params.session_id, {
              text: params.text,
            });
            return textResponse("Clipboard updated successfully");
          }
        }
      } catch (error) {
        return textResponse(
          `Error in browser_utilities (${params.action}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );
}
