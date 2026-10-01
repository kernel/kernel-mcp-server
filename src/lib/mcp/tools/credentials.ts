import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

export function registerCredentialTools(server: McpServer) {
  // manage_credentials -- Manage stored credentials for managed auth
  server.registerTool(
    "manage_credentials",
    {
      description:
        'manage credentials stored in KERNEL for managed auth. "list" discovers credentials (optionally filtered by domain), "get" returns a credential\'s metadata (values are never returned), "totp_code" returns the current 6-digit totp for credentials with a configured totp_secret, "create" stores a new credential, "update" changes its name/values/sso_provider/totp_secret (values are merged with existing), and "delete" removes a credential by id or name.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum(["list", "get", "totp_code", "create", "update", "delete"])
          .describe("operation to perform."),
        id_or_name: z
          .string()
          .describe("(get, totp_code, update, delete) credential id or name.")
          .optional(),
        ...paginationParams,
        domain: z
          .string()
          .describe(
            "(list) filter by domain. (create) target domain this credential is for.",
          )
          .optional(),
        name: z
          .string()
          .describe(
            "(create) unique name for the credential within the organization. (update) new name.",
          )
          .optional(),
        values: z
          .record(z.string(), z.string())
          .describe(
            "(create, update) field name to value mapping (e.g. username, password). on update, merged with existing values.",
          )
          .optional(),
        sso_provider: z
          .string()
          .describe(
            "(create, update) sso provider to use (e.g. google, github, microsoft). on update, empty string clears it.",
          )
          .optional(),
        totp_secret: z
          .string()
          .describe(
            "(create, update) base32-encoded totp secret for automatic 2fa. on update, empty string clears it.",
          )
          .optional(),
      }),
      annotations: {
        title: "manage KERNEL credentials",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "list": {
            const page = await client.credentials.list({
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
              ...(params.domain !== undefined && { domain: params.domain }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.id_or_name)
              return errorResponse("error: id_or_name is required for get.");
            const credential = await client.credentials.retrieve(
              params.id_or_name,
            );
            return jsonResponse(credential);
          }
          case "totp_code": {
            if (!params.id_or_name)
              return errorResponse(
                "error: id_or_name is required for totp_code.",
              );
            const response = await client.credentials.totpCode(
              params.id_or_name,
            );
            return jsonResponse(response);
          }
          case "create": {
            if (
              !params.domain ||
              !params.name ||
              !params.values ||
              Object.keys(params.values).length === 0
            ) {
              return errorResponse(
                "error: domain, name, and non-empty values are required for create.",
              );
            }
            const credential = await client.credentials.create({
              domain: params.domain,
              name: params.name,
              values: params.values,
              ...(params.sso_provider !== undefined && {
                sso_provider: params.sso_provider,
              }),
              ...(params.totp_secret !== undefined && {
                totp_secret: params.totp_secret,
              }),
            });
            if (!credential)
              return errorResponse("failed to create credential");
            return jsonResponse(credential);
          }
          case "update": {
            if (!params.id_or_name)
              return errorResponse("error: id_or_name is required for update.");
            const updateParams = {
              ...(params.name !== undefined && { name: params.name }),
              ...(params.values !== undefined && { values: params.values }),
              ...(params.sso_provider !== undefined && {
                sso_provider: params.sso_provider,
              }),
              ...(params.totp_secret !== undefined && {
                totp_secret: params.totp_secret,
              }),
            };
            if (Object.keys(updateParams).length === 0) {
              return errorResponse(
                "error: at least one update field is required.",
              );
            }
            const credential = await client.credentials.update(
              params.id_or_name,
              updateParams,
            );
            return jsonResponse(credential);
          }
          case "delete": {
            if (!params.id_or_name)
              return errorResponse("error: id_or_name is required for delete.");
            await client.credentials.delete(params.id_or_name);
            return textResponse(`credential ${params.id_or_name} deleted.`);
          }
        }
      } catch (error) {
        throwToolError("manage_credentials", params.action, error);
      }
    },
  );
}
