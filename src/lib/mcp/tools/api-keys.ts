import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

export function registerAPIKeyCapabilities(server: McpServer) {
  // manage_api_keys -- Create, list, get, update, and delete Kernel API keys
  server.tool(
    "manage_api_keys",
    'Manage Kernel API keys. Use "create" to create an org-wide or project-scoped key, "list" to discover masked keys, "get" to retrieve one masked key, "update" to rename a key, or "delete" to revoke a key. Created keys include the plaintext key once.',
    {
      action: z
        .enum(["create", "list", "get", "update", "delete"])
        .describe("Operation to perform."),
      api_key_id: z
        .string()
        .describe("API key ID. Required for get, update, and delete.")
        .optional(),
      name: z.string().describe("(create, update) API key name.").optional(),
      project_id: z
        .string()
        .nullable()
        .describe(
          "(create) Project ID for project-scoped keys. Omit or use null for org-wide keys.",
        )
        .optional(),
      days_to_expire: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .nullable()
        .describe(
          "(create) Days until expiry, up to 3650. Use null for no expiry.",
        )
        .optional(),
      ...paginationParams,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "create": {
            if (!params.name) {
              return errorResponse("Error: name is required for create.");
            }
            const createParams: Parameters<typeof client.apiKeys.create>[0] = {
              name: params.name,
            };
            if (params.project_id !== undefined) {
              createParams.project_id = params.project_id;
            }
            if (params.days_to_expire !== undefined) {
              createParams.days_to_expire = params.days_to_expire;
            }
            const apiKey = await client.apiKeys.create(createParams);
            return jsonResponse(apiKey);
          }
          case "list": {
            const page = await client.apiKeys.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.api_key_id) {
              return errorResponse("Error: api_key_id is required for get.");
            }
            const apiKey = await client.apiKeys.retrieve(params.api_key_id);
            return jsonResponse(apiKey);
          }
          case "update": {
            if (!params.api_key_id) {
              return errorResponse("Error: api_key_id is required for update.");
            }
            if (!params.name) {
              return errorResponse("Error: name is required for update.");
            }
            const apiKey = await client.apiKeys.update(params.api_key_id, {
              name: params.name,
            });
            return jsonResponse(apiKey);
          }
          case "delete": {
            if (!params.api_key_id) {
              return errorResponse("Error: api_key_id is required for delete.");
            }
            await client.apiKeys.delete(params.api_key_id);
            return textResponse("API key deleted successfully");
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_api_keys", params.action, error);
      }
    },
  );
}
