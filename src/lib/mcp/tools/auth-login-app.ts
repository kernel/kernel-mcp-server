import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import { createKernelClient } from "@/lib/mcp/kernel-client";
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
  "This tool is only available to the secure Kernel login App on MCP Apps-capable hosts and cannot be called by the model. To authenticate without the App, call open_auth_login with text_only=true after the user confirms that no panel appeared.";

export const MANAGED_AUTH_RESOURCE_URI =
  "ui://kernel/managed-auth-login-v7.html";
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
        'Display a secure Kernel login panel after the user consents. Before calling: use manage_auth_connections(action="list", domain_filter=...) across all pages, reason about the result, and ask the user which profile to use if needed. Never ask for passwords, credentials, OTPs, or MFA values in conversation. The user enters them only in the panel. Immediately follow this tool result\'s next_action and repeat its read-only wait while pending; continue only when it returns authenticated. This call does not create or start a flow until the user clicks Continue. Use text_only=true only after the user confirms no App appeared; that compatibility fallback exposes a capability-bearing hosted URL as user-audience text.',
      inputSchema: {
        ...authLoginInputSchema,
        text_only: z.boolean().default(false),
      },
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
        if (params.text_only) {
          const result = await beginAuthLogin(client, input);
          // Guard the wait with the pre-flow baseline captured by begin so a
          // completed flow from before this call is never accepted as the new
          // one. When begin only observes an already-live flow, the wait
          // tracks that flow directly (a live in-progress flow reads as
          // pending even on an AUTHENTICATED connection).
          const waitArguments: Record<string, unknown> = {
            action: "wait",
            id: result.connection.id,
            wait_seconds: 25,
            ...(result.started_new_flow && {
              previous_flow_expires_at: result.previous_flow_expires_at,
            }),
          };
          const content: Array<{
            type: "text";
            text: string;
            annotations?: { audience: ["user"] };
          }> = [
            {
              type: "text",
              text: `Secure managed authentication is ${result.state === "already_authenticated" ? "already complete" : "ready"} for connection ${result.connection.id}. Expiry: ${result.connection.flow_expires_at ?? "not applicable"}. Do not claim success from this response. Immediately call manage_auth_connections with ${JSON.stringify(waitArguments)}; repeat with the same arguments while it returns state=pending and continue only when it returns state=authenticated.`,
            },
          ];
          if (result.hosted_url) {
            content.push({
              type: "text",
              text: result.hosted_url,
              annotations: { audience: ["user"] },
            });
          }
          return {
            content,
            structuredContent: {
              kind: "kernel.managed_auth.text_fallback",
              version: 1,
              connection_id: result.connection.id,
              flow_expires_at: result.connection.flow_expires_at,
              state: result.state,
            },
          };
        }

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
            text_only: false,
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

  server.registerTool(
    "get_auth_login_status",
    {
      title: "Get managed-auth login status (app-only)",
      description:
        "Read sanitized managed-auth status for the secure login App.",
      inputSchema: {
        connection_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
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
      const client = createKernelClient(extra.authInfo.token);
      try {
        const connection = toSafeAuthConnection(
          await client.auth.connections.retrieve(params.connection_id),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: "Managed authentication status refreshed.",
            },
          ],
          structuredContent: {
            kind: "kernel.managed_auth.status",
            version: 1,
            connection,
          },
        };
      } catch {
        return errorResponse(
          "Managed authentication status could not be refreshed. Retry shortly.",
        );
      }
    },
  );
}
