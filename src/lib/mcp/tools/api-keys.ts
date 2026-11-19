import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

const apiKeyPolicySchema = z
  .object({
    statements: z
      .array(
        z
          .object({
            action: z.string().min(1),
            resource: z.string().min(1),
            condition: z
              .object({
                key: z.literal("source_ip"),
                operator: z.literal("in"),
                values: z.array(z.string().min(1)).min(1).max(16),
              })
              .strict()
              .describe(
                "optional request condition. source_ip with operator=in restricts this statement to client addresses inside one of 1-16 canonical cidr networks; bare addresses and networks with host bits set are rejected by the api.",
              )
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

export function registerAPIKeyCapabilities(
  server: McpServer,
  options: McpDependencies = {
    ...defaultMcpDependencies,
  },
) {
  // manage_api_keys -- Create, list, get, update, and delete Kernel API keys
  server.registerTool(
    "manage_api_keys",
    {
      description:
        'manage KERNEL api keys. use "create" for a personal key or an organization-owned service-account key, "list" to discover masked keys, "get" to retrieve one masked key, "update" to rename a key or fully replace its policy without rotating its credential, "rotate" to issue a replacement with an optional grace period, or "delete" to revoke a key. policies deny every action/resource they do not list; source_ip conditions add cidr allowlisting to individual statements. service-account keys require an organization administrator, explicit project, and nonempty policy; responses distinguish their service principal from the human audit creator. list and get include last_used_at, accurate within about 20 minutes or null when unused. create and rotate return the new plaintext key once; handle it as a secret and never repeat it in chat. delete asynchronously ends browser sessions attributed to the revoked key and discards unsaved profile changes; if cleanup cannot be registered, deletion is not committed. rotate with expire_in_days=0 does the same immediate cleanup; grace-period or natural expiry does not end existing browsers. service-account rotation retains its principal and policy.',
      inputSchema: z.object({
        action: z
          .enum(["create", "list", "get", "update", "rotate", "delete"])
          .describe("operation to perform."),
        api_key_id: z
          .string()
          .min(1)
          .describe(
            "api key id. required for get, update, rotate, and delete; keys are not addressable by name.",
          )
          .optional(),
        name: z
          .string()
          .min(1)
          .max(255)
          .describe(
            "(create, update) api key name. (list) exact-match name filter; names are not unique.",
          )
          .optional(),
        project_id: z
          .string()
          .nullable()
          .describe(
            "(create) project id for project-scoped keys. omit or use null for org-wide personal keys. a service_account_id requires an explicit non-null project id.",
          )
          .optional(),
        service_account_id: z
          .string()
          .min(1)
          .describe(
            "(create) active same-organization service account to make the key's principal. requires an organization administrator, explicit project_id, and policy. omit for a personal key.",
          )
          .optional(),
        days_to_expire: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .nullable()
          .describe(
            "(create) days until expiry; null means no expiry. (rotate) lifetime of the new key; omit to reuse the old key's lifetime and null means no expiry.",
          )
          .optional(),
        expires_at: z
          .string()
          .datetime({ offset: true })
          .nullable()
          .describe(
            "(create) exact future expiry, or null for no expiry. cannot be combined with days_to_expire.",
          )
          .optional(),
        policy: apiKeyPolicySchema
          .describe(
            "(create, update) allow statements for a scoped key. every action and resource not listed is denied; resources use projects/{project_id}/{kind}/{id} and may contain wildcards. on update, the supplied policy fully replaces current permissions without changing the key secret; omit it to leave permissions unchanged. policy:null is not accepted.",
          )
          .optional(),
        expire_in_days: z
          .number()
          .int()
          .min(0)
          .max(3650)
          .nullable()
          .describe(
            "(rotate) grace period before the old key expires. zero expires it immediately; omit for 7 days.",
          )
          .optional(),
        include_deleted: z
          .boolean()
          .describe(
            "(get) include a soft-deleted key for audit. (list) deprecated compatibility flag; prefer status=all.",
          )
          .optional(),
        query: z
          .string()
          .describe(
            "(list) case-insensitive search over name, creator, and project; ids and masked keys match exactly or by prefix.",
          )
          .optional(),
        status: z
          .enum(["active", "deleted", "all"])
          .describe("(list) key status filter. defaults to active.")
          .optional(),
        sort_by: z
          .enum(["created_at", "name", "expires_at", "last_used_at"])
          .describe(
            "(list) field to sort by. when sorting by expires_at or last_used_at, keys missing that value sort last in either direction.",
          )
          .optional(),
        sort_direction: z
          .enum(["asc", "desc"])
          .describe("(list) sort direction.")
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL api keys",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = options.createKernelClient(ctx.http.authInfo.token);

      if (params.action !== "create" && params.expires_at !== undefined) {
        return errorResponse("error: expires_at is create-only.");
      }
      if (
        params.action !== "create" &&
        params.action !== "update" &&
        params.policy !== undefined
      ) {
        return errorResponse("error: policy applies only to create and update.");
      }
      if (
        params.action !== "create" &&
        params.service_account_id !== undefined
      ) {
        return errorResponse("error: service_account_id is create-only.");
      }
      if (params.action !== "create" && params.project_id !== undefined) {
        return errorResponse("error: project_id is create-only.");
      }
      if (params.action !== "rotate" && params.expire_in_days !== undefined) {
        return errorResponse("error: expire_in_days is rotate-only.");
      }
      if (
        params.action !== "create" &&
        params.action !== "rotate" &&
        params.days_to_expire !== undefined
      ) {
        return errorResponse(
          "error: days_to_expire applies only to create and rotate.",
        );
      }

      try {
        switch (params.action) {
          case "create": {
            if (!params.name) {
              return errorResponse("error: name is required for create.");
            }
            if (
              params.days_to_expire !== undefined &&
              params.expires_at !== undefined
            ) {
              return errorResponse(
                "error: days_to_expire and expires_at cannot be combined.",
              );
            }
            if (
              params.service_account_id !== undefined &&
              (params.project_id === undefined ||
                params.project_id === null ||
                params.policy === undefined)
            ) {
              return errorResponse(
                "error: service_account_id requires an explicit project_id and policy.",
              );
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
            if (params.expires_at !== undefined) {
              createParams.expires_at = params.expires_at;
            }
            if (params.policy !== undefined) {
              createParams.policy = params.policy;
            }
            if (params.service_account_id !== undefined) {
              createParams.service_account_id = params.service_account_id;
            }
            const apiKey = await client.apiKeys.create(createParams);
            return jsonResponse(apiKey);
          }
          case "list": {
            const page = await client.apiKeys.list({
              ...(params.include_deleted !== undefined && {
                include_deleted: params.include_deleted,
              }),
              ...(params.name !== undefined && { name: params.name }),
              ...(params.query !== undefined && { query: params.query }),
              ...(params.status !== undefined && { status: params.status }),
              ...(params.sort_by !== undefined && { sort_by: params.sort_by }),
              ...(params.sort_direction !== undefined && {
                sort_direction: params.sort_direction,
              }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            if (!params.api_key_id) {
              return errorResponse("error: api_key_id is required for get.");
            }
            const apiKey = await client.apiKeys.retrieve(
              params.api_key_id,
              params.include_deleted !== undefined
                ? { include_deleted: params.include_deleted }
                : undefined,
            );
            return jsonResponse(apiKey);
          }
          case "update": {
            if (!params.api_key_id) {
              return errorResponse("error: api_key_id is required for update.");
            }
            if (params.name === undefined && params.policy === undefined) {
              return errorResponse(
                "error: update requires at least one of name or policy.",
              );
            }
            const apiKey = await client.apiKeys.update(params.api_key_id, {
              ...(params.name !== undefined && { name: params.name }),
              ...(params.policy !== undefined && { policy: params.policy }),
            });
            return jsonResponse(apiKey);
          }
          case "rotate": {
            if (!params.api_key_id) {
              return errorResponse("error: api_key_id is required for rotate.");
            }
            const apiKey = await client.apiKeys.rotate(params.api_key_id, {
              ...(params.days_to_expire !== undefined && {
                days_to_expire: params.days_to_expire,
              }),
              ...(params.expire_in_days !== undefined && {
                expire_in_days: params.expire_in_days,
              }),
            });
            return jsonResponse(apiKey);
          }
          case "delete": {
            if (!params.api_key_id) {
              return errorResponse("error: api_key_id is required for delete.");
            }
            await client.apiKeys.delete(params.api_key_id);
            return textResponse("api key deleted successfully");
          }
        }
      } catch (error) {
        throwToolError("manage_api_keys", params.action, error);
      }
    },
  );
}
