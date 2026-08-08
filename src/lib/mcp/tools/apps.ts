import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultMcpDependencies,
  type McpDependencies,
} from "@/lib/mcp/dependencies";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

const invocationPolling = {
  interval_seconds: 5,
  max_attempts: 60,
} as const;

export function registerAppCapabilities(
  server: McpServer,
  dependencies: McpDependencies = defaultMcpDependencies,
) {
  server.resource("apps", "apps://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = dependencies.createKernelClient(extra.authInfo.token);
    const appsPage = await client.apps.list();
    const items = appsPage.getPaginatedItems();
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text:
            items.length > 0 ? JSON.stringify(items, null, 2) : "No apps found",
        },
      ],
    };
  });

  registerJsonResourceTemplate(
    server,
    {
      name: "app",
      uriTemplate: "apps://{appName}",
      variableName: "appName",
      resourceLabel: "App",
      read: async (client, appName) => {
        const appsPage = await client.apps.list({ app_name: appName });
        return appsPage.getPaginatedItems()[0];
      },
    },
    dependencies,
  );

  // manage_apps -- List apps, invoke actions, manage deployments, check invocations
  server.tool(
    "manage_apps",
    'Manage Kernel apps when an agent needs to discover deployed app actions, invoke an app, or inspect deployment/invocation state. Use "list_apps" before invoking an unknown app. "invoke" starts an action asynchronously and returns an invocation_id immediately. Use "list_invocation_browsers" with that ID to discover browser sessions created by the invocation, and follow the returned polling interval and attempt limit with "get_invocation". If the invocation is still running, report its ID instead of continuing indefinitely. Use get/list actions to inspect results and "delete_deployment" to remove a deployment.',
    {
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
        .describe("Operation to perform."),
      app_name: z
        .string()
        .describe(
          "(list_apps, invoke, list_deployments) App name filter or target.",
        )
        .optional(),
      version: z
        .string()
        .describe(
          "(list_apps, invoke, list_deployments) App version filter. Defaults to 'latest' for invoke. Deployment version filtering requires app_name.",
        )
        .optional(),
      query: z.string().describe("(list_apps) Search apps by name.").optional(),
      action_name: z
        .string()
        .describe("(invoke) Action to execute within the app.")
        .optional(),
      payload: z
        .string()
        .describe("(invoke) JSON string with action parameters.")
        .optional(),
      deployment_id: z
        .string()
        .describe("(get_deployment, delete_deployment) Deployment ID.")
        .optional(),
      invocation_id: z
        .string()
        .describe(
          "(get_invocation, list_invocation_browsers) Invocation ID to inspect.",
        )
        .optional(),
      ...paginationParams,
    },
    {
      title: "Manage Kernel apps and invocations",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = dependencies.createKernelClient(extra.authInfo.token);

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
                "Error: app_name and action_name are required for invoke.",
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
              return errorResponse("Failed to create invocation");

            return jsonResponse({
              ...invocation,
              invocation_id: invocation.id,
              next_action: {
                action: "get_invocation",
                invocation_id: invocation.id,
              },
              browser_action: {
                action: "list_invocation_browsers",
                invocation_id: invocation.id,
              },
              polling: invocationPolling,
            });
          }
          case "get_deployment": {
            if (!params.deployment_id)
              return errorResponse("Error: deployment_id is required.");
            const deployment = await client.deployments.retrieve(
              params.deployment_id,
            );
            if (!deployment)
              return errorResponse(
                `Deployment "${params.deployment_id}" not found`,
              );
            return jsonResponse(deployment);
          }
          case "list_deployments": {
            if (params.version && !params.app_name) {
              return errorResponse(
                "Error: app_name is required when filtering deployments by version.",
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
                "Error: deployment_id is required for delete_deployment.",
              );
            }
            await client.deployments.delete(params.deployment_id);
            return textResponse(
              `Deployment "${params.deployment_id}" deleted successfully.`,
            );
          }
          case "get_invocation": {
            if (!params.invocation_id)
              return errorResponse("Error: invocation_id is required.");
            const invocation = await client.invocations.retrieve(
              params.invocation_id,
            );
            if (!invocation)
              return errorResponse(
                `Invocation "${params.invocation_id}" not found`,
              );
            return jsonResponse(invocation);
          }
          case "list_invocation_browsers": {
            if (!params.invocation_id)
              return errorResponse("Error: invocation_id is required.");
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
