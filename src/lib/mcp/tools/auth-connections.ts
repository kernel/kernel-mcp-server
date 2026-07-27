import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  deriveAuthNextAction,
  toSafeAuthConnection,
} from "@/lib/mcp/tools/managed-auth-state";
import { errorResponse } from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

function safeJsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value as Record<string, unknown>,
  };
}

export function registerAuthConnectionTools(server: McpServer) {
  server.tool(
    "manage_auth_connections",
    'Discover sanitized Kernel managed-auth connections. Start every protected-site task with action="list" and domain_filter. Reason over all pages: use an AUTHENTICATED profile with manage_browsers, ask the user to choose when multiple profiles match, or ask for consent before calling open_auth_login for a new login/re-auth. Never ask the user to send passwords, OTPs, or MFA values in conversation. Connection creation, deletion, login, and credential mutation are intentionally outside this model-facing discovery tool. Actions: list, get.',
    {
      action: z.enum(["list", "get"]).describe("Discovery operation."),
      id: z
        .string()
        .describe("Auth connection ID. Required for get.")
        .optional(),
      profile_name: z
        .string()
        .describe("(list) Filter by profile_name.")
        .optional(),
      domain_filter: z
        .string()
        .describe(
          "(list) Domain to match. Always set this when discovering a profile for a protected site.",
        )
        .optional(),
      ...paginationParams,
    },
    {
      title: "Discover Kernel managed auth connections",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const page = await client.auth.connections.list({
              ...(params.profile_name && { profile_name: params.profile_name }),
              ...(params.domain_filter && { domain: params.domain_filter }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page.getPaginatedItems().map(toSafeAuthConnection);
            const hasMore = page.hasNextPage();
            const nextOffset = page.next_offset ?? null;
            const steering = deriveAuthNextAction({
              items,
              hasMore,
              nextOffset,
              offset: params.offset,
              domainFilter: params.domain_filter,
              profileFilter: params.profile_name,
            });
            return safeJsonResponse({
              items,
              has_more: hasMore,
              next_offset: nextOffset,
              ...steering,
            });
          }
          case "get": {
            if (!params.id) {
              return errorResponse("Error: id is required for get.");
            }
            const connection = await client.auth.connections.retrieve(
              params.id,
            );
            return safeJsonResponse({
              connection: toSafeAuthConnection(connection),
              instruction:
                connection.status === "AUTHENTICATED"
                  ? "Authentication is verified. Use this profile_name when creating the browser."
                  : "Do not continue the protected action. Ask for consent, then use open_auth_login to authenticate securely.",
            });
          }
        }
      } catch {
        return errorResponse(
          `Managed-auth ${params.action} failed. Retry or choose a different recovery option.`,
        );
      }
    },
  );
}
