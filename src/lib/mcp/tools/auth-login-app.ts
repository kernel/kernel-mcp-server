import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MANAGED_AUTH_APP_HTML } from "@/lib/mcp/apps/generated/managed-auth-app";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  AuthLoginStartError,
  beginAuthLogin,
  type AuthLoginInput,
  toSafeAuthConnection,
  validateAuthLoginInput,
} from "@/lib/mcp/tools/managed-auth-state";
import { errorResponse } from "@/lib/mcp/responses";

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
  connection_id: z.string().optional(),
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
          const content: Array<{
            type: "text";
            text: string;
            annotations?: { audience: ["user"] };
          }> = [
            {
              type: "text",
              text: `Secure managed authentication is ${result.state === "already_authenticated" ? "already complete" : "ready"} for connection ${result.connection.id}. Expiry: ${result.connection.flow_expires_at ?? "not applicable"}. Do not claim success from this response. Immediately call manage_auth_connections with action=wait, id=${result.connection.id}, and wait_seconds=25; repeat while pending and continue only when it returns authenticated.`,
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
              required_flow_type: "REAUTH",
              ...(reauthConnection.status === "AUTHENTICATED" &&
                reauthConnection.flow_status !== "IN_PROGRESS" && {
                  previous_flow_expires_at: reauthConnection.flow_expires_at,
                }),
            }
          : {
              action: "wait",
              domain_filter: input.domain!,
              profile_name: input.profile_name!,
              wait_seconds: 25,
            };
        const appCapability = issueAppCapability(extra.authInfo.token);
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
            // MCP Apps structuredContent is delivered to the View but is not
            // added to model context. Claude currently strips tool-result
            // _meta from launcher notifications, so duplicate this short-lived,
            // API-token-bound capability here for host compatibility.
            app_capability: appCapability,
          },
          _meta: {
            auth_login_launcher: {
              app_capability: appCapability,
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
            // This helper is visibility:["app"] and cannot be called by the
            // model on compliant hosts. Duplicate App-private flow material
            // here because Claude may omit tool-result _meta.
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
        connection_id: z.string(),
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
        connection_id: z.string(),
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
