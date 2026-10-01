import { describe, expect, test } from "bun:test";
import {
  failureTerminalView,
  isTerminalFailure,
} from "@/lib/mcp/apps/managed-auth-terminal";

// Mirrors the hosted UI (@onkernel/managed-auth-react): FAILED/CANCELED
// render StepError with the actual safe error code so ERROR_DISPLAY copy
// survives; EXPIRED renders StepExpired.
describe("managed-auth terminal view", () => {
  test("FAILED renders StepError with the actual safe error code", () => {
    expect(failureTerminalView("FAILED", "credentials_invalid")).toEqual({
      step: "error",
      errorCode: "credentials_invalid",
    });
    expect(failureTerminalView("FAILED", "bot_detected")).toEqual({
      step: "error",
      errorCode: "bot_detected",
    });
  });

  test("CANCELED renders StepError like the hosted UI", () => {
    expect(failureTerminalView("CANCELED", null)).toEqual({ step: "error" });
    expect(failureTerminalView("CANCELED", "stuck_in_loop")).toEqual({
      step: "error",
      errorCode: "stuck_in_loop",
    });
  });

  test("EXPIRED renders StepExpired regardless of error code", () => {
    expect(failureTerminalView("EXPIRED", null)).toEqual({ step: "expired" });
    expect(failureTerminalView("EXPIRED", "session_expired")).toEqual({
      step: "expired",
    });
  });

  test("unknown or missing failure codes fall back to the generic error step", () => {
    expect(failureTerminalView("FAILED", null)).toEqual({ step: "error" });
    expect(failureTerminalView(null, null)).toEqual({ step: "error" });
    expect(failureTerminalView(undefined, undefined)).toEqual({
      step: "error",
    });
  });

  test("only FAILED, EXPIRED, and CANCELED are terminal failures", () => {
    expect(isTerminalFailure("FAILED")).toBe(true);
    expect(isTerminalFailure("EXPIRED")).toBe(true);
    expect(isTerminalFailure("CANCELED")).toBe(true);
    expect(isTerminalFailure("IN_PROGRESS")).toBe(false);
    expect(isTerminalFailure("SUCCESS")).toBe(false);
    expect(isTerminalFailure(null)).toBe(false);
    expect(isTerminalFailure(undefined)).toBe(false);
  });
});
