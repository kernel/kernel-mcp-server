/**
 * Faithful terminal-step mapping for the Managed Auth MCP App, mirroring
 * @onkernel/managed-auth-react: FAILED/CANCELED render StepError (the actual
 * safe error code selects the ERROR_DISPLAY copy) and EXPIRED renders
 * StepExpired. Kept React-free so it is unit-testable outside the bundle.
 */
export type TerminalFlowStatus =
  | "IN_PROGRESS"
  | "SUCCESS"
  | "FAILED"
  | "EXPIRED"
  | "CANCELED"
  | null
  | undefined;

export type FailureTerminalView =
  | { step: "expired" }
  | { step: "error"; errorCode?: string };

export function isTerminalFailure(
  flowStatus: TerminalFlowStatus,
): flowStatus is "FAILED" | "EXPIRED" | "CANCELED" {
  return (
    flowStatus === "FAILED" ||
    flowStatus === "EXPIRED" ||
    flowStatus === "CANCELED"
  );
}

export function failureTerminalView(
  flowStatus: TerminalFlowStatus,
  errorCode: string | null | undefined,
): FailureTerminalView {
  if (flowStatus === "EXPIRED") return { step: "expired" };
  return { step: "error", ...(errorCode ? { errorCode } : {}) };
}
