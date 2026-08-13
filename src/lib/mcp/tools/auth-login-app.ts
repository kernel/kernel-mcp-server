import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import { mcpAppsAuthSubject } from "@/lib/mcp-apps-marker";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  initializeDeclaresMcpApps,
  mcpAppsGateError,
  mcpTransportSessionId,
} from "@/lib/mcp/tools/mcp-apps-gate";
import {
  AuthLoginStartError,
  beginAuthLogin,
  type AuthLoginInput,
  hasLiveAuthFlow,
  issueAuthWaitCheckpoint,
  toSafeAuthConnection,
  validateAuthLoginInput,
} from "@/lib/mcp/tools/managed-auth-state";
import { managedAuthBrowserTelemetrySchema } from "@/lib/mcp/tools/managed-auth-telemetry";
import { errorResponse } from "@/lib/mcp/responses";
import {
  projectForOperation,
  projectSelectionInputSchema,
  type ProjectSelection,
} from "@/lib/mcp/project-selection";

type AuthLoginParams = AuthLoginInput & ProjectSelection;

export { initializeDeclaresMcpApps };

const MCP_APPS_GATE_DENIED_MESSAGE =
  "This tool is only available to the secure Kernel login App on MCP Apps-capable hosts and cannot be called by the model. Clients without MCP Apps can use manage_auth_connections create/login/get/submit/wait.";

export const MANAGED_AUTH_RESOURCE_URI =
  "ui://kernel/managed-auth-login-v10.html";
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

const authLoginInputSchema = () => ({
  ...projectSelectionInputSchema(),
  mode: z.enum(["new_login", "reauth"]),
  connection_id: z.string().min(1).optional(),
  domain: z.string().optional(),
  profile_name: z.string().optional(),
  save_credentials: z.boolean().optional(),
  record_session: z
    .boolean()
    .describe(
      "Record replay video for this managed-auth flow and make it the connection default for new connections. Defaults to true in the secure App.",
    )
    .default(true),
  browser_telemetry: managedAuthBrowserTelemetrySchema
    .describe(
      "Browser telemetry for this managed-auth flow and the connection default for new connections. Defaults to { enabled: true }, which captures the operational categories (control, connection, system, captcha).",
    )
    .default({ enabled: true }),
  proxy_id: z.string().min(1).optional(),
  proxy_name: z.string().min(1).optional(),
});

function waitAction(
  connectionId: string,
  flowCheckpoint: string,
  waitSeconds: number,
  project?: string,
) {
  return {
    tool: "manage_auth_connections" as const,
    arguments: {
      action: "wait" as const,
      id: connectionId,
      flow_checkpoint: flowCheckpoint,
      wait_seconds: waitSeconds,
      ...(project && { project }),
    },
  };
}

function inputFromParams(params: AuthLoginParams): AuthLoginInput {
  return {
    mode: params.mode,
    ...(params.connection_id && { connection_id: params.connection_id }),
    ...(params.domain && { domain: params.domain }),
    ...(params.profile_name && { profile_name: params.profile_name }),
    ...(params.save_credentials !== undefined && {
      save_credentials: params.save_credentials,
    }),
    record_session: params.record_session ?? true,
    browser_telemetry: params.browser_telemetry ?? { enabled: true },
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
        'Open Kernel\'s secure interactive login panel so the user can enter credentials and MFA without exposing them to the conversation. Use this when a user directly asks to log in/sign in, or after a protected browser task discovers authentication is needed and the user consents. A direct request to log in is already consent; do not ask again. First list manage_auth_connections for the exact domain across all pages. Reuse an authenticated connection, ask the user to choose only when multiple relevant accounts exist, or call this tool with mode="reauth" and connection_id for an existing connection that needs authentication. If none exists, call with mode="new_login", domain, and a concise stable profile_name derived from the service (for example "hacker-news") unless the user supplied one; do not ask solely for a profile name. Replay recording and default operational browser telemetry are enabled unless explicitly disabled with record_session=false or browser_telemetry={enabled:false}. This launcher never creates or starts a flow—the App does that only after the user clicks Continue. Immediately follow the returned next_action, repeat its read-only wait while pending, then resume the original task using the authenticated profile_name. Never ask for passwords, credentials, OTPs, or MFA values in chat.',
      inputSchema: authLoginInputSchema(),
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
      const project = projectForOperation(extra.authInfo, params);
      const input = inputFromParams(params);
      const validationError = validateAuthLoginInput(input);
      if (validationError) return errorResponse(`Error: ${validationError}`);
      const client = createKernelClient(extra.authInfo.token, project);

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
        const nextAction = reauthConnection
          ? waitAction(
              reauthConnection.id,
              await issueAuthWaitCheckpoint(
                client,
                reauthConnection.id,
                hasLiveAuthFlow(reauthConnection) ? "event" : "after",
              ),
              25,
              project,
            )
          : {
              tool: "manage_auth_connections" as const,
              arguments: {
                action: "wait" as const,
                domain_filter: input.domain!,
                profile_name: input.profile_name!,
                wait_seconds: 25,
                ...(project && { project }),
              },
            };
        const waitArguments = nextAction.arguments;
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
            next_action: nextAction,
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
      inputSchema: authLoginInputSchema(),
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
      const authExtra = extra.authInfo.extra as
        | { userId?: unknown }
        | undefined;
      const authSubject = mcpAppsAuthSubject({
        token: extra.authInfo.token,
        userId: typeof authExtra?.userId === "string" ? authExtra.userId : null,
      });
      const requestHeaders = (extra as { requestInfo?: { headers?: unknown } })
        .requestInfo?.headers;
      const gateError = await mcpAppsGateError(
        server,
        authSubject,
        mcpTransportSessionId(requestHeaders),
        MCP_APPS_GATE_DENIED_MESSAGE,
      );
      if (gateError) return errorResponse(gateError);
      const project = projectForOperation(extra.authInfo, params);
      const input = inputFromParams(params);
      const validationError = validateAuthLoginInput(input);
      if (validationError) return errorResponse(`Error: ${validationError}`);
      const client = createKernelClient(extra.authInfo.token, project);

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
            // The App forwards this exact server-issued wait action. It does
            // not infer flow identity or terminal state in the browser.
            ...(result.flow_checkpoint && {
              next_action: waitAction(
                result.connection.id,
                result.flow_checkpoint,
                5,
                project,
              ),
            }),
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
