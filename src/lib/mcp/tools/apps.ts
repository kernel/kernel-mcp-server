import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorMessage,
  jsonResponse,
  paginatedJsonResponse,
  textResponse,
} from "@/lib/mcp/responses";

export function registerAppCapabilities(server: McpServer) {
  server.resource("apps", "apps://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
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

  registerJsonResourceTemplate(server, {
    name: "app",
    uriTemplate: "apps://{appName}",
    variableName: "appName",
    resourceLabel: "App",
    read: async (client, appName) => {
      const appsPage = await client.apps.list({ app_name: appName });
      return appsPage.getPaginatedItems()[0];
    },
  });

  // manage_apps -- List apps, invoke actions, manage deployments, check invocations
  server.tool(
    "manage_apps",
    'Manage Kernel apps, deployments, and invocations. Use "list_apps" to discover apps, "invoke" to execute an app action, "get_deployment"/"list_deployments" to check deployment status, "delete_deployment" to remove a deployment, or "get_invocation" to check action results.',
    {
      action: z
        .enum([
          "list_apps",
          "invoke",
          "get_deployment",
          "list_deployments",
          "delete_deployment",
          "get_invocation",
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
        .describe("(get_invocation) Invocation ID to retrieve.")
        .optional(),
      limit: z
        .number()
        .describe("(list_apps, list_deployments) Max results. Default 50.")
        .optional(),
      offset: z
        .number()
        .describe("(list_apps, list_deployments) Pagination offset. Default 0.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

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
            return paginatedJsonResponse(page, "No apps found");
          }
          case "invoke": {
            if (!params.app_name || !params.action_name) {
              return textResponse(
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
            if (!invocation) throw new Error("Failed to create invocation");

            const stream = await client.invocations.follow(invocation.id);
            let finalInvocation = invocation;
            for await (const evt of stream) {
              if (evt.event === "error") {
                return jsonResponse({
                  status: "error",
                  invocation_id: invocation.id,
                  error: evt,
                });
              }
              if (evt.event === "invocation_state") {
                finalInvocation = evt.invocation || finalInvocation;
                if (
                  finalInvocation.status === "succeeded" ||
                  finalInvocation.status === "failed"
                )
                  break;
              }
            }
            return jsonResponse(finalInvocation);
          }
          case "get_deployment": {
            if (!params.deployment_id)
              return textResponse("Error: deployment_id is required.");
            const deployment = await client.deployments.retrieve(
              params.deployment_id,
            );
            if (!deployment)
              return textResponse(
                `Deployment "${params.deployment_id}" not found`,
              );
            return jsonResponse(deployment);
          }
          case "list_deployments": {
            if (params.version && !params.app_name) {
              return textResponse(
                "Error: app_name is required when filtering deployments by version.",
              );
            }
            const page = await client.deployments.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.version && { app_version: params.version }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page, "No deployments found");
          }
          case "delete_deployment": {
            if (!params.deployment_id) {
              return textResponse(
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
              return textResponse("Error: invocation_id is required.");
            const invocation = await client.invocations.retrieve(
              params.invocation_id,
            );
            if (!invocation)
              return textResponse(
                `Invocation "${params.invocation_id}" not found`,
              );
            return jsonResponse(invocation);
          }
        }
      } catch (error) {
        return textResponse(
          `Error in manage_apps (${params.action}): ${errorMessage(error)}`,
        );
      }
    },
  );
}
