import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  rejectUnusedFields,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

const taskMetadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(256))
  .refine(
    (metadata) => Object.keys(metadata).length <= 20,
    "metadata must have at most 20 keys.",
  )
  .refine(
    (metadata) =>
      Object.entries(metadata).reduce(
        (bytes, [key, value]) =>
          bytes +
          Buffer.byteLength(key, "utf8") +
          Buffer.byteLength(value, "utf8"),
        0,
      ) <= 4096,
    "metadata keys and values together must be at most 4 kb.",
  )
  .meta({ maxProperties: 20 });

const reportDataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (data) => Buffer.byteLength(JSON.stringify(data), "utf8") <= 16 * 1024,
    "report_data must encode to at most 16 kb of json.",
  );

type TaskCreateParams = Parameters<KernelClient["tasks"]["create"]>[0];
type ReportCreateParams = Parameters<KernelClient["reports"]["create"]>[0];

export function registerTaskCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.registerTool(
    "manage_tasks",
    {
      description:
        'manage agent tasks (only browser links can be added) and immutable typed reports. "create" defines a task; "list" returns project tasks newest first; "get" reads one and its linked browsers; "link_browsers" safely adds links. discover schemas with "list_report_types", "get_report_type", or "get_report_type_version"; use "submit_report", "list_reports" (oldest first), or "get_report" for reports. automatic sdk retries are idempotent; repeating the tool call is a new create or submission.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum([
            "create",
            "list",
            "get",
            "link_browsers",
            "list_report_types",
            "get_report_type",
            "get_report_type_version",
            "submit_report",
            "list_reports",
            "get_report",
          ])
          .describe("operation to perform."),
        task_id: z
          .string()
          .min(1)
          .describe(
            "(get, link_browsers, list_report_types, submit_report, list_reports) task id. each task accepts at most 500 reports.",
          )
          .optional(),
        report_id: z
          .string()
          .min(1)
          .describe("(get_report) report id.")
          .optional(),
        description: z
          .string()
          .min(1)
          .max(4096)
          .describe(
            "(create) what the task is meant to accomplish, at most 4 kb.",
          )
          .optional(),
        target_website: z
          .string()
          .min(1)
          .max(253)
          .describe(
            "(create) hostname of the target website, without a scheme or path.",
          )
          .optional(),
        metadata: taskMetadataSchema
          .describe(
            "(create) string key-value pairs for grouping and filtering. at most 20 keys; keys are 1-64 characters, values at most 256 characters, and keys plus values at most 4 kb.",
          )
          .optional(),
        started_at: z
          .string()
          .datetime({ offset: true })
          .describe(
            "(create) when work started. defaults to task creation; no more than 5 minutes in the future or 30 days in the past.",
          )
          .optional(),
        session_ids: z
          .array(z.string().min(1))
          .max(100)
          .describe(
            "(create) browser ids to link; deleted browsers are accepted. (link_browsers) 1-100 browser ids to add; existing links are ignored and a task can have at most 100 linked browsers.",
          )
          .optional(),
        session_id: z
          .string()
          .min(1)
          .describe(
            "(list) only tasks linked to this browser id. (submit_report) browser where the event was observed; it must belong to the task project, deleted browsers are accepted, and it is linked to the task if needed.",
          )
          .optional(),
        report_type: z
          .string()
          .min(1)
          .describe(
            "(get_report_type, get_report_type_version, submit_report) report type name, such as task.result; submit names are at most 128 characters. get_report_type returns every version and the latest draft 2020-12 schema, or null when all versions are retired. (list_reports) exact type filter.",
          )
          .optional(),
        report_type_version: z
          .number()
          .int()
          .min(1)
          .describe(
            "(get_report_type_version) schema version number, starting at 1; retired versions can still be retrieved.",
          )
          .optional(),
        report_data: reportDataSchema
          .describe(
            "(submit_report) data matching the selected version's draft 2020-12 json schema; at most 16 kb after json encoding. read the type or version first for field descriptions and examples.",
          )
          .optional(),
        schema_version: z
          .number()
          .int()
          .min(1)
          .describe(
            "(submit_report) schema version to validate against. defaults to the latest non-retired version, which the response returns.",
          )
          .optional(),
        occurred_at: z
          .string()
          .datetime({ offset: true })
          .describe(
            "(submit_report) when the reported event happened. defaults to submission; no more than 5 minutes in the future or 30 days in the past.",
          )
          .optional(),
        limit: paginationParams.limit.describe(
          "(list, list_report_types, list_reports) maximum results per page; 1-100, default 20.",
        ),
        offset: paginationParams.offset.describe(
          "(list, list_report_types, list_reports) pagination offset; 0 or greater, default 0.",
        ),
      }),
      annotations: {
        title: "manage KERNEL agent tasks and reports",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = dependencies.createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "create": {
            const unused = rejectUnusedFields("create", params, [
              "action",
              "project",
              "project_id",
              "description",
              "target_website",
              "metadata",
              "started_at",
              "session_ids",
            ]);
            if (unused) return unused;
            if (!params.description) {
              return errorResponse(
                "error: description is required for create.",
              );
            }
            const body: TaskCreateParams = {
              description: params.description,
              ...(params.target_website !== undefined && {
                target_website: params.target_website,
              }),
              ...(params.metadata !== undefined && {
                metadata: params.metadata,
              }),
              ...(params.started_at !== undefined && {
                started_at: params.started_at,
              }),
              ...(params.session_ids !== undefined && {
                session_ids: params.session_ids,
              }),
            };
            return jsonResponse(await client.tasks.create(body));
          }
          case "list": {
            const unused = rejectUnusedFields("list", params, [
              "action",
              "project",
              "project_id",
              "session_id",
              "limit",
              "offset",
            ]);
            if (unused) return unused;
            const page = await client.tasks.list({
              ...(params.session_id !== undefined && {
                session_id: params.session_id,
              }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get": {
            const unused = rejectUnusedFields("get", params, [
              "action",
              "project",
              "project_id",
              "task_id",
            ]);
            if (unused) return unused;
            if (!params.task_id) {
              return errorResponse("error: task_id is required for get.");
            }
            return jsonResponse(await client.tasks.retrieve(params.task_id));
          }
          case "link_browsers": {
            const unused = rejectUnusedFields("link_browsers", params, [
              "action",
              "project",
              "project_id",
              "task_id",
              "session_ids",
            ]);
            if (unused) return unused;
            if (!params.task_id) {
              return errorResponse(
                "error: task_id is required for link_browsers.",
              );
            }
            if (!params.session_ids || params.session_ids.length === 0) {
              return errorResponse(
                "error: session_ids is required for link_browsers.",
              );
            }
            return jsonResponse(
              await client.tasks.linkBrowsers(params.task_id, {
                session_ids: params.session_ids,
              }),
            );
          }
          case "list_report_types": {
            const unused = rejectUnusedFields("list_report_types", params, [
              "action",
              "project",
              "project_id",
              "task_id",
              "limit",
              "offset",
            ]);
            if (unused) return unused;
            if (!params.task_id) {
              return errorResponse(
                "error: task_id is required for list_report_types.",
              );
            }
            const page = await client.reportTypes.list({
              task_id: params.task_id,
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, {
              note: "use get_report_type to read the latest json schema before submitting data; latest_version is 0 when every version is retired.",
            });
          }
          case "get_report_type": {
            const unused = rejectUnusedFields("get_report_type", params, [
              "action",
              "project",
              "project_id",
              "report_type",
            ]);
            if (unused) return unused;
            if (!params.report_type) {
              return errorResponse(
                "error: report_type is required for get_report_type.",
              );
            }
            return jsonResponse(
              await client.reportTypes.retrieve(params.report_type),
            );
          }
          case "get_report_type_version": {
            const unused = rejectUnusedFields(
              "get_report_type_version",
              params,
              [
                "action",
                "project",
                "project_id",
                "report_type",
                "report_type_version",
              ],
            );
            if (unused) return unused;
            if (
              !params.report_type ||
              params.report_type_version === undefined
            ) {
              return errorResponse(
                "error: report_type and report_type_version are required for get_report_type_version.",
              );
            }
            return jsonResponse(
              await client.reportTypes.versions.retrieve(
                params.report_type_version,
                {
                  type: params.report_type,
                },
              ),
            );
          }
          case "submit_report": {
            const unused = rejectUnusedFields("submit_report", params, [
              "action",
              "project",
              "project_id",
              "task_id",
              "report_type",
              "report_data",
              "occurred_at",
              "schema_version",
              "session_id",
            ]);
            if (unused) return unused;
            if (
              !params.task_id ||
              !params.report_type ||
              params.report_data === undefined
            ) {
              return errorResponse(
                "error: task_id, report_type, and report_data are required for submit_report.",
              );
            }
            if (params.report_type.length > 128) {
              return errorResponse(
                "error: report_type must be at most 128 characters for submit_report.",
              );
            }
            const body: ReportCreateParams = {
              task_id: params.task_id,
              type: params.report_type,
              data: params.report_data,
              ...(params.occurred_at !== undefined && {
                occurred_at: params.occurred_at,
              }),
              ...(params.schema_version !== undefined && {
                schema_version: params.schema_version,
              }),
              ...(params.session_id !== undefined && {
                session_id: params.session_id,
              }),
            };
            return jsonResponse(await client.reports.create(body));
          }
          case "list_reports": {
            const unused = rejectUnusedFields("list_reports", params, [
              "action",
              "project",
              "project_id",
              "task_id",
              "report_type",
              "limit",
              "offset",
            ]);
            if (unused) return unused;
            if (!params.task_id) {
              return errorResponse(
                "error: task_id is required for list_reports.",
              );
            }
            const page = await client.reports.list({
              task_id: params.task_id,
              ...(params.report_type !== undefined && {
                type: params.report_type,
              }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "get_report": {
            const unused = rejectUnusedFields("get_report", params, [
              "action",
              "project",
              "project_id",
              "report_id",
            ]);
            if (unused) return unused;
            if (!params.report_id) {
              return errorResponse(
                "error: report_id is required for get_report.",
              );
            }
            return jsonResponse(
              await client.reports.retrieve(params.report_id),
            );
          }
        }
      } catch (error) {
        throwToolError("manage_tasks", params.action, error);
      }
    },
  );
}
