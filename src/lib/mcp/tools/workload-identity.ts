import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  rejectUnusedFields,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { apiKeyPolicySchema, paginationParams } from "@/lib/mcp/schemas";

const presetTypeSchema = z.enum([
  "github_actions",
  "aws",
  "google_cloud",
  "microsoft_entra",
  "kubernetes",
  "custom_oidc",
]);

const workloadIdentityKeySourceSchema = z
  .object({
    type: z.enum(["discovery", "explicit_url", "inline"]),
    url: z.string().url().max(2048).optional(),
    discovery_base_url: z.string().url().max(2048).optional(),
    ca_cert_pem: z.string().max(65536).optional(),
    keys: z.array(z.record(z.string(), z.unknown())).min(1).max(16).optional(),
  })
  .strict();

const workloadIdentityTokenValidationSchema = z
  .object({
    max_lifetime_seconds: z.number().int().min(1).max(172800).optional(),
    replay_protection: z.enum(["single_use", "allow_reuse"]).optional(),
  })
  .strict();

const workloadIdentityMatchSchema = z
  .object({
    type: presetTypeSchema.describe("must equal the issuer preset_type."),
    subject: z.string().min(1).max(1024).optional(),
    subject_prefix: z.string().min(1).max(1024).optional(),
    claims: z
      .record(z.string(), z.string().min(1).max(1024))
      .refine(
        (claims) => Object.keys(claims).length <= 32,
        "claims must have at most 32 properties.",
      )
      .meta({ maxProperties: 32 })
      .optional(),
    repository: z.string().max(256).optional(),
    repository_id: z
      .string()
      .regex(/^[0-9]+$/)
      .max(32)
      .optional(),
    repository_owner_id: z
      .string()
      .regex(/^[0-9]+$/)
      .max(32)
      .optional(),
    workflow: z.string().max(512).optional(),
    workflow_ref: z.string().max(1024).optional(),
    job_workflow_ref: z.string().max(1024).optional(),
    ref: z.string().max(512).optional(),
    environment: z.string().max(256).optional(),
    event_names: z.array(z.string().min(1).max(128)).min(1).max(20).optional(),
    namespace: z.string().max(63).optional(),
    service_account: z.string().max(253).optional(),
  })
  .strict();

const fullDateTimeSchema = z.string().datetime({ offset: true });
const dateTimeSchema = () =>
  z
    .string()
    .refine(
      (value) => fullDateTimeSchema.safeParse(value).success,
      "must be an rfc3339 date-time with an offset.",
    )
    .meta({ format: "date-time" });

const workloadIdentityActions = [
  "create_service_account",
  "list_service_accounts",
  "get_service_account",
  "update_service_account",
  "archive_service_account",
  "create_issuer",
  "list_issuers",
  "get_issuer",
  "update_issuer",
  "archive_issuer",
  "verify_issuer",
  "create_rule",
  "list_rules",
  "get_rule",
  "update_rule",
  "archive_rule",
  "list_authentication_events",
] as const;

