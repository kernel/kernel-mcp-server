import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { hasMcpAppsClient } from "@/lib/redis";
import {
  AuthLoginStartError,
  beginAuthLogin,
  type AuthLoginInput,
  hasLiveAuthFlow,
  toSafeAuthConnection,
  validateAuthLoginInput,
} from "@/lib/mcp/tools/managed-auth-state";
import { errorResponse } from "@/lib/mcp/responses";

// MCP Apps (SEP-1865) extension identifier. Clients that render MCP Apps
// declare it in their initialize capabilities.
const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

// Sliding TTL for the Redis capability marker. Long enough that an active App
// never loses it mid-flow; refreshed on every gated call.
const MCP_APPS_MARKER_TTL_SECONDS = 24 * 60 * 60;

/**
 * Whether a JSON-RPC payload (single message or batch) is an initialize that
 * declares MCP Apps support. The route layer uses this to record the client
 * capability, because the stateless streamable-HTTP transport does not expose
 * it to later requests.
 */
export function initializeDeclaresMcpApps(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const request = message as {
      method?: unknown;
      params?: { capabilities?: { extensions?: Record<string, unknown> } };
    };
    return (
      request.method === "initialize" &&
      Boolean(request.params?.capabilities?.extensions?.[MCP_APPS_EXTENSION])
    );
  });
}

/**
 * App-only tools are hidden from the model via `_meta.ui.visibility`, but that
 * is a hint hosts without MCP Apps support are free to ignore. Fail closed:
 * only execute them when the connected client actually declared the MCP Apps
 * extension. Persistent transports (SSE) expose client capabilities directly;
 * on the stateless streamable-HTTP transport the route layer records the
 * declared capability per bearer token at initialize time.
 */
async function clientSupportsMcpApps(
  server: McpServer,
  authToken: string,
): Promise<boolean> {
  const capabilities = server.server.getClientCapabilities() as
    | { extensions?: Record<string, unknown> }
    | undefined;
  if (capabilities?.extensions?.[MCP_APPS_EXTENSION]) return true;
  try {
    return await hasMcpAppsClient({
      token: authToken,
      ttlSeconds: MCP_APPS_MARKER_TTL_SECONDS,
    });
  } catch (error) {
    console.error("MCP Apps capability check failed; failing closed:", error);
    return false;
  }
}

async function mcpAppsGateError(
  server: McpServer,
  authToken: string,
): Promise<string | null> {
  if (await clientSupportsMcpApps(server, authToken)) return null;
  return "This tool is only available to the secure Kernel login App on MCP Apps-capable hosts and cannot be called by the model. To authenticate without the App, call open_auth_login with text_only=true after the user confirms that no panel appeared.";
}

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

const APP_CAPABILITY_TTL_MS = 60 * 60 * 1000;

function appSigningSecret(): string {
  const secret =
    process.env.MCP_APP_SIGNING_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("MCP App signing secret is not configured");
  return secret;
}

function authTokenHash(authToken: string): string {
  return createHash("sha256").update(authToken).digest("base64url");
}

function issueAppCapability(authToken: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      auth: authTokenHash(authToken),
      exp: Date.now() + APP_CAPABILITY_TTL_MS,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", appSigningSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function validAppCapability(capability: string, authToken: string): boolean {
  const [payload, signature, extra] = capability.split(".");
  if (!payload || !signature || extra) return false;
  const expected = createHmac("sha256", appSigningSecret())
    .update(payload)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      auth?: unknown;
      exp?: unknown;
    };
    return (
      claims.auth === authTokenHash(authToken) &&
      typeof claims.exp === "number" &&
      claims.exp > Date.now()
    );
  } catch {
    return false;
  }
}

const authLoginInputSchema = {
  mode: z.enum(["new_login", "reauth"]),
  connection_id: z.string().min(1).optional(),
  domain: z.string().optional(),
  profile_name: z.string().optional(),
  save_credentials: z.boolean().optional(),
  proxy_id: z.string().optional(),
  proxy_name: z.string().optional(),
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
        // The delete authorization capability is App-only: issue it solely to
        // hosts that declared MCP Apps support, and keep it in _meta (which
        // hosts do not add to model context). It never goes in
        // structuredContent, which non-Apps hosts may surface to the model.
        const appCapability = (await clientSupportsMcpApps(
          server,
          extra.authInfo.token,
        ))
          ? issueAppCapability(extra.authInfo.token)
          : null;
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
          ...(appCapability && {
            _meta: {
              auth_login_launcher: {
                app_capability: appCapability,
              },
            },
          }),
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
      const gateError = await mcpAppsGateError(server, extra.authInfo.token);
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
      const gateError = await mcpAppsGateError(server, extra.authInfo.token);
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

  server.registerTool(
    "delete_auth_login_connection",
    {
      title: "Delete managed-auth connection (app-only)",
      description:
        "Delete the managed-auth connection created by the secure App, including QA cleanup.",
      inputSchema: {
        connection_id: z.string().min(1),
        app_capability: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const gateError = await mcpAppsGateError(server, extra.authInfo.token);
      if (gateError) return errorResponse(gateError);
      if (!validAppCapability(params.app_capability, extra.authInfo.token)) {
        return errorResponse("Secure App authorization is invalid or expired.");
      }
      const client = createKernelClient(extra.authInfo.token);
      try {
        await client.auth.connections.delete(params.connection_id);
        return {
          content: [
            {
              type: "text" as const,
              text: "Managed-auth connection deleted.",
            },
          ],
        };
      } catch {
        return errorResponse("Managed-auth connection could not be deleted.");
      }
    },
  );
}
