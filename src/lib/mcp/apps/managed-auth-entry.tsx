import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { KernelManagedAuth } from "@onkernel/managed-auth-react";
import "@onkernel/managed-auth-react/styles.css";
import { createManagedAuthFetch } from "./managed-auth-fetch";
import { useManagedAuthAutofocus } from "./managed-auth-focus";
import {
  initialManagedAuthFlowState,
  managedAuthFlowReducer,
  waitArgumentsFromBegin,
} from "./managed-auth-flow";
import { ManagedAuthHostBridge } from "./managed-auth-host";
import type {
  BeginResult,
  JsonObject,
  LauncherResult,
  WaitToolResult,
} from "./managed-auth-types";
import { ConsentView, MessageView, TerminalView } from "./managed-auth-views";

const FAILURE_CONTEXT =
  "Managed authentication stopped. Verify its terminal state and report the recovery option; do not continue the protected action.";
const host = new ManagedAuthHostBridge();

function sanitizeBeginArguments(input: JsonObject): JsonObject {
  const allowed = [
    "mode",
    "connection_id",
    "domain",
    "profile_name",
    "project_id",
    "save_credentials",
    "record_session",
    "browser_telemetry",
    "proxy_id",
    "proxy_name",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

function ManagedAuthApp() {
  const launcher = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
    host.getSnapshot,
  );
  const [flow, dispatch] = useReducer(
    managedAuthFlowReducer,
    initialManagedAuthFlowState,
  );
  const [dismissed, setDismissed] = useState(false);
  const [embeddedFailure, setEmbeddedFailure] = useState<
    "fallback" | "retry" | null
  >(null);
  const [pollRequest, setPollRequest] = useState(0);
  const pollingStarted = useRef(false);
  const pollTimer = useRef<number | null>(null);
  const launcherResult = launcher.result as LauncherResult | null;
  const connection = flow.begin?.structuredContent?.connection;
  const privateAuth =
    flow.begin?._meta?.auth_login ?? flow.begin?.structuredContent?.app_private;
  const targetDomain =
    launcherResult?.structuredContent?.connection?.domain ??
    (launcher.input?.domain as string | undefined) ??
    "this site";
  const appearance = useMemo(
    () => ({ theme: launcher.theme, layout: { skipPrimeStep: true } }),
    [launcher.theme],
  );
  const fetchAdapter = useMemo(
    () => createManagedAuthFetch(window.fetch.bind(window)),
    [],
  );

  useManagedAuthAutofocus();

  useEffect(() => {
    host.reportSize();
  });

  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    },
    [],
  );

  const publishTerminal = useCallback(
    async (outcome: "success" | "failure") => {
      const resumeId = flow.begin?.structuredContent?.resume_id;
      if (!resumeId || host.destroyed) return;
      if (
        !host.claimOneShot(`kernel-managed-auth-context:${resumeId}:${outcome}`)
      ) {
        return;
      }
      const terminalConnection = flow.terminalConnection ?? connection;
      const domain = terminalConnection?.domain ?? targetDomain;
      const profileName = terminalConnection?.profile_name;
      const safeTarget = {
        domain,
        ...(profileName && { profile_name: profileName }),
      };
      const context =
        outcome === "failure"
          ? {
              text: FAILURE_CONTEXT,
              structuredContent: {
                kind: "kernel.managed_auth.terminal",
                version: 1,
                outcome,
              },
            }
          : {
              text: `Kernel managed authentication reported completion for ${JSON.stringify(safeTarget)}. Verify the connection through manage_auth_connections before continuing the pending task.`,
              structuredContent: {
                kind: "kernel.managed_auth.terminal",
                version: 1,
                outcome,
                ...safeTarget,
              },
            };
      try {
        await host.request("ui/update-model-context", {
          content: [{ type: "text", text: context.text }],
          structuredContent: context.structuredContent,
        });
      } catch {
        // The verified terminal state remains visible in the App.
      }
    },
    [connection, flow.begin, flow.terminalConnection, targetDomain],
  );

  useEffect(() => {
    if (flow.phase === "terminal" && flow.outcome) {
      void publishTerminal(flow.outcome);
    }
  }, [flow.outcome, flow.phase, publishTerminal]);

  useEffect(() => {
    const observing =
      flow.begin?.structuredContent?.state === "observing" ||
      !privateAuth?.handoff_code ||
      embeddedFailure === "fallback";
    if (flow.phase !== "active" || (!pollingStarted.current && !observing)) {
      return;
    }
    pollingStarted.current = true;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || host.destroyed) return;
      const args = waitArgumentsFromBegin(flow.begin);
      if (!args) {
        dispatch({
          type: "WAIT_RECEIVED",
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "The server did not provide a secure wait checkpoint. Close and retry.",
              },
            ],
          },
        });
        return;
      }
      try {
        const result = await host.callTool<WaitToolResult>(
          "manage_auth_connections",
          args,
        );
        if (cancelled) return;
        dispatch({ type: "WAIT_RECEIVED", result });
        if (
          !result.isError &&
          (!result.structuredContent?.state ||
            result.structuredContent.state === "pending")
        ) {
          pollTimer.current = window.setTimeout(poll, 1000);
        }
      } catch {
        if (cancelled) return;
        dispatch({ type: "WAIT_TRANSPORT_FAILED" });
        pollTimer.current = window.setTimeout(poll, 3000);
      }
    };

    pollTimer.current = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, [
    embeddedFailure,
    flow.begin,
    flow.phase,
    pollRequest,
    privateAuth?.handoff_code,
  ]);

  async function begin() {
    if (!launcher.input || flow.phase === "starting") return;
    dispatch({ type: "BEGIN_REQUESTED" });
    try {
      const result = await host.callTool<BeginResult>(
        "begin_auth_login",
        sanitizeBeginArguments(launcher.input),
      );
      dispatch({ type: "BEGIN_RECEIVED", result });
    } catch {
      dispatch({ type: "BEGIN_FAILED" });
    }
  }

  function startPolling() {
    pollingStarted.current = true;
    setPollRequest((value) => value + 1);
  }

  function closePanel() {
    host.collapsed = true;
    setDismissed(true);
    window.setTimeout(() => host.reportSize(), 0);
  }

  if (dismissed) {
    return <div aria-hidden="true" style={{ height: 0, overflow: "hidden" }} />;
  }
  if (!launcher.input || !launcher.result) return null;

  if (flow.phase === "consent" || flow.phase === "starting") {
    return (
      <ConsentView
        appearance={appearance}
        targetDomain={targetDomain}
        starting={flow.phase === "starting"}
        status={flow.status}
        onContinue={() => void begin()}
      />
    );
  }

  if (flow.phase === "start_error" || flow.phase === "wait_error") {
    return (
      <MessageView
        appearance={appearance}
        title={
          flow.phase === "wait_error"
            ? "Secure login status could not be verified"
            : "Secure login could not start"
        }
        message={flow.status}
        action={{ label: "Close panel", onClick: closePanel }}
      />
    );
  }

  if (flow.phase === "terminal" && flow.outcome) {
    return (
      <TerminalView
        appearance={appearance}
        targetDomain={targetDomain}
        outcome={flow.outcome}
        connection={flow.terminalConnection}
        onClose={closePanel}
      />
    );
  }

  if (embeddedFailure === "retry") {
    return (
      <MessageView
        appearance={appearance}
        title="Secure login was interrupted"
        message="The secure session is preserved. Retry connecting to continue."
        action={{
          label: "Retry secure login",
          onClick: () => {
            fetchAdapter.state.retrieveInitializationFailed = false;
            setEmbeddedFailure(null);
          },
        }}
      />
    );
  }

  if (embeddedFailure === "fallback") {
    return (
      <MessageView
        appearance={appearance}
        title="Embedded login could not connect"
        message="Continue securely in the hosted login, then return here."
        action={
          privateAuth?.hosted_url
            ? {
                label: "Continue in hosted login",
                onClick: () => void host.openLink(privateAuth.hosted_url!),
              }
            : undefined
        }
      />
    );
  }

  if (privateAuth?.handoff_code && privateAuth.relay_base_url && connection) {
    return (
      <KernelManagedAuth
        sessionId={connection.id}
        handoffCode={privateAuth.handoff_code}
        baseUrl={privateAuth.relay_base_url}
        appearance={appearance}
        fetch={fetchAdapter.fetch as typeof fetch}
        onSuccess={startPolling}
        onError={() => {
          if (
            fetchAdapter.state.hostedFallbackAvailable &&
            privateAuth.hosted_url
          ) {
            setEmbeddedFailure("fallback");
          } else if (
            fetchAdapter.state.retrieveInitializationFailed &&
            fetchAdapter.state.exchangedJwt
          ) {
            setEmbeddedFailure("retry");
          } else {
            startPolling();
          }
        }}
      />
    );
  }

  return (
    <MessageView
      appearance={appearance}
      title="Authentication is in progress"
      message={flow.status || "This panel is securely monitoring the login."}
      action={
        privateAuth?.hosted_url
          ? {
              label: "Continue in hosted login",
              onClick: () => void host.openLink(privateAuth.hosted_url!),
            }
          : undefined
      }
    />
  );
}

const root = createRoot(document.getElementById("root")!);
host.start(() => {
  root.unmount();
  host.stop();
});
root.render(<ManagedAuthApp />);
host.reportSize();
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => host.reportSize()).observe(document.body);
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (!anchor?.href || !anchor.href.startsWith("https://kernel.sh")) return;
  event.preventDefault();
  void host.openLink(anchor.href);
});

void host.initialize();
