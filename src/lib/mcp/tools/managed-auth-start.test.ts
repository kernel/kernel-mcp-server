import { describe, expect, test } from "bun:test";
import { beginAuthLogin } from "./managed-auth-state";
import {
  assertNoSecrets,
  connection,
  fakeClient,
  timelineEvent,
} from "./auth-connections.test-fixtures";

describe("managed-auth start/resume state machine", () => {
  test("does not restart a live unexpired flow", async () => {
    const initial = connection({
      flow_status: "IN_PROGRESS",
      flow_expires_at: "2099-01-01T00:00:00Z",
    });
    const { client, calls } = fakeClient({
      initial,
      timeline: [timelineEvent({ id: "flow_live", type: "reauth" })],
    });
    const result = await beginAuthLogin(client, {
      mode: "reauth",
      connection_id: initial.id,
    });
    expect(result.state).toBe("observing");
    expect(calls.login).toBe(0);
    expect(result.handoff_code).toBeUndefined();
    expect(result.hosted_url).toBeUndefined();
    expect(result.flow_checkpoint).toBeDefined();
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

  test("secure App login defaults replay and operational telemetry on", async () => {
    const initial = connection();
    const { client, calls } = fakeClient({ initial });
    await beginAuthLogin(client, {
      mode: "new_login",
      domain: "example.com",
      profile_name: "work",
    });
    expect(calls.createParams).toMatchObject({
      record_session: true,
      browser: { telemetry: { enabled: true } },
    });
    expect(calls.loginParams).toEqual({
      record_session: true,
      browser: { telemetry: { enabled: true } },
    });
  });

  test("secure App login preserves explicit recording opt-outs", async () => {
    const initial = connection();
    const { client, calls } = fakeClient({ initial });
    await beginAuthLogin(client, {
      mode: "new_login",
      domain: "example.com",
      profile_name: "work",
      record_session: false,
      browser_telemetry: { enabled: false },
    });
    expect(calls.createParams).toMatchObject({
      record_session: false,
      browser: { telemetry: { enabled: false } },
    });
    expect(calls.loginParams).toEqual({
      record_session: false,
      browser: { telemetry: { enabled: false } },
    });
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
