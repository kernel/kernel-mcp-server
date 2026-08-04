import { describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import { issueAuthFlowCheckpoint } from "./managed-auth-checkpoint";
import { waitForAuthConnection } from "./managed-auth-state";
import {
  assertNoSecrets,
  connection,
  timelineEvent,
  timelinePage,
} from "./auth-connections.test-fixtures";

function waitClient({
  states,
  events = [],
}: {
  states: ReturnType<typeof connection>[];
  events?: ReturnType<typeof timelineEvent>[];
}) {
  let retrieveCalls = 0;
  const client = {
    auth: {
      connections: {
        retrieve: async () =>
          states[Math.min(retrieveCalls++, states.length - 1)],
        timeline: async () => timelinePage(events),
      },
    },
  } as unknown as KernelClient;
  return { client, retrieveCalls: () => retrieveCalls };
}

function checkpoint(
  kind: "after" | "event",
  eventId: string | null,
  connectionId = "conn_1",
) {
  return issueAuthFlowCheckpoint({
    version: 1,
    connectionId,
    kind,
    eventId,
  } as Parameters<typeof issueAuthFlowCheckpoint>[0]);
}

describe("managed-auth wait", () => {
  test("long-polls until an exact connection is authenticated", async () => {
    const { client, retrieveCalls } = waitClient({
      states: [
        connection({ flow_status: "IN_PROGRESS" }),
        connection({ status: "AUTHENTICATED", flow_status: "SUCCESS" }),
      ],
    });
    const result = await waitForAuthConnection(
      client,
      { connectionId: "conn_1" },
      { timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(result.state).toBe("authenticated");
    expect(retrieveCalls()).toBe(2);
    assertNoSecrets(result);
  });

  test("keeps an authenticated connection pending while reauth is live", async () => {
    const live = connection({
      status: "AUTHENTICATED",
      flow_status: "IN_PROGRESS",
      flow_type: "REAUTH",
      flow_expires_at: "2099-01-01T00:00:00Z",
    });
    const { client } = waitClient({ states: [live] });
    const result = await waitForAuthConnection(
      client,
      { connectionId: live.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("reports a flow failure after observing it live", async () => {
    const { client } = waitClient({
      states: [
        connection({
          status: "AUTHENTICATED",
          flow_status: "IN_PROGRESS",
          flow_type: "REAUTH",
        }),
        connection({
          status: "AUTHENTICATED",
          flow_status: "FAILED",
          flow_type: "REAUTH",
          error_code: "bad_credentials",
        }),
      ],
    });
    const result = await waitForAuthConnection(
      client,
      { connectionId: "conn_1" },
      { timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(result.state).toBe("failed");
    expect(result.connection?.error_message).not.toContain("credentials");
  });

  test("keeps stale reauth failure from invalidating an authenticated profile", async () => {
    const stale = connection({
      status: "AUTHENTICATED",
      flow_status: "FAILED",
      flow_type: "REAUTH",
    });
    const { client } = waitClient({ states: [stale] });
    const result = await waitForAuthConnection(
      client,
      { connectionId: stale.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("authenticated");
  });

  test("active-flow checkpoint catches failure before the first wait poll", async () => {
    const failed = connection({
      status: "AUTHENTICATED",
      flow_status: "FAILED",
      flow_type: "REAUTH",
      error_code: "reauth_failed",
    });
    const { client } = waitClient({
      states: [failed],
      events: [
        timelineEvent({
          id: "flow_live",
          type: "reauth",
          status: "FAILED",
        }),
      ],
    });
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: failed.id,
        flowCheckpoint: checkpoint("event", "flow_live"),
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("failed");
  });

  test("after-checkpoint ignores the baseline and accepts only the new success", async () => {
    const authenticated = connection({
      status: "AUTHENTICATED",
      flow_status: "SUCCESS",
      flow_type: "REAUTH",
    });
    const oldEvent = timelineEvent({
      id: "flow_old",
      type: "reauth",
      status: "SUCCESS",
    });
    const staleClient = waitClient({
      states: [authenticated],
      events: [oldEvent],
    }).client;
    const selector = {
      connectionId: authenticated.id,
      flowCheckpoint: checkpoint("after", "flow_old"),
    };
    expect(
      (await waitForAuthConnection(staleClient, selector, { timeoutMs: 0 }))
        .state,
    ).toBe("pending");

    const completedClient = waitClient({
      states: [authenticated],
      events: [
        timelineEvent({
          id: "flow_new",
          type: "reauth",
          status: "SUCCESS",
        }),
        oldEvent,
      ],
    }).client;
    expect(
      (
        await waitForAuthConnection(completedClient, selector, {
          timeoutMs: 0,
        })
      ).state,
    ).toBe("authenticated");
  });

  test("explicitly empty baseline catches the first flow's terminal failure", async () => {
    const failed = connection({
      flow_status: "FAILED",
      flow_type: "LOGIN",
    });
    const { client } = waitClient({
      states: [failed],
      events: [timelineEvent({ id: "flow_first", status: "FAILED" })],
    });
    const result = await waitForAuthConnection(
      client,
      {
        connectionId: failed.id,
        flowCheckpoint: checkpoint("after", null),
      },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("failed");
  });

  test("rejects tampered and cross-connection checkpoints", async () => {
    const { client } = waitClient({ states: [connection()] });
    await expect(
      waitForAuthConnection(
        client,
        {
          connectionId: "conn_1",
          flowCheckpoint: `${checkpoint("after", null)}x`,
        },
        { timeoutMs: 0 },
      ),
    ).rejects.toThrow("checkpoint is invalid");
    await expect(
      waitForAuthConnection(
        client,
        {
          connectionId: "conn_1",
          flowCheckpoint: checkpoint("after", null, "conn_2"),
        },
        { timeoutMs: 0 },
      ),
    ).rejects.toThrow("checkpoint is invalid");
  });

  test("treats an in-progress flow with unknown expiry as live", async () => {
    const unknownExpiry = connection({
      status: "AUTHENTICATED",
      flow_status: "IN_PROGRESS",
      flow_expires_at: null,
    });
    const { client } = waitClient({ states: [unknownExpiry] });
    const result = await waitForAuthConnection(
      client,
      { connectionId: unknownExpiry.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("pending");
  });

  test("returns only allowlisted connection fields", async () => {
    const failed = connection({
      flow_status: "FAILED",
      error_message: "raw secret website error",
    });
    const { client } = waitClient({ states: [failed] });
    const result = await waitForAuthConnection(
      client,
      { connectionId: failed.id },
      { timeoutMs: 0 },
    );
    expect(result.state).toBe("failed");
    assertNoSecrets(result);
  });
});
