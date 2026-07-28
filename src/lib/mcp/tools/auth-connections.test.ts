import { describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthConnectionTools } from "@/lib/mcp/tools/auth-connections";
import {
  beginAuthLogin,
  deriveAuthNextAction,
  toSafeAuthConnection,
  waitForAuthConnection,
} from "@/lib/mcp/tools/managed-auth-state";
import type { ManagedAuth } from "@onkernel/sdk/resources/auth/connections";

function connection(overrides: Partial<ManagedAuth> = {}): ManagedAuth {
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

function fakeClient({
  initial = connection(),
  created,
  login,
  createError,
  loginError,
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
} = {}) {
  const calls = { create: 0, retrieve: 0, login: 0 };
  const client = {
    auth: {
      connections: {
        create: async () => {
          calls.create++;
          if (createError) throw createError;
          return created ?? initial;
        },
        retrieve: async () => {
          calls.retrieve++;
          return initial;
        },
        login: async () => {
          calls.login++;
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

function assertNoSecrets(value: unknown) {
  const json = JSON.stringify(value).toLowerCase();
  for (const key of forbiddenKeys) expect(json).not.toContain(`"${key}"`);
  expect(json).not.toContain("secret");
  expect(json).not.toContain("untrusted website text");
}

describe("managed-auth safe responses", () => {
  test("keeps discovery on manage_auth_connections and removes secret login inputs", () => {
    let schema: Record<string, any> | undefined;
    const server = {
      tool(
        _name: string,
        _description: string,
        inputSchema: Record<string, any>,
      ) {
        schema = inputSchema;
      },
    } as unknown as McpServer;
    registerAuthConnectionTools(server);
    expect(schema?.action.safeParse("list").success).toBe(true);
    expect(schema?.action.safeParse("get").success).toBe(true);
    expect(schema?.action.safeParse("wait").success).toBe(true);
    expect(schema?.action.safeParse("create").success).toBe(false);
    expect(schema?.action.safeParse("delete").success).toBe(false);
    expect(schema?.action.safeParse("login").success).toBe(false);
    expect(schema?.action.safeParse("submit").success).toBe(false);
    expect(schema?.fields).toBeUndefined();
    expect(schema?.mfa_option_id).toBeUndefined();
    expect(schema?.sso_button_selector).toBeUndefined();
    expect(schema?.allowed_domains).toBeUndefined();
    expect(schema?.login_url).toBeUndefined();
    expect(schema?.credential_name).toBeUndefined();
    expect(schema?.credential_provider).toBeUndefined();
    expect(schema?.credential_path).toBeUndefined();
  });

  test("allowlists fields and replaces raw errors", () => {
    const safe = toSafeAuthConnection(
      connection({
        flow_status: "FAILED",
        error_code: "login_failed",
        error_message: "raw site/API failure with secret",
      }),
    );
    expect(safe.error_code).toBe("login_failed");
    expect(safe.error_message).toBe(
      "Managed authentication failed. Retry the secure login flow.",
    );
    assertNoSecrets(safe);
  });

  test("steers none, one authenticated, one needs-auth, multiple, and incomplete pages", () => {
    const none = deriveAuthNextAction({
      items: [],
      hasMore: false,
      nextOffset: null,
      domainFilter: "example.com",
    });
    expect(none.selection.outcome).toBe("none");
    expect(none.next_action?.arguments).toEqual({
      mode: "new_login",
      domain: "example.com",
    });
    expect(none.next_action?.required_user_input).toEqual(["profile_name"]);

    const safe = toSafeAuthConnection(connection());
    const needsAuth = deriveAuthNextAction({
      items: [safe],
      hasMore: false,
      nextOffset: null,
      domainFilter: "example.com",
    });
    expect(needsAuth.next_action?.arguments).toEqual({
      mode: "reauth",
      connection_id: "conn_1",
    });

    const authenticated = deriveAuthNextAction({
      items: [{ ...safe, status: "AUTHENTICATED", flow_status: "FAILED" }],
      hasMore: false,
      nextOffset: null,
      domainFilter: "example.com",
    });
    expect(authenticated.next_action?.tool).toBe("manage_browsers");
    expect(authenticated.next_action?.arguments.profile_name).toBe("work");

    const multiple = deriveAuthNextAction({
      items: [safe, { ...safe, id: "conn_2", profile_name: "personal" }],
      hasMore: false,
      nextOffset: null,
      domainFilter: "example.com",
    });
    expect(multiple.selection.outcome).toBe("multiple");
    expect(multiple.next_action?.required_user_input).toEqual([
      "connection_id",
    ]);

    const incomplete = deriveAuthNextAction({
      items: [safe],
      hasMore: true,
      nextOffset: 10,
      domainFilter: "example.com",
      profileFilter: "work",
    });
    expect(incomplete.selection.outcome).toBe("page_incomplete");
    expect(incomplete.next_action?.arguments.offset).toBe(10);
    expect(incomplete.next_action?.arguments.profile_name).toBe("work");

    const finalContinuation = deriveAuthNextAction({
      items: [safe],
      hasMore: false,
      nextOffset: null,
      offset: 1,
      domainFilter: "example.com",
    });
    expect(finalContinuation.selection.outcome).toBe("page_incomplete");
    expect(finalContinuation.next_action?.tool).toBe("ask_user");
    expect(
      finalContinuation.next_action?.arguments.include_matches_from_prior_pages,
    ).toBe(true);
  });
});

describe("managed-auth wait", () => {
  test("long-polls until an exact connection is authenticated", async () => {
    const states = [
      connection({ flow_status: "IN_PROGRESS" }),
      connection({ status: "AUTHENTICATED", flow_status: "SUCCESS" }),
    ];
    let calls = 0;
    const client = {
      auth: {
        connections: {
          retrieve: async () => states[Math.min(calls++, states.length - 1)],
        },
      },
    } as unknown as KernelClient;

    const result = await waitForAuthConnection(
      client,
      { connectionId: "conn_1" },
      { timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(result.state).toBe("authenticated");
    expect(calls).toBe(2);
    assertNoSecrets(result);
  });

  test("does not accept stale authenticated state while re-auth is pending", async () => {
    const stale = connection({
      status: "AUTHENTICATED",
      flow_status: "SUCCESS",
      flow_type: "REAUTH",
      flow_expires_at: "2026-01-01T00:00:00Z",
    });
    const client = {
      auth: { connections: { retrieve: async () => stale } },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: stale.id,
        requiredFlowType: "REAUTH",
        previousFlowExpiresAt: stale.flow_expires_at,
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("returns safe failure and pending states", async () => {
    const failedClient = {
      auth: {
        connections: {
          retrieve: async () =>
            connection({
              flow_status: "FAILED",
              error_message: "raw site/API failure with secret",
            }),
        },
      },
    } as unknown as KernelClient;
    const failed = await waitForAuthConnection(
      failedClient,
      { connectionId: "conn_1" },
      { timeoutMs: 0 },
    );
    expect(failed.state).toBe("failed");
    assertNoSecrets(failed);

    const pendingClient = {
      auth: {
        connections: {
          list: async () => ({
            getPaginatedItems: () => [],
            hasNextPage: () => false,
          }),
        },
      },
    } as unknown as KernelClient;
    const pending = await waitForAuthConnection(
      pendingClient,
      { domain: "example.com", profileName: "work" },
      { timeoutMs: 0 },
    );
    expect(pending).toEqual({ state: "pending" });
  });
});

describe("managed-auth start/resume state machine", () => {
  test("does not restart a live unexpired flow", async () => {
    const initial = connection({
      flow_status: "IN_PROGRESS",
      flow_expires_at: "2099-01-01T00:00:00Z",
    });
    const { client, calls } = fakeClient({ initial });
    const result = await beginAuthLogin(client, {
      mode: "reauth",
      connection_id: initial.id,
    });
    expect(result.state).toBe("observing");
    expect(calls.login).toBe(0);
    expect(result.handoff_code).toBeUndefined();
    expect(result.hosted_url).toBeUndefined();
    assertNoSecrets(result.connection);
  });

  test("recovers duplicate create and returns authenticated without login", async () => {
    const initial = connection({ status: "AUTHENTICATED" });
    const { client, calls } = fakeClient({
      initial,
      createError: {
        status: 409,
        error: { existing_id: initial.id },
      },
    });
    const result = await beginAuthLogin(client, {
      mode: "new_login",
      domain: "example.com",
      profile_name: "work",
    });
    expect(result.state).toBe("already_authenticated");
    expect(calls.retrieve).toBe(1);
    expect(calls.login).toBe(0);
  });

  test("explicit reauth starts login even when authenticated", async () => {
    const initial = connection({ status: "AUTHENTICATED" });
    const { client, calls } = fakeClient({ initial });
    const result = await beginAuthLogin(client, {
      mode: "reauth",
      connection_id: initial.id,
    });
    expect(calls.login).toBe(1);
    expect(result.started_new_flow).toBe(true);
    expect(result.state).toBe("embedded_ready");
  });

  test("surfaces pending-session conflicts instead of observing an orphan", async () => {
    const initial = connection({
      flow_status: "IN_PROGRESS",
      flow_expires_at: "2000-01-01T00:00:00Z",
    });
    const { client, calls } = fakeClient({
      initial,
      loginError: {
        status: 409,
        error: { code: "too_many_pending_sessions" },
      },
    });
    await expect(
      beginAuthLogin(client, {
        mode: "reauth",
        connection_id: initial.id,
      }),
    ).rejects.toThrow("Too many managed-auth sessions are pending");
    expect(calls.login).toBe(1);
    expect(calls.retrieve).toBe(1);
  });
});