const workloadIdentityInputSchema = z.object({
  action: z.enum(workloadIdentityActions).describe("operation to perform."),
  id: z
    .string()
    .min(1)
    .describe("resource id for get, update, archive, or verify.")
    .optional(),
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/)
    .describe(
      "(create, update) 1-128 alphanumeric or hyphen characters, starting alphanumeric.",
    )
    .optional(),
  description: z
    .string()
    .max(4096)
    .describe(
      "(create/update account, issuer, rule) empty string clears on update.",
    )
    .optional(),
  expected_version: z
    .number()
    .int()
    .min(1)
    .describe(
      "(update) current authority security_version; required. cosmetic updates do not widen permissions.",
    )
    .optional(),
  enabled: z
    .boolean()
    .describe(
      "(create/update issuer or rule) enabled; create default false. (list_issuers) filter.",
    )
    .optional(),
  query: z
    .string()
    .max(256)
    .describe(
      "(list accounts/issuers/rules) name or description substring, or exact id.",
    )
    .optional(),
  status: z
    .enum(["active", "archived", "all"])
    .describe(
      "(list_service_accounts, list_issuers, list_rules) status; default active.",
    )
    .optional(),
  limit: paginationParams.limit.describe(
    "(list_*) max results per page; 1-100.",
  ),
  offset: paginationParams.offset.describe(
    "(list_*) pagination offset; 0 or greater.",
  ),
  issuer_url: z
    .string()
    .url()
    .max(2048)
    .describe(
      "(create_issuer, update_issuer) exact signed issuer uri; optional for github_actions and google_cloud.",
    )
    .optional(),
  preset_type: presetTypeSchema
    .describe(
      "(create/update issuer) provider kind; known issuer urls require their matching type, otherwise custom_oidc.",
    )
    .optional(),
  jwks: workloadIdentityKeySourceSchema
    .describe(
      "(create/update issuer) public keys from discovery, explicit_url, or 1-16 inline jwks. ca_cert_pem replaces system roots; private keys and private-network retrieval are unsupported.",
    )
    .optional(),
  token_validation: workloadIdentityTokenValidationSchema
    .describe(
      "(create/update issuer) incoming exp minus iat is capped at 1-172800 seconds (48 hours), independently of issued token ttl; the upper bound covers azure managed identity tokens that can live slightly over 24 hours. replay defaults: single_use for github_actions/aws/entra/custom, allow_reuse for kubernetes; google_cloud always reuses. entra/custom may reuse, kubernetes may use single use, and github_actions/aws cannot reuse.",
    )
    .optional(),
  issuer_id: z
    .string()
    .min(1)
    .max(128)
    .describe("(create/update rule) issuer id. (list rules/events) filter.")
    .optional(),
  match: workloadIdentityMatchSchema
    .describe(
      "(create_rule, update_rule) provider match. up to 32 exact rfc 6901 claim conditions must all match; repository is display-only, while immutable ids define its identity.",
    )
    .optional(),
  expected_audience: z
    .string()
    .min(1)
    .max(2048)
    .describe("(create_rule, update_rule) required incoming audience.")
    .optional(),
  service_account_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "(create/update rule) target account. (list rules/events) filter.",
    )
    .optional(),
  project_id: z
    .string()
    .min(1)
    .max(128)
    .describe("(create/update rule) sole project. (list rules/events) filter.")
    .optional(),
  policy: apiKeyPolicySchema
    .describe(
      "(create_rule, update_rule) allow statements for that project in scoped api-key policy format; api-key actions and every unlisted action/resource are denied.",
    )
    .optional(),
  token_audience: z
    .string()
    .min(1)
    .max(2048)
    .describe("(create_rule, update_rule) issued credential audience.")
    .optional(),
  max_token_ttl_seconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .describe(
      "(create_rule, update_rule) issued-token lifetime cap; 1-600 seconds, default 300.",
    )
    .optional(),
  federation_rule_id: z
    .string()
    .min(1)
    .describe("(list_authentication_events) federation rule filter.")
    .optional(),
  outcome: z
    .enum(["success", "failure"])
    .describe("(list_authentication_events) filter.")
    .optional(),
  start_time: dateTimeSchema()
    .describe("(list_authentication_events) events at or after this time.")
    .optional(),
  end_time: dateTimeSchema()
    .describe("(list_authentication_events) events at or before this time.")
    .optional(),
});

type ServiceAccountCreateParams = Parameters<
  KernelClient["serviceAccounts"]["create"]
>[0];
type ServiceAccountUpdateParams = Parameters<
  KernelClient["serviceAccounts"]["update"]
>[1];
type IssuerCreateParams = Parameters<
  KernelClient["workloadIdentityIssuers"]["create"]
>[0];
type IssuerUpdateParams = Parameters<
  KernelClient["workloadIdentityIssuers"]["update"]
>[1];
type RuleCreateParams = Parameters<
  KernelClient["workloadIdentityFederationRules"]["create"]
>[0];
type RuleUpdateParams = Parameters<
  KernelClient["workloadIdentityFederationRules"]["update"]
>[1];
type RuleAuthorization = NonNullable<RuleUpdateParams["authorization"]>;

