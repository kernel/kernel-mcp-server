import { describe, expect, mock, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthConnectionTools } from "@/lib/mcp/tools/auth-connections";
import {
  beginAuthLogin,
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

function captureHandler() {
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
      handler = rest[rest.length - 1];
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

describe("manage_auth_connections programmatic surface", () => {
  test("keeps every legacy action and adds wait", () => {
    const { schema } = captureHandler();
    expect(schema?.action.safeParse("list").success).toBe(true);
    expect(schema?.action.safeParse("get").success).toBe(true);
    expect(schema?.action.safeParse("create").success).toBe(true);
    expect(schema?.action.safeParse("delete").success).toBe(true);
    expect(schema?.action.safeParse("login").success).toBe(true);
    expect(schema?.action.safeParse("submit").success).toBe(true);
    expect(schema?.action.safeParse("wait").success).toBe(true);
    expect(schema?.fields).toBeDefined();
    expect(schema?.mfa_option_id).toBeDefined();
    expect(schema?.sso_button_selector).toBeDefined();
    expect(schema?.allowed_domains).toBeDefined();
    expect(schema?.login_url).toBeDefined();
    expect(schema?.credential_name).toBeDefined();
    expect(schema?.credential_provider).toBeDefined();
    expect(schema?.credential_path).toBeDefined();
    expect(schema?.sign_in_option_id).toBeUndefined();
  });

  test("legacy actions keep their established raw response shapes", async () => {
    const { handler } = captureHandler();
    const calls = { create: 0, login: 0, submit: 0, delete: 0, retrieve: 0 };
    kernelClientFactory = () => ({
      auth: {
        connections: {
          create: async () => {
            calls.create++;
            return connection();
          },
          retrieve: async () => {
            calls.retrieve++;
            return connection({ status: "AUTHENTICATED" });
          },
          login: async () => {
            calls.login++;
            return {
              id: "conn_1",
              flow_type: "LOGIN",
              flow_expires_at: "2099-01-01T00:00:00Z",
              hosted_url: "https://managed-auth.example/login",
              live_view_url: "https://live.example/view",
            };
          },
          submit: async () => {
            calls.submit++;
            return { accepted: true };
          },
          delete: async () => {
            calls.delete++;
          },
        },
      },
    });
    try {
      const extra = { authInfo: { token: "test-token" } };

      // create returns the raw connection JSON (established main behavior).
      const created = await handler(
        {
          action: "create",
          domain: "example.com",
          profile_name: "work",
          credential_name: "stored-login",
        },
        extra,
      );
      expect(created.structuredContent).toBeUndefined();
      expect(JSON.parse(created.content[0].text).id).toBe("conn_1");

      // get returns the full raw connection, including programmatic
      // interaction metadata (discovered_fields, mfa_options, ...).
      const got = await handler({ action: "get", id: "conn_1" }, extra);
      const gotJson = JSON.parse(got.content[0].text);
      expect(gotJson.status).toBe("AUTHENTICATED");
      expect(gotJson.discovered_fields).toHaveLength(1);
      expect(gotJson.interaction).toBeUndefined();

      // login returns the raw hosted flow response.
      const login = await handler({ action: "login", id: "conn_1" }, extra);
      const loginJson = JSON.parse(login.content[0].text);
      expect(loginJson.hosted_url).toBe("https://managed-auth.example/login");
      expect(loginJson.live_view_url).toBe("https://live.example/view");

      // submit returns the raw acceptance response.
      const submitted = await handler(
        { action: "submit", id: "conn_1", fields: { mfa_code: "123456" } },
        extra,
      );
      expect(JSON.parse(submitted.content[0].text)).toEqual({
        accepted: true,
      });

      // delete returns the established plain-text confirmation.
      const deleted = await handler({ action: "delete", id: "conn_1" }, extra);
      expect(deleted.content[0].text).toBe(
        "Auth connection deleted successfully",
      );

      expect(calls).toEqual({
        create: 1,
        login: 1,
        submit: 1,
        delete: 1,
        retrieve: 1,
      });
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
  });

  test("list returns the established paginated shape", async () => {
    const { handler } = captureHandler();
    kernelClientFactory = () => ({
      auth: {
        connections: {
          list: async (params: Record<string, unknown>) => {
            expect(params.domain).toBe("example.com");
            return {
              getPaginatedItems: () => [connection()],
              has_more: false,
              next_offset: null,
            };
          },
        },
      },
    });
    try {
      const result = await handler(
        { action: "list", domain_filter: "example.com" },
        { authInfo: { token: "test-token" } },
      );
      const json = JSON.parse(result.content[0].text);
      expect(json.items).toHaveLength(1);
      expect(json.items[0].id).toBe("conn_1");
      expect(json.has_more).toBe(false);
      expect(json.next_offset).toBeNull();
      // No discovery steering is injected into the programmatic list shape.
      expect(json.selection).toBeUndefined();
      expect(json.next_action).toBeUndefined();
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
  });

  test("legacy validation errors are preserved", async () => {
    const { handler } = captureHandler();
    const extra = { authInfo: { token: "test-token" } };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "create", domain: "example.com" }, "domain and profile_name"],
      [
        {
          action: "create",
          domain: "example.com",
          profile_name: "work",
          credential_name: "x",
          credential_auto: true,
        },
        "credential_name cannot be combined",
      ],
      [
        {
          action: "create",
          domain: "example.com",
          profile_name: "work",
          credential_path: "Vault/Item",
        },
        "require credential_provider",
      ],
      [{ action: "get" }, "id is required for get"],
      [{ action: "delete" }, "id is required for delete"],
      [{ action: "login" }, "id is required for login"],
      [{ action: "submit", id: "conn_1" }, "submit requires at least one of"],
    ];
    for (const [params, message] of cases) {
      const result = await handler(params, extra);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    }
  });

  test("legacy action errors surface through toolErrorResponse", async () => {
    const { handler } = captureHandler();
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => {
            throw new Error("upstream boom");
          },
        },
      },
    });
    try {
      const result = await handler(
        { action: "get", id: "conn_1" },
        { authInfo: { token: "test-token" } },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Error in manage_auth_connections (get): upstream boom",
      );
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
  });

  test("wait requires an id or an exact domain and profile", async () => {
    const { handler } = captureHandler();
    const result = await handler(
      { action: "wait", domain_filter: "example.com" },
      { authInfo: { token: "test-token" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "wait requires id, or both domain_filter and profile_name",
    );
  });

  test("wait long-polls and returns a sanitized state plus connection", async () => {
    const { handler } = captureHandler();
    const states = [
      connection({ flow_status: "IN_PROGRESS" }),
      connection({ status: "AUTHENTICATED", flow_status: "SUCCESS" }),
    ];
    let calls = 0;
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () => states[Math.min(calls++, states.length - 1)],
        },
      },
    });
    try {
      const result = await handler(
        { action: "wait", id: "conn_1", wait_seconds: 2 },
        { authInfo: { token: "test-token" } },
      );
      expect(result.structuredContent.state).toBe("authenticated");
      expect(result.structuredContent.connection.id).toBe("conn_1");
      expect(result.structuredContent.instruction).toContain("verified");
      expect(calls).toBe(2);
      assertNoSecrets(result.structuredContent);
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
  });

  test("baseline-guarded wait stays pending on the stale pre-flow success", async () => {
    const { handler } = captureHandler();
    kernelClientFactory = () => ({
      auth: {
        connections: {
          retrieve: async () =>
            connection({
              status: "AUTHENTICATED",
              flow_status: "SUCCESS",
              flow_type: "REAUTH",
              flow_expires_at: "2026-01-01T00:00:00Z",
            }),
        },
      },
    });
    try {
      const result = await handler(
        {
          action: "wait",
          id: "conn_1",
          wait_seconds: 1,
          required_flow_type: "REAUTH",
          previous_flow_expires_at: "2026-01-01T00:00:00Z",
        },
        { authInfo: { token: "test-token" } },
      );
      expect(result.structuredContent.state).toBe("pending");
      expect(result.structuredContent.instruction).toContain("pending");
    } finally {
      kernelClientFactory = () => unusedKernelClient;
    }
  });

  test("ambiguous wait selectors fail with a safe message", async () => {
    const { handler } = captureHandler();
    kernelClientFactory = () => ({
      auth: {
        connections: {
          list: async () => ({
            getPaginatedItems: () => [
              connection(),
              connection({ id: "conn_2" }),
            ],
            hasNextPage: () => false,
          }),
        },
      },
    });
    try {
      const result = await handler(
        {
          action: "wait",
          domain_filter: "example.com",
          profile_name: "work",
          wait_seconds: 1,
        },
        { authInfo: { token: "test-token" } },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "Multiple managed-auth connections matched",
      );
      expect(result.content[0].text).not.toContain("secret");
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
    expect(failed.connection?.flow_status).toBe("FAILED");
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
