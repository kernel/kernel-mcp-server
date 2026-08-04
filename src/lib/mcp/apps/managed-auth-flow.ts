import type {
  BeginResult,
  JsonObject,
  SafeConnection,
  WaitToolResult,
} from "./managed-auth-types";

export type ManagedAuthFlowState = {
  phase:
    | "consent"
    | "starting"
    | "active"
    | "terminal"
    | "start_error"
    | "wait_error";
  begin: BeginResult | null;
  outcome: "success" | "failure" | null;
  terminalConnection: SafeConnection | null;
  status: string;
};

export type ManagedAuthFlowEvent =
  | { type: "BEGIN_REQUESTED" }
  | { type: "BEGIN_RECEIVED"; result: BeginResult }
  | { type: "BEGIN_FAILED" }
  | { type: "WAIT_RECEIVED"; result: WaitToolResult }
  | { type: "WAIT_TRANSPORT_FAILED" };

export const initialManagedAuthFlowState: ManagedAuthFlowState = {
  phase: "consent",
  begin: null,
  outcome: null,
  terminalConnection: null,
  status: "",
};

function toolErrorText(result: WaitToolResult): string {
  const text = result.content?.find(
    (item) => item.type === "text" && typeof item.text === "string",
  )?.text;
  return text || "Secure login status could not be verified. Close and retry.";
}

export function managedAuthFlowReducer(
  state: ManagedAuthFlowState,
  event: ManagedAuthFlowEvent,
): ManagedAuthFlowState {
  switch (event.type) {
    case "BEGIN_REQUESTED":
      return { ...state, phase: "starting", status: "Starting secure login…" };
    case "BEGIN_RECEIVED": {
      const connection = event.result.structuredContent?.connection;
      if (event.result.isError || !connection) {
        return {
          ...state,
          phase: "start_error",
          status: "Secure login could not start. Close this panel and retry.",
        };
      }
      if (event.result.structuredContent?.state === "already_authenticated") {
        return {
          ...state,
          phase: "terminal",
          begin: event.result,
          outcome: "success",
          terminalConnection: connection,
          status: "",
        };
      }
      return {
        ...state,
        phase: "active",
        begin: event.result,
        status: "",
      };
    }
    case "BEGIN_FAILED":
      return {
        ...state,
        phase: "start_error",
        status: "Secure login could not start. Close this panel and retry.",
      };
    case "WAIT_RECEIVED": {
      if (event.result.isError) {
        return {
          ...state,
          phase: "wait_error",
          status: toolErrorText(event.result),
        };
      }
      const connection = event.result.structuredContent?.connection ?? null;
      if (event.result.structuredContent?.state === "authenticated") {
        return {
          ...state,
          phase: "terminal",
          outcome: "success",
          terminalConnection: connection,
          status: "",
        };
      }
      if (event.result.structuredContent?.state === "failed") {
        return {
          ...state,
          phase: "terminal",
          outcome: "failure",
          terminalConnection: connection,
          status: "",
        };
      }
      return {
        ...state,
        phase: "active",
        status: "Secure login is still in progress…",
      };
    }
    case "WAIT_TRANSPORT_FAILED":
      return {
        ...state,
        phase: "active",
        status: "Checking secure login status…",
      };
  }
}

/** The App forwards the server-issued wait action without rebuilding it. */
export function waitArgumentsFromBegin(
  begin: BeginResult | null,
): JsonObject | null {
  const action = begin?.structuredContent?.next_action;
  if (
    action?.tool !== "manage_auth_connections" ||
    action.arguments?.action !== "wait"
  ) {
    return null;
  }
  return action.arguments;
}
