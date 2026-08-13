import { expect } from "bun:test";
import { projectScopedAuthInfo } from "@/lib/mcp/auth-context.test-fixtures";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ManagedAuth,
  ManagedAuthTimelineEvent,
} from "@onkernel/sdk/resources/auth/connections";
export {
  kernelClientMock,
  resetKernelClientFactory,
  unusedKernelClient,
} from "@/lib/mcp/kernel-client.test-fixtures";
import { registerAuthConnectionTools } from "./auth-connections";

export function connection(overrides: Partial<ManagedAuth> = {}): ManagedAuth {
  return {
    id: "conn_1",
    domain: "example.com",
    profile_name: "work",
    status: "NEEDS_AUTH",
    record_session: false,
    save_credentials: true,
    credential: { name: "secret-credential-ref" },
    hosted_url: "https://managed-auth.onkernel.com/login/conn_1?code=secret",
    live_view_url: "https://live.example/secret",
    browser_session_id: "browser_secret",
    discovered_fields: [
      {
        label: "Password",
        name: "password",
        selector: "#password",
        type: "password",
      },
    ],
    website_error: "untrusted website text",
    ...overrides,
  };
}

export function timelineEvent(
  overrides: Partial<ManagedAuthTimelineEvent> = {},
): ManagedAuthTimelineEvent {
  return {
    id: "flow_1",
    type: "login",
    status: "IN_PROGRESS",
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function timelinePage(events: ManagedAuthTimelineEvent[]) {
  return {
    getPaginatedItems: () => events,
  };
}

export function fakeClient({
  initial = connection(),
  created,
  login,
  createError,
  loginError,
  timeline = [],
}: {
  initial?: ManagedAuth;
  created?: ManagedAuth;
  login?: {
    id: string;
    flow_type: "LOGIN" | "REAUTH";
    flow_expires_at: string;
    hosted_url: string;
    handoff_code?: string;
  };
  createError?: unknown;
  loginError?: unknown;
  timeline?: ManagedAuthTimelineEvent[];
} = {}) {
  const calls = {
    create: 0,
    retrieve: 0,
    login: 0,
    timeline: 0,
    createParams: null as unknown,
    loginParams: null as unknown,
  };
  const client = {
    auth: {
      connections: {
        create: async (params: unknown) => {
          calls.create++;
          calls.createParams = params;
          if (createError) throw createError;
          return created ?? initial;
        },
        retrieve: async () => {
          calls.retrieve++;
          return initial;
        },
        login: async (_id: string, params: unknown) => {
          calls.login++;
          calls.loginParams = params;
          if (loginError) throw loginError;
          return (
            login ?? {
              id: initial.id,
              flow_type: "LOGIN" as const,
              flow_expires_at: "2099-01-01T00:00:00Z",
              hosted_url: `https://managed-auth.onkernel.com/login/${initial.id}?code=handoff-secret`,
              handoff_code: "handoff-secret",
            }
          );
        },
        timeline: async () => {
          calls.timeline++;
          return timelinePage(timeline);
        },
      },
    },
  } as unknown as KernelClient;
  return { client, calls };
}

const forbiddenKeys = [
  "handoff_code",
  "hosted_url",
  "live_view_url",
  "jwt",
  "authorization",
  "credential",
  "discovered_fields",
  "mfa_options",
  "pending_sso_buttons",
  "website_error",
  "browser_session_id",
];

export function assertNoSecrets(value: unknown) {
  const json = JSON.stringify(value).toLowerCase();
  for (const key of forbiddenKeys) expect(json).not.toContain(`"${key}"`);
  expect(json).not.toContain("secret");
  expect(json).not.toContain("untrusted website text");
}

export function captureHandler() {
  let handler: ((params: any, extra: any) => Promise<any>) | undefined;
  let schema: Record<string, any> | undefined;
  const server = {
    tool(
      _name: string,
      _description: string,
      inputSchema: Record<string, any>,
      ...rest: any[]
    ) {
      schema = inputSchema;
      const capturedHandler = rest[rest.length - 1];
      handler = (params, extra) =>
        capturedHandler(params, {
          ...extra,
          authInfo: extra.authInfo
            ? {
                ...projectScopedAuthInfo(
                  params.project ?? params.project_id ?? "proj_test",
                ),
                ...extra.authInfo,
              }
            : undefined,
        });
    },
  } as unknown as McpServer;
  registerAuthConnectionTools(server);
  return {
    get handler() {
      return handler!;
    },
    get schema() {
      return schema;
    },
  };
}
