import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import {
  registerJsonResourceCollection,
  registerJsonResourceTemplate,
} from "@/lib/mcp/resource-templates";
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

export function registerAppCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  registerJsonResourceCollection(
    server,
    {
      name: "apps",
      uriTemplate: "kernel://orgs/{organizationId}/projects/{projectId}/apps",
      emptyText: "no apps found",
      read: async (client) => {
        const apps = [];
        for await (const app of client.apps.list()) {
          apps.push(app);
        }
        return apps;
      },
    },
    dependencies,
  );

  registerJsonResourceTemplate(
    server,
    {
      name: "app",
      uriTemplate:
        "kernel://orgs/{organizationId}/projects/{projectId}/apps/{appName}",
      variableName: "appName",
      resourceLabel: "app",
      read: async (client, appName) => {
        const appsPage = await client.apps.list({ app_name: appName });
        return appsPage.getPaginatedItems()[0];
      },
    },
    dependencies,
  );

  // manage_apps -- List apps, invoke actions, manage deployments, check invocations
  server.registerTool(
    "manage_apps",
    {
      description:
        'manage KERNEL apps when an agent needs to discover deployed app actions, invoke an app, or inspect deployment/invocation state. use "list_apps" before invoking an unknown app. "invoke" starts an action asynchronously and returns an invocation_id immediately. use "list_invocation_browsers" with that id to discover browser sessions created by the invocation, and use "get_invocation" after a short delay to inspect its state. do not poll indefinitely; if the invocation is still running, report its id. use get/list actions to inspect results and "delete_deployment" to remove a deployment.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum([
            "list_apps",
            "invoke",
            "get_deployment",
            "list_deployments",
            "delete_deployment",
            "get_invocation",
            "list_invocation_browsers",
          ])
          .describe("operation to perform."),
        app_name: z
          .string()
          .describe(
            "(list_apps, invoke, list_deployments) app name filter or target.",
          )
          .optional(),
        version: z
          .string()
          .describe(
            "(list_apps, invoke, list_deployments) app version filter. defaults to 'latest' for invoke. deployment version filtering requires app_name.",
          )
          .optional(),
        query: z
          .string()
          .describe("(list_apps) search apps by name.")
          .optional(),
        action_name: z
          .string()
          .describe("(invoke) action to execute within the app.")
          .optional(),
        payload: z
          .string()
          .describe("(invoke) json string with action parameters.")
          .optional(),
        deployment_id: z
          .string()
          .describe("(get_deployment, delete_deployment) deployment id.")
          .optional(),
        invocation_id: z
          .string()
          .describe(
            "(get_invocation, list_invocation_browsers) invocation id to inspect.",
          )
          .optional(),
        ...paginationParams,
      }),
      annotations: {
        title: "manage KERNEL apps and invocations",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
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
          case "list_apps": {
            const page = await client.apps.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.version && { version: params.version }),
              ...(params.query && { query: params.query }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "invoke": {
            if (!params.app_name || !params.action_name) {
              return errorResponse(
                "error: app_name and action_name are required for invoke.",
              );
            }
            const invocation = await client.invocations.create({
              app_name: params.app_name,
              action_name: params.action_name,
              payload: params.payload,
              version: params.version ?? "latest",
              async: true,
            });
            if (!invocation)
              return errorResponse("failed to create invocation");

            return jsonResponse({
              ...invocation,
              invocation_id: invocation.id,
            });
          }
          case "get_deployment": {
            if (!params.deployment_id)
              return errorResponse("error: deployment_id is required.");
            const deployment = await client.deployments.retrieve(
              params.deployment_id,
            );
            if (!deployment)
              return errorResponse(
                `deployment "${params.deployment_id}" not found`,
              );
            return jsonResponse(deployment);
          }
          case "list_deployments": {
            if (params.version && !params.app_name) {
              return errorResponse(
                "error: app_name is required when filtering deployments by version.",
              );
            }
            const page = await client.deployments.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.version && { app_version: params.version }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
          }
          case "delete_deployment": {
            if (!params.deployment_id) {
              return errorResponse(
                "error: deployment_id is required for delete_deployment.",
              );
            }
            await client.deployments.delete(params.deployment_id);
            return textResponse(
              `deployment "${params.deployment_id}" deleted successfully.`,
            );
          }
          case "get_invocation": {
            if (!params.invocation_id)
              return errorResponse("error: invocation_id is required.");
            const invocation = await client.invocations.retrieve(
              params.invocation_id,
            );
            if (!invocation)
              return errorResponse(
                `invocation "${params.invocation_id}" not found`,
              );
            return jsonResponse(invocation);
          }
          case "list_invocation_browsers": {
            if (!params.invocation_id)
              return errorResponse("error: invocation_id is required.");
            const browsers = await client.invocations.listBrowsers(
              params.invocation_id,
            );
            return jsonResponse({
              browsers: browsers.browsers.map((browser) => ({
                session_id: browser.session_id,
                browser_live_view_url: browser.browser_live_view_url,
              })),
            });
          }
        }
      } catch (error) {
        throwToolError("manage_apps", params.action, error);
      }
    },
  );
}
