import { describe, expect, test } from "bun:test";
import {
  issueAuthFlowCheckpoint,
  verifyAuthFlowCheckpoint,
} from "./managed-auth-checkpoint";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

describe("managed-auth flow checkpoints", () => {
  test("round-trips an exact active flow identity", () => {
    const token = issueAuthFlowCheckpoint({
      version: 1,
      connectionId: "conn_1",
      kind: "event",
      eventId: "flow_live",
    });
    expect(verifyAuthFlowCheckpoint(token)).toEqual({
      version: 1,
      connectionId: "conn_1",
      kind: "event",
      eventId: "flow_live",
    });
  });

  test("distinguishes an explicitly empty timeline baseline", () => {
    const token = issueAuthFlowCheckpoint({
      version: 1,
      connectionId: "conn_1",
      kind: "after",
      eventId: null,
    });
    expect(verifyAuthFlowCheckpoint(token)?.eventId).toBeNull();
  });

  test("rejects tampering", () => {
    const token = issueAuthFlowCheckpoint({
      version: 1,
      connectionId: "conn_1",
      kind: "after",
      eventId: "flow_old",
    });
    expect(verifyAuthFlowCheckpoint(`${token}x`)).toBeNull();
  });
});