export function registerWorkloadIdentityCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.registerTool(
    "manage_workload_identity",
    {
      description:
        "manage service accounts and workload identity: create/list/get/update/archive accounts, issuers, and rules; verify issuer keys; or list sanitized outcomes. signed-in users only—api keys/workload credentials are rejected. writes require a credential administrator; issuers/rules default disabled. verify does not enable trust or issue credentials; archive keeps history and browsers but invalidates authority. account last_used_at can lag 15 minutes.",
      inputSchema: workloadIdentityInputSchema,
      annotations: {
        title: "manage KERNEL workload identity",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      if (ctx.http.authInfo.scopes.includes("apikey")) {
        return errorResponse(
          "error: manage_workload_identity requires a signed-in user session; API keys and workload identity credentials are not accepted.",
        );
      }

      const client = dependencies.createKernelClient(ctx.http.authInfo.token);

      try {
        switch (params.action) {
          case "create_service_account": {
            const unused = rejectUnusedFields(
              "create_service_account",
              params,
              ["action", "name", "description"],
            );
            if (unused) return unused;
            if (!params.name) {
              return errorResponse(
                "error: name is required for create_service_account.",
              );
            }
            const body: ServiceAccountCreateParams = {
              name: params.name,
              ...(params.description !== undefined && {
                description: params.description,
              }),
            };
            return jsonResponse(await client.serviceAccounts.create(body));
          }
          case "list_service_accounts": {
            const unused = rejectUnusedFields("list_service_accounts", params, [
              "action",
              "query",
              "status",
              "limit",
              "offset",
            ]);
            if (unused) return unused;
            const page = await client.serviceAccounts.list({
              ...(params.query !== undefined && { query: params.query }),
              ...(params.status !== undefined && { status: params.status }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get_service_account": {
            const unused = rejectUnusedFields("get_service_account", params, [
              "action",
              "id",
            ]);
            if (unused) return unused;
            if (!params.id) {
              return errorResponse(
                "error: id is required for get_service_account.",
              );
            }
            return jsonResponse(
              await client.serviceAccounts.retrieve(params.id),
            );
          }
          case "update_service_account": {
            const unused = rejectUnusedFields(
              "update_service_account",
              params,
              ["action", "id", "expected_version", "name", "description"],
            );
            if (unused) return unused;
            if (!params.id || params.expected_version === undefined) {
              return errorResponse(
                "error: id and expected_version are required for update_service_account.",
              );
            }
            const body: ServiceAccountUpdateParams = {
              expected_version: params.expected_version,
              ...(params.name !== undefined && { name: params.name }),
              ...(params.description !== undefined && {
                description: params.description,
              }),
            };
            return jsonResponse(
              await client.serviceAccounts.update(params.id, body),
            );
          }
          case "archive_service_account": {
            const unused = rejectUnusedFields(
              "archive_service_account",
              params,
              ["action", "id"],
            );
            if (unused) return unused;
            if (!params.id) {
              return errorResponse(
                "error: id is required for archive_service_account.",
              );
            }
            await client.serviceAccounts.delete(params.id);
            return textResponse("service account archived successfully");
          }
          case "create_issuer": {
            const unused = rejectUnusedFields("create_issuer", params, [
              "action",
              "name",
              "description",
              "enabled",
              "issuer_url",
              "preset_type",
              "jwks",
              "token_validation",
            ]);
            if (unused) return unused;
            if (!params.name) {
              return errorResponse(
                "error: name is required for create_issuer.",
              );
            }
            const body: IssuerCreateParams = {
              name: params.name,
              ...(params.description !== undefined && {
                description: params.description,
              }),
              ...(params.enabled !== undefined && { enabled: params.enabled }),
              ...(params.issuer_url !== undefined && {
                issuer_url: params.issuer_url,
              }),
              ...(params.preset_type !== undefined && {
                preset_type: params.preset_type,
              }),
              ...(params.jwks !== undefined && { jwks: params.jwks }),
              ...(params.token_validation !== undefined && {
                token_validation: params.token_validation,
              }),
            };
            return jsonResponse(
              await client.workloadIdentityIssuers.create(body),
            );
          }
          case "list_issuers": {
            const unused = rejectUnusedFields("list_issuers", params, [
              "action",
              "enabled",
              "query",
              "status",
              "limit",
              "offset",
            ]);
            if (unused) return unused;
            const page = await client.workloadIdentityIssuers.list({
              ...(params.enabled !== undefined && { enabled: params.enabled }),
              ...(params.query !== undefined && { query: params.query }),
              ...(params.status !== undefined && { status: params.status }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get_issuer": {
            const unused = rejectUnusedFields("get_issuer", params, [
              "action",
              "id",
            ]);
            if (unused) return unused;
            if (!params.id) {
              return errorResponse("error: id is required for get_issuer.");
            }
            return jsonResponse(
              await client.workloadIdentityIssuers.retrieve(params.id),
            );
          }
          case "update_issuer": {
            const unused = rejectUnusedFields("update_issuer", params, [
              "action",
              "id",
              "expected_version",
              "name",
              "description",
              "enabled",
              "issuer_url",
              "preset_type",
              "jwks",
              "token_validation",
            ]);
            if (unused) return unused;
            if (!params.id || params.expected_version === undefined) {
              return errorResponse(
                "error: id and expected_version are required for update_issuer.",
              );
            }
            const body: IssuerUpdateParams = {
              expected_version: params.expected_version,
              ...(params.name !== undefined && { name: params.name }),
              ...(params.description !== undefined && {
                description: params.description,
              }),
              ...(params.enabled !== undefined && { enabled: params.enabled }),
              ...(params.issuer_url !== undefined && {
                issuer_url: params.issuer_url,
              }),
              ...(params.preset_type !== undefined && {
                preset_type: params.preset_type,
              }),
              ...(params.jwks !== undefined && { jwks: params.jwks }),
              ...(params.token_validation !== undefined && {
                token_validation: params.token_validation,
              }),
            };
            return jsonResponse(
              await client.workloadIdentityIssuers.update(params.id, body),
            );
          }
          case "archive_issuer": {
            const unused = rejectUnusedFields("archive_issuer", params, [
              "action",
              "id",
            ]);
            if (unused) return unused;
            if (!params.id) {
              return errorResponse("error: id is required for archive_issuer.");
            }
            await client.workloadIdentityIssuers.delete(params.id);
            return textResponse(
              "workload identity issuer archived successfully",
            );
          }
          case "verify_issuer": {
            const unused = rejectUnusedFields("verify_issuer", params, [
              "action",
              "id",
            ]);
            if (unused) return unused;
            if (!params.id) {
              return errorResponse("error: id is required for verify_issuer.");
            }
            return jsonResponse(
              await client.workloadIdentityIssuers.verify(params.id),
            );
          }
          case "create_rule": {
            const unused = rejectUnusedFields("create_rule", params, [
              "action",
              "name",
              "description",
              "enabled",
              "issuer_id",
              "match",
              "expected_audience",
              "service_account_id",
              "project_id",
              "policy",
              "token_audience",
              "max_token_ttl_seconds",
            ]);
            if (unused) return unused;
            if (
              !params.name ||
              !params.issuer_id ||
              !params.match ||
              !params.expected_audience ||
              !params.service_account_id ||
              !params.project_id ||
              !params.policy ||
              !params.token_audience
            ) {
              return errorResponse(
                "error: name, issuer_id, match, expected_audience, service_account_id, project_id, policy, and token_audience are required for create_rule.",
              );
            }
            const body: RuleCreateParams = {
              name: params.name,
              issuer_id: params.issuer_id,
              match: params.match,
              expected_audience: params.expected_audience,
              target: {
                type: "service_account",
                service_account_id: params.service_account_id,
              },
              authorization: {
                project_id: params.project_id,
                policy: params.policy,
                token_audience: params.token_audience,
                ...(params.max_token_ttl_seconds !== undefined && {
                  max_token_ttl_seconds: params.max_token_ttl_seconds,
                }),
              },
              ...(params.description !== undefined && {
                description: params.description,
              }),
              ...(params.enabled !== undefined && { enabled: params.enabled }),
            };
            return jsonResponse(
              await client.workloadIdentityFederationRules.create(body),
            );
          }
          case "list_rules": {
            const unused = rejectUnusedFields("list_rules", params, [
              "action",
              "issuer_id",
              "service_account_id",
              "project_id",
              "query",
              "status",
              "limit",
              "offset",
            ]);
            if (unused) return unused;
            const page = await client.workloadIdentityFederationRules.list({
              ...(params.issuer_id !== undefined && {
                issuer_id: params.issuer_id,
              }),
              ...(params.service_account_id !== undefined && {
                service_account_id: params.service_account_id,
              }),
              ...(params.project_id !== undefined && {
                project_id: params.project_id,
              }),
              ...(params.query !== undefined && { query: params.query }),
              ...(params.status !== undefined && { status: params.status }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get_rule": {
            const unused = rejectUnusedFields("get_rule", params, [
              "action",
              "id",
            ]);
            if (unused) return unused;
            if (!params.id) {
              return errorResponse("error: id is required for get_rule.");
            }
            return jsonResponse(
              await client.workloadIdentityFederationRules.retrieve(params.id),
            );
          }
          case "update_rule": {
            const unused = rejectUnusedFields("update_rule", params, [
              "action",
              "id",
              "expected_version",
              "name",
              "description",
              "enabled",
              "issuer_id",
              "match",
              "expected_audience",
              "service_account_id",
              "project_id",
              "policy",
              "token_audience",
              "max_token_ttl_seconds",
            ]);
            if (unused) return unused;
            if (!params.id || params.expected_version === undefined) {
              return errorResponse(
                "error: id and expected_version are required for update_rule.",
              );
            }
            const authorizationFieldsPresent =
              params.project_id !== undefined ||
              params.policy !== undefined ||
              params.token_audience !== undefined ||
              params.max_token_ttl_seconds !== undefined;
            let authorization: RuleAuthorization | undefined;
            if (authorizationFieldsPresent) {
              if (
                params.project_id === undefined ||
                params.policy === undefined ||
                params.token_audience === undefined
              ) {
                return errorResponse(
                  "error: changing rule authorization requires project_id, policy, and token_audience together.",
                );
              }
              authorization = {
                project_id: params.project_id,
                policy: params.policy,
                token_audience: params.token_audience,
                ...(params.max_token_ttl_seconds !== undefined && {
                  max_token_ttl_seconds: params.max_token_ttl_seconds,
                }),
              };
            }
            const body: RuleUpdateParams = {
              expected_version: params.expected_version,
              ...(params.name !== undefined && { name: params.name }),
              ...(params.description !== undefined && {
                description: params.description,
              }),
              ...(params.enabled !== undefined && { enabled: params.enabled }),
              ...(params.issuer_id !== undefined && {
                issuer_id: params.issuer_id,
              }),
              ...(params.match !== undefined && { match: params.match }),
              ...(params.expected_audience !== undefined && {
                expected_audience: params.expected_audience,
              }),
              ...(params.service_account_id !== undefined && {
                target: {
                  type: "service_account",
                  service_account_id: params.service_account_id,
                },
              }),
              ...(authorization !== undefined && { authorization }),
            };
            return jsonResponse(
              await client.workloadIdentityFederationRules.update(
                params.id,
                body,
              ),
            );
          }
          case "archive_rule": {
            const unused = rejectUnusedFields("archive_rule", params, [
              "action",
              "id",
            ]);
            if (unused) return unused;
            if (!params.id) {
              return errorResponse("error: id is required for archive_rule.");
            }
            await client.workloadIdentityFederationRules.delete(params.id);
            return textResponse(
              "workload identity federation rule archived successfully",
            );
          }
          case "list_authentication_events": {
            const unused = rejectUnusedFields(
              "list_authentication_events",
              params,
              [
                "action",
                "issuer_id",
                "federation_rule_id",
                "service_account_id",
                "project_id",
                "outcome",
                "start_time",
                "end_time",
                "limit",
                "offset",
              ],
            );
            if (unused) return unused;
            const page = await client.workloadIdentityAuthenticationEvents.list(
              {
                ...(params.issuer_id !== undefined && {
                  issuer_id: params.issuer_id,
                }),
                ...(params.federation_rule_id !== undefined && {
                  federation_rule_id: params.federation_rule_id,
                }),
                ...(params.service_account_id !== undefined && {
                  service_account_id: params.service_account_id,
                }),
                ...(params.project_id !== undefined && {
                  project_id: params.project_id,
                }),
                ...(params.outcome !== undefined && {
                  outcome: params.outcome,
                }),
                ...(params.start_time !== undefined && {
                  start_time: params.start_time,
                }),
                ...(params.end_time !== undefined && {
                  end_time: params.end_time,
                }),
                ...(params.limit !== undefined && { limit: params.limit }),
                ...(params.offset !== undefined && { offset: params.offset }),
              },
            );
            return paginatedJsonResponse(page);
          }
        }
      } catch (error) {
        throwToolError("manage_workload_identity", params.action, error);
      }
    },
  );
}
