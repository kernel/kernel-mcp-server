import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import { createKernelClient, type KernelClient } from "@/lib/mcp/kernel-client";
import {
  initializeDeclaresMcpApps,
  mcpAppsGateError,
} from "@/lib/mcp/tools/mcp-apps-gate";
import {
  AuthLoginStartError,
  beginAuthLogin,
  type AuthLoginInput,
  hasLiveAuthFlow,
  toSafeAuthConnection,
  validateAuthLoginInput,
} from "@/lib/mcp/tools/managed-auth-state";
import { errorResponse } from "@/lib/mcp/responses";

export { initializeDeclaresMcpApps };

const MCP_APPS_GATE_DENIED_MESSAGE =
  "This tool is only available to the secure Kernel login App on MCP Apps-capable hosts and cannot be called by the model. Clients without MCP Apps can use manage_auth_connections create/login/get/submit/wait.";

export const MANAGED_AUTH_RESOURCE_URI =
  "ui://kernel/managed-auth-login-v8.html";
export const MANAGED_AUTH_MIME_TYPE = "text/html;profile=mcp-app";

export function managedAuthAppOrigin(): string {
  const configured =
    process.env.MANAGED_AUTH_APP_ORIGIN ?? "https://mcp.onkernel.com";
  return new URL(configured).origin;
}

export function managedAuthResourceMeta() {
  return {
    ui: {
      prefersBorder: true,
      csp: {
        connectDomains: [managedAuthAppOrigin()],
      },
    },
  };
}

const authLoginInputSchema = {
  mode: z.enum(["new_login", "reauth"]),
  connection_id: z.string().min(1).optional(),
  domain: z.string().optional(),
  profile_name: z.string().optional(),
  save_credentials: z.boolean().optional(),
  proxy_id: z.string().min(1).optional(),
  proxy_name: z.string().min(1).optional(),
};

