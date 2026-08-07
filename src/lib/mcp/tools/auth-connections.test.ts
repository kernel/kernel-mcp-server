import { describe, expect, test } from "bun:test";
import { toSafeAuthConnection } from "./managed-auth-state";
import {
  assertNoSecrets,
  captureHandler,
  connection,
  kernelClientMock,
  unusedKernelClient,
} from "./auth-connections.test-fixtures";

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
    expect(schema?.record_session).toBeDefined();
    expect(schema?.flow_checkpoint).toBeDefined();
    expect(schema?.proxy_id.safeParse("").success).toBe(false);
    expect(schema?.proxy_name.safeParse("").success).toBe(false);
    expect(schema?.browser_telemetry.safeParse({ enabled: true }).success).toBe(
      true,
    );
    expect(
      schema?.browser_telemetry.safeParse({
        enabled: false,
        browser: { network: { enabled: true } },
      }).success,
    ).toBe(false);
    expect(schema?.sign_in_option_id).toBeUndefined();
  });

  test("constructs a project-scoped client from the optional selector", async () => {
    const { handler, schema } = captureHandler(true);
    let selectedProject: string | undefined;
    kernelClientMock.factory = (_token, projectID) => {
      selectedProject = projectID;
      return {
        auth: {
          connections: {
            list: async () => ({
              getPaginatedItems: () => [],
              has_more: false,
              next_offset: null,
            }),
          },
        },
      };
    };
    try {
      expect(schema?.project_id).toBeDefined();
      await handler(
        { action: "list", project_id: "proj_123" },
        { authInfo: { token: "test-token" } },
      );
      expect(selectedProject).toBe("proj_123");
    } finally {
      kernelClientMock.factory = () => unusedKernelClient;
    }
  });

  test("forwards replay and browser telemetry settings on create and login", async () => {
    const { handler } = captureHandler();
    let createBody: unknown;
    let loginBody: unknown;
    kernelClientMock.factory = () => ({
      auth: {
        connections: {
          create: async (body: unknown) => {
            createBody = body;
            return connection();
          },
          login: async (_id: string, body: unknown) => {
            loginBody = body;
            return {
              id: "conn_1",
              flow_type: "LOGIN",
              flow_expires_at: "2099-01-01T00:00:00Z",
              hosted_url: "https://managed-auth.example/login",
            };
          },
        },
      },
    });
    try {
      const extra = { authInfo: { token: "test-token" } };
      await handler(
        {
          action: "create",
          domain: "example.com",
          profile_name: "work",
        },
        extra,
      );
      expect(createBody).not.toHaveProperty("record_session");
      expect(createBody).not.toHaveProperty("browser_telemetry");

      await handler({ action: "login", id: "conn_1" }, extra);
      expect(loginBody).toBeUndefined();

      await handler(
        {
          action: "create",
          domain: "example.com",
          profile_name: "work",
          record_session: true,
          browser_telemetry: {
            enabled: true,
            browser: { network: { enabled: true } },
          },
        },
        extra,
      );
      expect(createBody).toMatchObject({
        record_session: true,
        browser_telemetry: {
          enabled: true,
          browser: { network: { enabled: true } },
        },
      });

      await handler(
        {
          action: "login",
          id: "conn_1",
          record_session: false,
          browser_telemetry: { enabled: false },
        },
        extra,
      );
      expect(loginBody).toEqual({
        record_session: false,
        browser_telemetry: { enabled: false },
      });
    } finally {
      kernelClientMock.factory = () => unusedKernelClient;
    }
  });

  test("legacy actions keep their established raw response shapes", async () => {
    const { handler } = captureHandler();
    const calls = { create: 0, login: 0, submit: 0, delete: 0, retrieve: 0 };
    kernelClientMock.factory = () => ({
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
      kernelClientMock.factory = () => unusedKernelClient;
    }
  });

  test("list returns the established paginated shape", async () => {
    const { handler } = captureHandler();
    kernelClientMock.factory = () => ({
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
      kernelClientMock.factory = () => unusedKernelClient;
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

  test("legacy action errors throw classified tool errors", async () => {
    const { handler } = captureHandler();
    kernelClientMock.factory = () => ({
      auth: {
        connections: {
          retrieve: async () => {
            throw new Error("upstream boom");
          },
        },
      },
    });
    try {
      await expect(
        handler(
          { action: "get", id: "conn_1" },
          { authInfo: { token: "test-token" } },
        ),
      ).rejects.toThrow(
        "Error in manage_auth_connections (get): upstream boom",
      );
    } finally {
      kernelClientMock.factory = () => unusedKernelClient;
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
    kernelClientMock.factory = () => ({
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
      kernelClientMock.factory = () => unusedKernelClient;
    }
  });

  test("flow checkpoint waits require the checkpoint's connection id", async () => {
    const { handler } = captureHandler();
    const result = await handler(
      {
        action: "wait",
        domain_filter: "example.com",
        profile_name: "work",
        flow_checkpoint: "checkpoint",
      },
      { authInfo: { token: "test-token" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "flow_checkpoint wait requires its connection id",
    );
  });

  test("ambiguous wait selectors fail with a safe message", async () => {
    const { handler } = captureHandler();
    kernelClientMock.factory = () => ({
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
      kernelClientMock.factory = () => unusedKernelClient;
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
