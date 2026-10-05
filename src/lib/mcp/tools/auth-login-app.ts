import type { McpServer } from "@modelcontextprotocol/server";
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
  DEPRECATED_TOOL_PARAMS,
  deprecatedParamConflict,
} from "@/lib/mcp/deprecated-params";
import { proxyConfigSchema } from "@/lib/mcp/proxy-config";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

type AuthLoginParams = z.infer<ReturnType<typeof authLoginInputSchema>>;

export { initializeDeclaresMcpApps };

const MCP_APPS_GATE_DENIED_MESSAGE =
  "this tool is only available to the secure KERNEL login app on mcp apps-capable hosts and cannot be called by the model. clients without mcp apps can use manage_auth_connections create/login/get/submit/wait.";

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

const authLoginInputSchema = () =>
  z.object({
    ...projectSelectionInputSchema(),
    mode: z.enum(["new_login", "reauth"]),
    connection_id: z.string().min(1).optional(),
    domain: z.string().optional(),
    profile_name: z.string().optional(),
    save_credentials: z.boolean().optional(),
    record_session: z
      .boolean()
      .describe(
        "record replay video for this managed-auth flow and make it the connection default for new connections. defaults to true in the secure app.",
      )
      .default(true),
    browser: z
      .object({
        proxy: proxyConfigSchema()
          .describe(
            "proxy egress, set with exactly one of id, name, or mode. id or name selects that proxy; mode direct forces direct egress; mode default restores the default egress.",
          )
          .optional(),
        region: z
          .enum(["us-east", "eu-west", "ap-southeast"])
          .describe("region for the managed-auth browser session.")
          .optional(),
        stealth: z
          .boolean()
          .describe(
            "whether the managed-auth browser session uses site-compatibility settings. defaults to true for a new login; omitted on reauth inherits the connection setting.",
          )
          .optional(),
        telemetry: managedAuthBrowserTelemetrySchema
          .describe(
            "defaults to { enabled: true }, which captures the operational categories (control, connection, system, captcha).",
          )
          .optional(),
      })
      .describe(
        "browser settings for this managed-auth flow. they become the connection defaults for a new login or override them for this reauth. cannot be combined with browser_telemetry, region, proxy_id, or proxy_name.",
      )
      .optional(),
    browser_telemetry: managedAuthBrowserTelemetrySchema
      .describe(
        "deprecated: use `browser.telemetry` instead. browser telemetry for this managed-auth flow and the connection default for new connections. defaults to { enabled: true }, which captures the operational categories (control, connection, system, captcha).",
      )
      .optional(),
    region: z
      .enum(["us-east", "eu-west", "ap-southeast"])
      .describe(
        "deprecated: use `browser.region` instead. region for the managed-auth browser session. sets the connection default for a new login or overrides it for this reauth.",
      )
      .optional(),
    proxy_id: z
      .string()
      .min(1)
      .describe("deprecated: use `browser.proxy.id` instead.")
      .optional(),
    proxy_name: z
      .string()
      .min(1)
      .describe("deprecated: use `browser.proxy.name` instead.")
      .optional(),
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

function browserParamConflict(params: AuthLoginParams) {
  return params.browser
    ? deprecatedParamConflict(
        "browser",
        params,
        DEPRECATED_TOOL_PARAMS.open_auth_login,
      )
    : undefined;
}

function inputFromParams(params: AuthLoginParams): AuthLoginInput {
  const { browser } = params;
  const telemetry = browser ? browser.telemetry : params.browser_telemetry;
  const region = browser ? browser.region : params.region;
  const stealth = browser?.stealth;
  const proxy = browser
    ? browser.proxy
    : params.proxy_id || params.proxy_name
      ? {
          ...(params.proxy_id && { id: params.proxy_id }),
          ...(params.proxy_name && { name: params.proxy_name }),
        }
      : undefined;
  return {
    mode: params.mode,
    ...(params.connection_id && { connection_id: params.connection_id }),
    ...(params.domain && { domain: params.domain }),
    ...(params.profile_name && { profile_name: params.profile_name }),
    ...(params.save_credentials !== undefined && {
      save_credentials: params.save_credentials,
    }),
    record_session: params.record_session ?? true,
    browser_telemetry: telemetry ?? { enabled: true },
    ...(region && { region }),
    ...(stealth !== undefined && { stealth }),
    ...(proxy && { proxy }),
  };
}

export function registerAuthLoginApp(server: McpServer) {
  const resourceMeta = managedAuthResourceMeta();

  server.registerResource(
    "kernel-managed-auth-login",
    MANAGED_AUTH_RESOURCE_URI,
    {
      title: "KERNEL managed authentication",
      description:
        "secure interactive KERNEL login panel. credentials and mfa stay inside the panel and never enter the mcp conversation.",
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
      title: "open secure managed-auth login",
      description:
        'open KERNEL\'s secure interactive login panel so the user can enter credentials and mfa without exposing them to the conversation. use this when a user directly asks to log in/sign in, or after a protected browser task discovers authentication is needed and the user consents. a direct request to log in is already consent; do not ask again. first list manage_auth_connections for the exact domain across all pages. reuse an authenticated connection, ask the user to choose only when multiple relevant accounts exist, or call this tool with mode="reauth" and connection_id for an existing connection that needs authentication. if none exists, call with mode="new_login", domain, and a concise stable profile_name derived from the service (for example "hacker-news") unless the user supplied one; do not ask solely for a profile name. replay recording and default operational browser telemetry are enabled unless explicitly disabled with record_session=false or browser_telemetry={enabled:false}. this launcher never creates or starts a flow—the app does that only after the user clicks continue. immediately follow the returned next_action, repeat its read-only wait while pending, then resume the original task using the authenticated profile_name. never ask for passwords, credentials, otps, or mfa values in chat.',
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
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const project = projectForOperation(ctx.http.authInfo, params);
      const conflict = browserParamConflict(params);
      if (conflict) return errorResponse(`error: ${conflict}`);
      const input = inputFromParams(params);
      const validationError = validateAuthLoginInput(input);
      if (validationError) return errorResponse(`error: ${validationError}`);
      const client = createKernelClient(ctx.http.authInfo.token, project);

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
              text: `a secure KERNEL login panel was requested. do not claim that it rendered or that authentication succeeded. never ask for credentials in conversation. immediately call manage_auth_connections with ${JSON.stringify(waitArguments)}. while it returns state=pending, call it again with the same arguments instead of asking the user to report completion. continue the pending task only after it returns state=authenticated.`,
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
            : "managed authentication could not be prepared. retry the secure login flow.",
        );
      }
    },
  );

  server.registerTool(
    "begin_auth_login",
    {
      title: "begin secure managed authentication (app-only)",
      description:
        "start or resume the secure managed-auth flow after the app user clicks continue.",
      inputSchema: authLoginInputSchema(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const authExtra = ctx.http.authInfo.extra as
        | { userId?: unknown }
        | undefined;
      const authSubject = mcpAppsAuthSubject({
        token: ctx.http.authInfo.token,
        userId: typeof authExtra?.userId === "string" ? authExtra.userId : null,
      });
      const gateError = await mcpAppsGateError(
        server,
        authSubject,
        mcpTransportSessionId(ctx.http?.req?.headers),
        MCP_APPS_GATE_DENIED_MESSAGE,
        ctx,
      );
      if (gateError) return errorResponse(gateError);
      const project = projectForOperation(ctx.http.authInfo, params);
      const conflict = browserParamConflict(params);
      if (conflict) return errorResponse(`error: ${conflict}`);
      const input = inputFromParams(params);
      const validationError = validateAuthLoginInput(input);
      if (validationError) return errorResponse(`error: ${validationError}`);
      const client = createKernelClient(ctx.http.authInfo.token, project);

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
              text: "secure managed authentication is ready.",
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
            : "managed authentication could not start. close the panel and retry.",
        );
      }
    },
  );
}
