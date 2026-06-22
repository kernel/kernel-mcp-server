import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { registerJsonResourceTemplate } from "@/lib/mcp/resource-templates";
import {
  errorResponse,
  jsonResponse,
  paginatedJsonResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";
import { paginationParams } from "@/lib/mcp/schemas";

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
    'Manage Kernel apps when an agent needs to discover deployed app actions, invoke an app, or inspect deployment/invocation state. Use "list_apps" before invoking an unknown app, "invoke" to run an action, and get/list actions to inspect results.',
    {
      action: z
        .enum([
          "list_apps",
          "invoke",
          "get_deployment",
          "list_deployments",
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
          "(list_apps, invoke) App version filter. Defaults to 'latest' for invoke.",
        )
        .optional(),
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
        .describe("(get_deployment) Deployment ID to retrieve.")
        .optional(),
      invocation_id: z
        .string()
        .describe("(get_invocation) Invocation ID to retrieve.")
        .optional(),
      ...paginationParams,
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

            const stream = await client.invocations.follow(invocation.id);
            let finalInvocation = invocation;
            for await (const evt of stream) {
              if (evt.event === "error") {
                return errorResponse(
                  JSON.stringify(
                    {
                      status: "error",
                      invocation_id: invocation.id,
                      error: evt,
                    },
                    null,
                    2,
                  ),
                );
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
            const page = await client.deployments.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            return paginatedJsonResponse(page);
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
        }
      } catch (error) {
        return toolErrorResponse("manage_apps", params.action, error);
      }
    },
  );
}
