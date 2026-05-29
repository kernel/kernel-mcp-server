import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";

export function registerAppCapabilities(server: McpServer) {
  server.resource("apps", "apps://", async (uri, extra) => {
    if (!extra.authInfo) {
      throw new Error("Authentication required");
    }

    const client = createKernelClient(extra.authInfo.token);
    const uriString = uri.toString();

    if (uriString === "apps://") {
      // List all apps
      const appsPage = await client.apps.list();
      const items = appsPage.getPaginatedItems();
      return {
        contents: [
          {
            uri: "apps://",
            mimeType: "application/json",
            text:
              items.length > 0
                ? JSON.stringify(items, null, 2)
                : "No apps found",
          },
        ],
      };
    } else if (uriString.startsWith("apps://")) {
      // Get specific app by name
      const appName = uriString.replace("apps://", "");
      const appsPage = await client.apps.list({ app_name: appName });
      const app = appsPage.getPaginatedItems()[0];

      if (!app) {
        throw new Error(`App "${appName}" not found`);
      }

      return {
        contents: [
          {
            uri: uriString,
            mimeType: "application/json",
            text: JSON.stringify(app, null, 2),
          },
        ],
      };
    }

    throw new Error(`Invalid app URI: ${uriString}`);
  });

  // manage_apps -- List apps, invoke actions, manage deployments, check invocations
  server.tool(
    "manage_apps",
    'Manage Kernel apps, deployments, and invocations. Use "list_apps" to discover apps, "invoke" to execute an app action, "get_deployment"/"list_deployments" to check deployment status, or "get_invocation" to check action results.',
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
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page.getPaginatedItems();
            return {
              content: [
                {
                  type: "text",
                  text:
                    items.length > 0
                      ? JSON.stringify(
                          {
                            items,
                            has_more: page.has_more,
                            next_offset: page.next_offset,
                          },
                          null,
                          2,
                        )
                      : "No apps found",
                },
              ],
            };
          }
          case "invoke": {
            if (!params.app_name || !params.action_name) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: app_name and action_name are required for invoke.",
                  },
                ],
              };
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
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          status: "error",
                          invocation_id: invocation.id,
                          error: evt,
                        },
                        null,
                        2,
                      ),
                    },
                  ],
                };
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
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(finalInvocation, null, 2),
                },
              ],
            };
          }
          case "get_deployment": {
            if (!params.deployment_id)
              return {
                content: [
                  { type: "text", text: "Error: deployment_id is required." },
                ],
              };
            const deployment = await client.deployments.retrieve(
              params.deployment_id,
            );
            if (!deployment)
              return {
                content: [
                  {
                    type: "text",
                    text: `Deployment "${params.deployment_id}" not found`,
                  },
                ],
              };
            return {
              content: [
                { type: "text", text: JSON.stringify(deployment, null, 2) },
              ],
            };
          }
          case "list_deployments": {
            const page = await client.deployments.list({
              ...(params.app_name && { app_name: params.app_name }),
              ...(params.limit !== undefined && { limit: params.limit }),
              ...(params.offset !== undefined && { offset: params.offset }),
            });
            const items = page.getPaginatedItems();
            return {
              content: [
                {
                  type: "text",
                  text:
                    items.length > 0
                      ? JSON.stringify(
                          {
                            items,
                            has_more: page.has_more,
                            next_offset: page.next_offset,
                          },
                          null,
                          2,
                        )
                      : "No deployments found",
                },
              ],
            };
          }
          case "get_invocation": {
            if (!params.invocation_id)
              return {
                content: [
                  { type: "text", text: "Error: invocation_id is required." },
                ],
              };
            const invocation = await client.invocations.retrieve(
              params.invocation_id,
            );
            if (!invocation)
              return {
                content: [
                  {
                    type: "text",
                    text: `Invocation "${params.invocation_id}" not found`,
                  },
                ],
              };
            return {
              content: [
                { type: "text", text: JSON.stringify(invocation, null, 2) },
              ],
            };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in manage_apps (${params.action}): ${error}`,
            },
          ],
        };
      }
    },
  );
}
