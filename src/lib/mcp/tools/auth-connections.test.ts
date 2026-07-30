import { describe, expect, mock, test } from "bun:test";
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

// Handler-level tests substitute a fake Kernel client; the default stub
// errors if any API method is actually invoked.
const unusedKernelClient = new Proxy(
  {},
  {
    get: () => {
      throw new Error("unexpected Kernel client use");
    },
  },
);
let kernelClientFactory: (token: string) => any = () => unusedKernelClient;
mock.module("@/lib/mcp/kernel-client", () => ({
  createKernelClient: (token: string) => kernelClientFactory(token),
}));

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

  test("get waits out a live in-progress flow on an authenticated connection", async () => {
    let handler: ((params: any, extra: any) => Promise<any>) | undefined;
    const server = {
      tool(...args: any[]) {
        handler = args[args.length - 1];
      },
    } as unknown as McpServer;
    registerAuthConnectionTools(server);
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () =>
            connection({
              status: "AUTHENTICATED",
              flow_status: "IN_PROGRESS",
              flow_type: "REAUTH",
              flow_expires_at: "2099-01-01T00:00:00Z",
            }),
        },
      },
    });
    try {
      const result = await handler!(
        { action: "get", id: "conn_1" },
        { authInfo: { token: "test-token" } },
      );
      expect(result.structuredContent.instruction).toContain("in progress");
      expect(result.structuredContent.instruction).not.toContain("verified");
      assertNoSecrets(result);
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
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

    const liveReauth = deriveAuthNextAction({
      items: [
        {
          ...safe,
          status: "AUTHENTICATED",
          flow_status: "IN_PROGRESS",
          flow_type: "REAUTH",
          flow_expires_at: "2099-01-01T00:00:00Z",
        },
      ],
      hasMore: false,
      nextOffset: null,
      domainFilter: "example.com",
    });
    expect(liveReauth.next_action?.tool).toBe("manage_auth_connections");
    expect(liveReauth.next_action?.arguments).toEqual({
      action: "wait",
      id: "conn_1",
    });

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

  test("treats authenticated with a live re-auth flow as pending, even without a flow guard", async () => {
    // Text-only re-auth of an AUTHENTICATED connection: the wait must not
    // accept the pre-flow authenticated state while the new flow runs.
    const liveReauth = connection({
      status: "AUTHENTICATED",
      flow_status: "IN_PROGRESS",
      flow_type: "REAUTH",
      flow_expires_at: "2099-01-01T00:00:00Z",
    });
    const client = {
      auth: { connections: { retrieve: async () => liveReauth } },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      { connectionId: liveReauth.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("accepts authenticated once the live flow succeeds, without any flow guard", async () => {
    const states = [
      connection({
        status: "AUTHENTICATED",
        flow_status: "IN_PROGRESS",
        flow_type: "REAUTH",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
      connection({
        status: "AUTHENTICATED",
        flow_status: "SUCCESS",
        flow_type: "REAUTH",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
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
  });

  test("reports failure when an observed live flow fails on an authenticated connection, even without a flow guard", async () => {
    // A failed re-auth keeps the previous session, so the connection still
    // reads AUTHENTICATED. Because this wait saw the flow live, the failure
    // is authoritative: the App shows it, so the wait must not resume the
    // agent with a stale success.
    const states = [
      connection({
        status: "AUTHENTICATED",
        flow_status: "IN_PROGRESS",
        flow_type: "REAUTH",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
      connection({
        status: "AUTHENTICATED",
        flow_status: "FAILED",
        flow_type: "REAUTH",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
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
    expect(result.state).toBe("failed");
  });

  test("still accepts authenticated state with a stale terminal failure, without any flow guard", async () => {
    // No live flow observed during this wait: the failed flow predates it,
    // so the connection's authenticated state is usable (duplicate-recovery
    // path).
    const stale = connection({
      status: "AUTHENTICATED",
      flow_status: "FAILED",
      flow_type: "REAUTH",
      flow_expires_at: "2026-01-01T00:00:00Z",
    });
    const client = {
      auth: { connections: { retrieve: async () => stale } },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      { connectionId: stale.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("authenticated");
  });

  test("baseline-guarded reauth wait completes when the server reports flow_type LOGIN", async () => {
    // The server chooses the flow type; a reauth-mode wait must accept any
    // successful new flow instead of assuming REAUTH.
    const states = [
      connection({
        status: "NEEDS_AUTH",
        flow_status: "IN_PROGRESS",
        flow_type: "LOGIN",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
      connection({
        status: "AUTHENTICATED",
        flow_status: "SUCCESS",
        flow_type: "LOGIN",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
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
      { connectionId: "conn_1", previousFlowExpiresAt: null },
      { timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(result.state).toBe("authenticated");
  });

  test("timeline identity completes a null-expiry baseline when polling misses the live flow", async () => {
    const completed = connection({
      status: "AUTHENTICATED",
      flow_status: "SUCCESS",
      flow_type: "REAUTH",
      flow_expires_at: null,
    });
    const client = {
      auth: {
        connections: {
          retrieve: async () => completed,
          timeline: async () => ({
            getPaginatedItems: () => [
              {
                id: "flow_new",
                type: "reauth",
                status: "SUCCESS",
                timestamp: "2026-01-02T00:00:00Z",
              },
            ],
          }),
        },
      },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: completed.id,
        previousFlowExpiresAt: null,
        flowWaitStartedAt: "2026-01-01T00:00:00Z",
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("authenticated");
  });

  test("timeline timestamp ignores a stale event when no prior event id exists", async () => {
    const stale = connection({
      status: "AUTHENTICATED",
      flow_status: "SUCCESS",
      flow_type: "REAUTH",
      flow_expires_at: null,
    });
    const client = {
      auth: {
        connections: {
          retrieve: async () => stale,
          timeline: async () => ({
            getPaginatedItems: () => [
              {
                id: "flow_old",
                type: "reauth",
                status: "SUCCESS",
                timestamp: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        },
      },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: stale.id,
        previousFlowExpiresAt: null,
        flowWaitStartedAt: "2026-01-02T00:00:00Z",
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("baseline-guarded wait stays pending on the stale pre-flow success", async () => {
    const stale = connection({
      status: "AUTHENTICATED",
      flow_status: "SUCCESS",
      flow_type: "LOGIN",
      flow_expires_at: "2026-01-01T00:00:00Z",
    });
    const client = {
      auth: { connections: { retrieve: async () => stale } },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: stale.id,
        previousFlowExpiresAt: stale.flow_expires_at,
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("baseline-guarded wait accepts success after observing the new live flow, even if the expiry matches the baseline", async () => {
    // Backstop for servers that keep (or clear) flow_expires_at once a flow
    // reaches a terminal state: having observed the new in-progress flow is
    // proof the success is not the stale pre-flow one.
    const states = [
      connection({
        status: "AUTHENTICATED",
        flow_status: "IN_PROGRESS",
        flow_type: "REAUTH",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
      connection({
        status: "AUTHENTICATED",
        flow_status: "SUCCESS",
        flow_type: "REAUTH",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
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
      {
        connectionId: "conn_1",
        previousFlowExpiresAt: "2099-01-01T00:00:00Z",
      },
      { timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(result.state).toBe("authenticated");
  });

  test("baseline-guarded wait does not fail on a terminal flow that predates the baseline", async () => {
    const oldFailure = connection({
      status: "NEEDS_AUTH",
      flow_status: "FAILED",
      flow_type: "LOGIN",
      flow_expires_at: "2020-01-01T00:00:00Z",
    });
    const client = {
      auth: { connections: { retrieve: async () => oldFailure } },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: oldFailure.id,
        previousFlowExpiresAt: "2020-01-01T00:00:00Z",
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("unguarded wait polls past an old failed flow until the new flow succeeds", async () => {
    // New-login path: the agent long-polls before the App starts a flow, so
    // an old FAILED flow on the connection must not abort the wait.
    const states = [
      connection({
        flow_status: "FAILED",
        flow_expires_at: "2026-01-01T00:00:00Z",
      }),
      connection({
        flow_status: "IN_PROGRESS",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
      connection({
        status: "AUTHENTICATED",
        flow_status: "SUCCESS",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
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
    expect(calls).toBe(3);
  });

  test("treats an in-progress flow with unknown expiry as live", async () => {
    // Missing flow_expires_at must not let a wait accept the stale pre-flow
    // authenticated state while a re-auth may still be running.
    const unknownExpiry = connection({
      status: "AUTHENTICATED",
      flow_status: "IN_PROGRESS",
      flow_type: "REAUTH",
      flow_expires_at: undefined,
    });
    const client = {
      auth: { connections: { retrieve: async () => unknownExpiry } },
    } as unknown as KernelClient;
    const result = await waitForAuthConnection(
      client,
      { connectionId: unknownExpiry.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("returns safe failure and pending states", async () => {
    // A flow this wait saw live and then fail is reported as a safe failure.
    const states = [
      connection({
        flow_status: "IN_PROGRESS",
        flow_expires_at: "2099-01-01T00:00:00Z",
      }),
      connection({
        flow_status: "FAILED",
        error_message: "raw site/API failure with secret",
      }),
    ];
    let calls = 0;
    const failedClient = {
      auth: {
        connections: {
          retrieve: async () => states[Math.min(calls++, states.length - 1)],
        },
      },
    } as unknown as KernelClient;
    const failed = await waitForAuthConnection(
      failedClient,
      { connectionId: "conn_1" },
      { timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(failed.state).toBe("failed");
    assertNoSecrets(failed);

    // A terminal failure the wait never saw live predates it (e.g. an old
    // failed attempt before the user clicked Continue): keep polling.
    const staleClient = {
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
    const stale = await waitForAuthConnection(
      staleClient,
      { connectionId: "conn_1" },
      { timeoutMs: 0 },
    );
    expect(stale.state).toBe("pending");
    assertNoSecrets(stale);

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
