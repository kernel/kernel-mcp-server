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

export const hostedAuthParams = {
  action: z.enum(["create", "list", "get", "delete", "login"]),
  id: z.string().optional(),
  domain: z.string().optional(),
  profile_name: z.string().optional(),
  allowed_domains: z.array(z.string()).optional(),
  login_url: z.string().optional(),
  health_check_interval: z.number().int().optional(),
  proxy_id: z.string().optional(),
  proxy_name: z.string().optional(),
  domain_filter: z.string().optional(),
  ...paginationParams,
};

export function registerHostedAuthTool(server: McpServer) {
  server.tool(
    "manage_hosted_auth",
    "Manage hosted Kernel authentication without exposing credentials to the agent. Create a connection for a profile and domain, start login to receive a hosted URL for the user, poll its state, list connections, or delete one.",
    hostedAuthParams,
    {
      title: "Manage hosted Kernel authentication",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);
      const proxy =
        params.proxy_id || params.proxy_name
          ? {
              ...(params.proxy_id && { id: params.proxy_id }),
              ...(params.proxy_name && { name: params.proxy_name }),
            }
          : undefined;

      try {
        switch (params.action) {
          case "create": {
            if (!params.domain || !params.profile_name) {
              return errorResponse(
                "Error: domain and profile_name are required for create.",
              );
            }
            const connection = await client.auth.connections.create({
              domain: params.domain,
              profile_name: params.profile_name,
              ...(params.allowed_domains && {
                allowed_domains: params.allowed_domains,
              }),
              ...(params.login_url && { login_url: params.login_url }),
              ...(params.health_check_interval !== undefined && {
                health_check_interval: params.health_check_interval,
              }),
            });
            return connection
              ? jsonResponse(connection)
              : errorResponse("Failed to create auth connection");
          }
          case "list": {
            const page = await client.auth.connections.list({
              ...(params.profile_name && { profile_name: params.profile_name }),
              ...(params.domain_filter && { domain: params.domain_filter }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.id)
              return errorResponse("Error: id is required for get.");
            return jsonResponse(
              await client.auth.connections.retrieve(params.id),
            );
          }
          case "delete": {
            if (!params.id) {
              return errorResponse("Error: id is required for delete.");
            }
            await client.auth.connections.delete(params.id);
            return textResponse("Hosted auth connection deleted successfully");
          }
          case "login": {
            if (!params.id) {
              return errorResponse("Error: id is required for login.");
            }
            return jsonResponse(
              await client.auth.connections.login(
                params.id,
                proxy ? { proxy } : undefined,
              ),
            );
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_hosted_auth", params.action, error);
      }
    },
  );
}