async function authFlowWaitBaseline(
  client: KernelClient,
  connectionId: string,
): Promise<{ eventId?: string; startedAt: string } | undefined> {
  try {
    const page = await client.auth.connections.timeline(connectionId, {
      limit: 10,
    });
    const eventId = page
      .getPaginatedItems()
      .find((event) => event.type === "login" || event.type === "reauth")?.id;
    return {
      ...(eventId && { eventId }),
      startedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

function inputFromParams(params: AuthLoginInput): AuthLoginInput {
  return {
    mode: params.mode,
    ...(params.connection_id && { connection_id: params.connection_id }),
    ...(params.domain && { domain: params.domain }),
    ...(params.profile_name && { profile_name: params.profile_name }),
    ...(params.save_credentials !== undefined && {
      save_credentials: params.save_credentials,
    }),
    ...(params.proxy_id && { proxy_id: params.proxy_id }),
    ...(params.proxy_name && { proxy_name: params.proxy_name }),
  };
}

export function registerAuthLoginApp(server: McpServer) {
  const resourceMeta = managedAuthResourceMeta();

  server.registerResource(
    "kernel-managed-auth-login",
    MANAGED_AUTH_RESOURCE_URI,
    {
      title: "Kernel Managed Authentication",
      description:
        "Secure interactive Kernel login panel. Credentials and MFA stay inside the panel and never enter the MCP conversation.",
      mimeType: MANAGED_AUTH_MIME_TYPE,
      _meta: resourceMeta,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: MANAGED_AUTH_MIME_TYPE,
          text: MANAGED_AUTH_APP_HTML,
          _meta: resourceMeta,
        },
      ],
    }),
  );

  server.registerTool(
    "open_auth_login",
    {
      title: "Open secure managed-auth login",
      description:
        'Open Kernel\'s secure interactive login panel so the user can enter credentials and MFA without exposing them to the conversation. Use this when a user directly asks to log in/sign in, or after a protected browser task discovers authentication is needed and the user consents. A direct request to log in is already consent; do not ask again. First list manage_auth_connections for the exact domain across all pages. Reuse an authenticated connection, ask the user to choose only when multiple relevant accounts exist, or call this tool with mode="reauth" and connection_id for an existing connection that needs authentication. If none exists, call with mode="new_login", domain, and a concise stable profile_name derived from the service (for example "hacker-news") unless the user supplied one; do not ask solely for a profile name. This launcher never creates or starts a flow—the App does that only after the user clicks Continue. Immediately follow the returned next_action, repeat its read-only wait while pending, then resume the original task using the authenticated profile_name. Never ask for passwords, credentials, OTPs, or MFA values in chat.',
      inputSchema: authLoginInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: {
        ui: {
          resourceUri: MANAGED_AUTH_RESOURCE_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": MANAGED_AUTH_RESOURCE_URI,
      },
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const input = inputFromParams(params);
      const validationError = validateAuthLoginInput(input);
      if (validationError) return errorResponse(`Error: ${validationError}`);
      const client = createKernelClient(extra.authInfo.token);

      try {
        const reauthConnection =
          input.mode === "reauth"
            ? toSafeAuthConnection(
                await client.auth.connections.retrieve(input.connection_id!),
              )
            : null;
        const connection = reauthConnection ?? {
          domain: input.domain!,
          profile_name: input.profile_name!,
        };
        const flowWaitBaseline =
          reauthConnection && !hasLiveAuthFlow(reauthConnection)
            ? await authFlowWaitBaseline(client, reauthConnection.id)
            : undefined;
        const waitArguments = reauthConnection
          ? {
              action: "wait",
              id: input.connection_id!,
              wait_seconds: 25,
              // The server chooses LOGIN vs REAUTH when the flow starts, so
              // never guess a required flow type here. Guard on the pre-flow
              // baseline instead. When a flow is already live the wait simply
              // observes that flow, so no baseline is needed.
              ...(!hasLiveAuthFlow(reauthConnection) && {
                previous_flow_expires_at: reauthConnection.flow_expires_at,
                ...(flowWaitBaseline && {
                  ...(flowWaitBaseline.eventId && {
                    previous_flow_event_id: flowWaitBaseline.eventId,
                  }),
                  flow_wait_started_at: flowWaitBaseline.startedAt,
                }),
              }),
            }
          : {
              action: "wait",
              domain_filter: input.domain!,
              profile_name: input.profile_name!,
              wait_seconds: 25,
            };
        return {
          content: [
            {
              type: "text" as const,
              text: `A secure Kernel login panel was requested. Do not claim that it rendered or that authentication succeeded. Never ask for credentials in conversation. Immediately call manage_auth_connections with ${JSON.stringify(waitArguments)}. While it returns state=pending, call it again with the same arguments instead of asking the user to report completion. Continue the pending task only after it returns state=authenticated.`,
            },
          ],
          structuredContent: {
            kind: "kernel.managed_auth.launcher",
            version: 1,
            mode: input.mode,
            connection,
            next_action: {
              tool: "manage_auth_connections",
              arguments: waitArguments,
            },
          },
        };
      } catch (error) {
        return errorResponse(
          error instanceof AuthLoginStartError
            ? error.safeMessage
            : "Managed authentication could not be prepared. Retry the secure login flow.",
        );
      }
    },
  );

  server.registerTool(
    "begin_auth_login",
    {
      title: "Begin secure managed authentication (app-only)",
      description:
        "Start or resume the secure managed-auth flow after the App user clicks Continue.",
      inputSchema: authLoginInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const gateError = await mcpAppsGateError(
        server,
        extra.authInfo.token,
        MCP_APPS_GATE_DENIED_MESSAGE,
      );
      if (gateError) return errorResponse(gateError);
      const input = inputFromParams(params);
      const validationError = validateAuthLoginInput(input);
      if (validationError) return errorResponse(`Error: ${validationError}`);
      const client = createKernelClient(extra.authInfo.token);

      try {
        const result = await beginAuthLogin(client, input);
        const appPrivate = {
          ...(result.handoff_code && {
            handoff_code: result.handoff_code,
          }),
          ...(result.hosted_url && { hosted_url: result.hosted_url }),
          relay_base_url: `${managedAuthAppOrigin()}/managed-auth-proxy`,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: "Secure managed authentication is ready.",
            },
          ],
          structuredContent: {
            kind: "kernel.managed_auth.begin",
            version: 1,
            state: result.state,
            connection: result.connection,
            started_new_flow: result.started_new_flow,
            resume_id: result.resume_id,
            // Baseline the App adds to its wait polling once a new flow has
            // started, so a terminal state from before this begin is never
            // mistaken for the new flow's outcome.
            previous_flow_expires_at: result.previous_flow_expires_at,
            // Execution is gated on the client's MCP Apps capability, so
            // this result only reaches hosts that deliver visibility:["app"]
            // tool results to the View rather than the model. The
            // structuredContent duplicate exists because Claude may omit
            // tool-result _meta.
            app_private: appPrivate,
          },
          _meta: {
            auth_login: appPrivate,
          },
        };
      } catch (error) {
        return errorResponse(
          error instanceof AuthLoginStartError
            ? error.safeMessage
            : "Managed authentication could not start. Close the panel and retry.",
        );
      }
    },
  );
}
