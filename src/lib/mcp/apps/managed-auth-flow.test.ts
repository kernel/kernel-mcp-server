import { describe, expect, test } from "bun:test";
import {
  initialManagedAuthFlowState,
  managedAuthFlowReducer,
  waitArgumentsFromBegin,
} from "./managed-auth-flow";
import type { BeginResult, SafeConnection } from "./managed-auth-types";

const connection: SafeConnection = {
  id: "conn_1",
  domain: "example.com",
  profile_name: "work",
  status: "NEEDS_AUTH",
  flow_status: "IN_PROGRESS",
  flow_type: "LOGIN",
  flow_expires_at: "2099-01-01T00:00:00Z",
  error_code: null,
};

function beginResult(state = "embedded_ready"): BeginResult {
  return {
    structuredContent: {
      state,
      connection,
      resume_id: "resume_1",
      next_action: {
        tool: "manage_auth_connections",
        arguments: {
          action: "wait",
          id: connection.id,
          flow_checkpoint: "server-signed-checkpoint",
          wait_seconds: 5,
        },
      },
    },
  };
}

describe("managed-auth App flow reducer", () => {
  test("moves from consent through pending to authenticated", () => {
    const starting = managedAuthFlowReducer(initialManagedAuthFlowState, {
      type: "BEGIN_REQUESTED",
    });
    expect(starting.phase).toBe("starting");
    const active = managedAuthFlowReducer(starting, {
      type: "BEGIN_RECEIVED",
      result: beginResult(),
    });
    expect(active.phase).toBe("active");
    const pending = managedAuthFlowReducer(active, {
      type: "WAIT_RECEIVED",
      result: { structuredContent: { state: "pending", connection } },
    });
    expect(pending.phase).toBe("active");
    const complete = managedAuthFlowReducer(pending, {
      type: "WAIT_RECEIVED",
      result: {
        structuredContent: {
          state: "authenticated",
          connection: { ...connection, status: "AUTHENTICATED" },
        },
      },
    });
    expect(complete.phase).toBe("terminal");
    expect(complete.outcome).toBe("success");
  });

  test("renders the server's failed flow as terminal failure", () => {
    const active = managedAuthFlowReducer(initialManagedAuthFlowState, {
      type: "BEGIN_RECEIVED",
      result: beginResult(),
    });
    const complete = managedAuthFlowReducer(active, {
      type: "WAIT_RECEIVED",
      result: {
        structuredContent: {
          state: "failed",
          connection: {
            ...connection,
            flow_status: "FAILED",
            error_code: "invalid_credentials",
          },
        },
      },
    });
    expect(complete.phase).toBe("terminal");
    expect(complete.outcome).toBe("failure");
    expect(complete.terminalConnection?.error_code).toBe("invalid_credentials");
  });

  test("stops polling and surfaces wait tool errors", () => {
    const active = managedAuthFlowReducer(initialManagedAuthFlowState, {
      type: "BEGIN_RECEIVED",
      result: beginResult(),
    });
    const failed = managedAuthFlowReducer(active, {
      type: "WAIT_RECEIVED",
      result: {
        isError: true,
        content: [{ type: "text", text: "Checkpoint rejected" }],
      },
    });
    expect(failed.phase).toBe("wait_error");
    expect(failed.status).toBe("Checkpoint rejected");
  });

  test("forwards the exact server-issued wait arguments", () => {
    const begin = beginResult();
    expect(waitArgumentsFromBegin(begin)).toBe(
      begin.structuredContent!.next_action!.arguments!,
    );
    expect(waitArgumentsFromBegin(begin)).toEqual({
      action: "wait",
      id: "conn_1",
      flow_checkpoint: "server-signed-checkpoint",
      wait_seconds: 5,
    });
  });

  test("already-authenticated begin completes without polling", () => {
    const complete = managedAuthFlowReducer(initialManagedAuthFlowState, {
      type: "BEGIN_RECEIVED",
      result: beginResult("already_authenticated"),
    });
    expect(complete.phase).toBe("terminal");
    expect(complete.outcome).toBe("success");
  });
});
