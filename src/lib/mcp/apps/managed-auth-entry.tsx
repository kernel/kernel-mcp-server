import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppearanceProvider,
  KernelManagedAuth,
  LocalizationProvider,
  Shell,
  StepError,
  StepPrime,
  StepSuccess,
} from "@onkernel/managed-auth-react";
import "@onkernel/managed-auth-react/styles.css";

const FAILURE_CONTEXT =
  "Managed authentication stopped. Verify its terminal state and report the recovery option; do not continue the protected action.";

type JsonObject = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type SafeConnection = {
  id: string;
  domain: string;
  profile_name: string;
  status: "AUTHENTICATED" | "NEEDS_AUTH";
  flow_status:
    | "IN_PROGRESS"
    | "SUCCESS"
    | "FAILED"
    | "EXPIRED"
    | "CANCELED"
    | null;
  flow_type: "LOGIN" | "REAUTH" | null;
  flow_expires_at: string | null;
};
type BeginResult = {
  structuredContent?: {
    state?: string;
    connection?: SafeConnection;
    resume_id?: string;
    app_private?: {
      handoff_code?: string;
      hosted_url?: string;
      relay_base_url?: string;
    };
  };
  _meta?: {
    auth_login?: {
      handoff_code?: string;
      hosted_url?: string;
      relay_base_url?: string;
    };
  };
  isError?: boolean;
};

let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();
// Reply target origin learned from the first validated host message. Outbound
// messages can carry capability-bearing URLs (the hosted fallback via
// ui/open-link), so once the host's origin is known we stop broadcasting to
// "*". The "*" fallback only exists because opaque-origin sandbox iframes
// cannot know the host origin before the first inbound message.
let hostOrigin: string | null = null;
let destroyed = false;
let collapsed = false;
let reactRoot: Root | null = null;
let completeToolInput: JsonObject | null = null;
let launcherToolResult: JsonObject | null = null;
let hostTheme: "light" | "dark" | "auto" = "auto";
const listeners = new Set<() => void>();
let stateVersion = 0;
const oneShotKeys = new Set<string>();

function claimOneShot(key: string): boolean {
  if (oneShotKeys.has(key)) return false;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
  } catch {
    // Opaque sandbox origins may deny storage; the in-memory guard still works.
  }
  oneShotKeys.add(key);
  return true;
}

function notifyStateChanged() {
  stateVersion += 1;
  for (const listener of listeners) listener();
}

function postToHost(message: JsonObject) {
  // The "*" fallback is only reachable before the host's first inbound
  // message (opaque-origin sandboxes cannot know the host origin earlier);
  // those early messages are the ui/initialize handshake and carry no
  // capability-bearing data. Everything after is pinned to hostOrigin.
  // nosemgrep
  window.parent.postMessage(message, hostOrigin ?? "*");
}

function sendRequest(method: string, params: JsonObject): Promise<unknown> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    postToHost({ jsonrpc: "2.0", id, method, params });
  });
}

function sendNotification(method: string, params: JsonObject) {
  postToHost({ jsonrpc: "2.0", method, params });
}

function callTool(name: string, args: JsonObject): Promise<BeginResult> {
  return sendRequest("tools/call", {
    name,
    arguments: args,
  }) as Promise<BeginResult>;
}

function applyHostContext(context: JsonObject | undefined) {
  const theme = context?.theme;
  if (theme === "light" || theme === "dark") hostTheme = theme;
  const styles = context?.styles as
    | { variables?: Record<string, string> }
    | undefined;
  if (styles?.variables) {
    for (const [key, value] of Object.entries(styles.variables)) {
      document.documentElement.style.setProperty(key, value);
    }
  }
  notifyStateChanged();
}

function reportSize() {
  sendNotification("ui/notifications/size-changed", {
    height: collapsed
      ? 1
      : Math.max(document.documentElement.scrollHeight, 360),
  });
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  // Pin replies to the host's origin once known. Ignore "null" (opaque
  // origins): they cannot be targeted, so the "*" fallback stays in effect.
  if (!hostOrigin && event.origin && event.origin !== "null") {
    hostOrigin = event.origin;
  }
  const message = event.data as
    | {
        jsonrpc?: string;
        id?: number;
        method?: string;
        params?: JsonObject;
        result?: unknown;
        error?: { message?: string };
      }
    | undefined;
  if (!message || message.jsonrpc !== "2.0") return;

  if (message.id !== undefined && !message.method) {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Host request failed"));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (message.method === "ui/resource-teardown" && message.id !== undefined) {
    destroyed = true;
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error("Managed-auth App was closed"));
    }
    pendingRequests.clear();
    listeners.clear();
    reactRoot?.unmount();
    reactRoot = null;
    postToHost({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined && message.method) {
    postToHost({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  switch (message.method) {
    case "ui/notifications/tool-input":
      completeToolInput = message.params?.arguments as JsonObject;
      notifyStateChanged();
      break;
    case "ui/notifications/tool-result":
      launcherToolResult = message.params ?? null;
      notifyStateChanged();
      break;
    case "ui/notifications/host-context-changed":
      applyHostContext(message.params);
      break;
  }
});

function useLauncherData() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stateVersion,
  );
  return {
    input: completeToolInput,
    result: launcherToolResult,
    theme: hostTheme,
  };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sanitizeBeginArguments(input: JsonObject): JsonObject {
  const allowed = [
    "mode",
    "connection_id",
    "domain",
    "profile_name",
    "save_credentials",
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
  const launcher = useLauncherData();
  const [beginResult, setBeginResult] = useState<BeginResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [terminal, setTerminal] = useState<"success" | "failure" | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [embeddedInitFailed, setEmbeddedInitFailed] = useState(false);
  const [embeddedRetryRequired, setEmbeddedRetryRequired] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const pollingStarted = useRef(false);
  const mountedFlow = useRef(false);
  const hostedFallbackAvailable = useRef(true);
  const exchangedJwt = useRef<string | null>(null);
  const retrieveInitializationFailed = useRef(false);

  const launcherContent = launcher.result?.structuredContent as
    | {
        connection?: { domain?: string; profile_name?: string };
      }
    | undefined;
  const targetDomain =
    (launcherContent?.connection?.domain as string | undefined) ??
    (launcher.input?.domain as string | undefined) ??
    "this site";
  const connection = beginResult?.structuredContent?.connection;
  const resumeId = beginResult?.structuredContent?.resume_id;
  const privateAuth =
    beginResult?._meta?.auth_login ??
    beginResult?.structuredContent?.app_private;

  const appearance = useMemo(
    () => ({ theme: launcher.theme, layout: { skipPrimeStep: true } }),
    [launcher.theme],
  );

  const managedAuthFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const pathname = new URL(url, window.location.href).pathname;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const isExchange =
        method === "POST" &&
        /\/auth\/connections\/[^/]+\/exchange$/.test(pathname);
      const isRetrieve =
        method === "GET" && /\/auth\/connections\/[^/]+$/.test(pathname);

      if (isExchange && exchangedJwt.current) {
        return new Response(JSON.stringify({ jwt: exchangedJwt.current }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const attempts = isRetrieve ? 3 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const response = await fetch(input, init);
          if (isExchange && !isRetryableHttpStatus(response.status)) {
            // A definitive exchange response means the hosted URL is no longer
            // a safe fallback. Retryable failures leave it for the hosted UI.
            hostedFallbackAvailable.current = false;
            if (response.ok) {
              const data = (await response.clone().json()) as { jwt?: unknown };
              if (typeof data.jwt === "string") exchangedJwt.current = data.jwt;
            }
          }
          if (isRetrieve) {
            if (response.ok) retrieveInitializationFailed.current = false;
            else if (
              isRetryableHttpStatus(response.status) &&
              attempt + 1 < attempts
            ) {
              await new Promise((resolve) =>
                window.setTimeout(resolve, 250 * (attempt + 1)),
              );
              continue;
            } else {
              retrieveInitializationFailed.current = isRetryableHttpStatus(
                response.status,
              );
            }
          }
          return response;
        } catch (error) {
          if (isRetrieve && attempt + 1 < attempts) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, 250 * (attempt + 1)),
            );
            continue;
          }
          if (isRetrieve) retrieveInitializationFailed.current = true;
          throw error;
        }
      }
      throw new Error("Managed-auth request retry exhausted");
    },
    [],
  );

  useEffect(() => {
    reportSize();
  });

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, []);

  function terminalContext(outcome: "success" | "failure") {
    if (outcome === "failure") {
      return {
        text: FAILURE_CONTEXT,
        structuredContent: {
          kind: "kernel.managed_auth.terminal",
          version: 1,
          outcome,
        },
      };
    }

    const domain = connection?.domain ?? targetDomain;
    const profileName = connection?.profile_name;
    const safeTarget = {
      domain,
      ...(profileName && { profile_name: profileName }),
    };
    return {
      text: `Kernel managed authentication reported completion for ${JSON.stringify(safeTarget)}. Verify the connection through manage_auth_connections before continuing the pending task.`,
      structuredContent: {
        kind: "kernel.managed_auth.terminal",
        version: 1,
        outcome,
        ...safeTarget,
      },
    };
  }

  async function publishTerminal(outcome: "success" | "failure") {
    if (!resumeId || destroyed) return;
    const contextKey = `kernel-managed-auth-context:${resumeId}:${outcome}`;
    if (!claimOneShot(contextKey)) return;
    const context = terminalContext(outcome);
    try {
      await sendRequest("ui/update-model-context", {
        content: [{ type: "text", text: context.text }],
        structuredContent: context.structuredContent,
      });
    } catch {
      // The verified terminal state remains visible in the App.
    }
  }

  function finish(outcome: "success" | "failure") {
    if (terminal || destroyed) return;
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    setTerminal(outcome);
    setStatusText("");
    void publishTerminal(outcome);
  }

  async function checkStatus() {
    if (!connection?.id || destroyed || terminal) return;
    const knownExpiry = connection.flow_expires_at
      ? Date.parse(connection.flow_expires_at)
      : Number.NaN;
    try {
      const result = await callTool("get_auth_login_status", {
        connection_id: connection.id,
      });
      const current = result.structuredContent?.connection;
      if (!current) throw new Error("No connection status returned");
      if (
        current.flow_status === "FAILED" ||
        current.flow_status === "EXPIRED" ||
        current.flow_status === "CANCELED"
      ) {
        finish("failure");
        return;
      }
      const expiresAt = current.flow_expires_at
        ? Date.parse(current.flow_expires_at)
        : Number.NaN;
      if (
        current.flow_status !== "SUCCESS" &&
        Number.isFinite(expiresAt) &&
        expiresAt <= Date.now()
      ) {
        finish("failure");
        return;
      }
      if (
        current.flow_status === "SUCCESS" &&
        current.status === "AUTHENTICATED"
      ) {
        finish("success");
        return;
      }
      setStatusText("Secure login is still in progress…");
      pollTimer.current = window.setTimeout(checkStatus, 2000);
    } catch {
      if (Number.isFinite(knownExpiry) && knownExpiry <= Date.now()) {
        finish("failure");
        return;
      }
      setStatusText("Checking secure login status…");
      pollTimer.current = window.setTimeout(checkStatus, 3000);
    }
  }

  async function begin() {
    if (!launcher.input || starting) {
      setStatusText("Secure login input is unavailable. Close and retry.");
      return;
    }
    setStarting(true);
    setStatusText("Preparing secure login…");
    try {
      const result = await callTool("begin_auth_login", {
        ...sanitizeBeginArguments(launcher.input),
      });
      if (result.isError || !result.structuredContent?.connection) {
        throw new Error("Secure login could not be prepared");
      }
      setBeginResult(result);
      setStatusText("");
    } catch {
      setStatusText(
        "Secure login could not start. Close this panel and retry.",
      );
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!beginResult || !connection || terminal || pollingStarted.current) {
      return;
    }
    if (beginResult.structuredContent?.state === "already_authenticated") {
      finish("success");
      return;
    }
    if (
      beginResult.structuredContent?.state === "observing" ||
      !privateAuth?.handoff_code ||
      embeddedInitFailed
    ) {
      pollingStarted.current = true;
      pollTimer.current = window.setTimeout(checkStatus, 500);
    }
  });

  function closePanel() {
    collapsed = true;
    setDismissed(true);
    window.setTimeout(reportSize, 0);
  }

  if (dismissed) {
    return <div aria-hidden="true" style={{ height: 0, overflow: "hidden" }} />;
  }

  if (!launcher.input || !launcher.result) {
    return <div className="kernel-app-loading">Preparing secure login…</div>;
  }

  if (!beginResult) {
    return (
      <AppearanceProvider appearance={appearance}>
        <LocalizationProvider>
          <Shell appearance={appearance}>
            <StepPrime
              targetDomain={targetDomain}
              onContinue={begin}
              isLoading={starting}
            />
            {statusText && <p className="kernel-app-status">{statusText}</p>}
          </Shell>
        </LocalizationProvider>
      </AppearanceProvider>
    );
  }

  if (terminal) {
    return (
      <AppearanceProvider appearance={appearance}>
        <LocalizationProvider>
          <Shell appearance={appearance}>
            {terminal === "success" ? (
              <StepSuccess targetDomain={targetDomain} />
            ) : (
              <StepError
                targetDomain={targetDomain}
                errorMessage="Managed authentication stopped."
              />
            )}
            <div className="kernel-app-actions">
              <p className="kernel-app-status">
                {terminal === "success"
                  ? "Connection status saved for Claude’s next turn."
                  : "Failure status saved for Claude’s next turn."}
              </p>
              <button className="kernel-app-button" onClick={closePanel}>
                Close panel
              </button>
            </div>
          </Shell>
        </LocalizationProvider>
      </AppearanceProvider>
    );
  }

  if (embeddedRetryRequired) {
    return (
      <AppearanceProvider appearance={appearance}>
        <LocalizationProvider>
          <Shell appearance={appearance}>
            <div className="kernel-app-fallback">
              <h2>Secure login was interrupted</h2>
              <p>
                The secure session is preserved. Retry connecting to continue.
              </p>
              <button
                className="kernel-app-button"
                onClick={() => {
                  retrieveInitializationFailed.current = false;
                  setEmbeddedRetryRequired(false);
                }}
              >
                Retry secure login
              </button>
            </div>
          </Shell>
        </LocalizationProvider>
      </AppearanceProvider>
    );
  }

  if (embeddedInitFailed) {
    return (
      <AppearanceProvider appearance={appearance}>
        <LocalizationProvider>
          <Shell appearance={appearance}>
            <div className="kernel-app-fallback">
              <h2>Embedded login could not connect</h2>
              <p>Continue securely in the hosted login, then return here.</p>
              {privateAuth?.hosted_url && (
                <button
                  className="kernel-app-button"
                  onClick={() =>
                    void sendRequest("ui/open-link", {
                      url: privateAuth.hosted_url!,
                    })
                  }
                >
                  Continue in hosted login
                </button>
              )}
            </div>
          </Shell>
        </LocalizationProvider>
      </AppearanceProvider>
    );
  }

  if (
    privateAuth?.handoff_code &&
    privateAuth.relay_base_url &&
    connection &&
    !mountedFlow.current
  ) {
    mountedFlow.current = true;
  }

  if (mountedFlow.current && privateAuth?.handoff_code && connection) {
    return (
      <KernelManagedAuth
        sessionId={connection.id}
        handoffCode={privateAuth.handoff_code}
        baseUrl={privateAuth.relay_base_url}
        appearance={appearance}
        fetch={managedAuthFetch as typeof fetch}
        onSuccess={() => void checkStatus()}
        onError={() => {
          if (hostedFallbackAvailable.current && privateAuth.hosted_url) {
            setEmbeddedInitFailed(true);
            return;
          }
          if (retrieveInitializationFailed.current && exchangedJwt.current) {
            setEmbeddedRetryRequired(true);
            return;
          }
          void checkStatus();
        }}
      />
    );
  }

  return (
    <AppearanceProvider appearance={appearance}>
      <LocalizationProvider>
        <Shell appearance={appearance}>
          <div className="kernel-app-fallback">
            <h2>Authentication is in progress</h2>
            <p>
              {statusText || "This panel is securely monitoring the login."}
            </p>
            {privateAuth?.hosted_url && (
              <button
                className="kernel-app-button"
                onClick={() =>
                  void sendRequest("ui/open-link", {
                    url: privateAuth.hosted_url!,
                  })
                }
              >
                Continue in hosted login
              </button>
            )}
          </div>
        </Shell>
      </LocalizationProvider>
    </AppearanceProvider>
  );
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a");
  if (!anchor?.href || !anchor.href.startsWith("https://kernel.sh")) return;
  event.preventDefault();
  void sendRequest("ui/open-link", { url: anchor.href });
});

async function initialize() {
  // Mount before the host handshake. Some hosts create the App container but
  // delay or omit the ui/initialize response; waiting here would leave a
  // completely blank panel with no actionable diagnostic.
  if (destroyed) return;
  reactRoot = createRoot(document.getElementById("root")!);
  reactRoot.render(<ManagedAuthApp />);
  reportSize();
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(reportSize).observe(document.body);
  }

  const handshake = sendRequest("ui/initialize", {
    protocolVersion: "2026-01-26",
    capabilities: {},
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    clientInfo: { name: "kernel-managed-auth", version: "1.0.1" },
  }) as Promise<{ hostContext?: JsonObject }>;
  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), 4000);
  });

  try {
    const result = await Promise.race([handshake, timeout]);
    if (result?.hostContext) applyHostContext(result.hostContext);
  } catch {
    // Compatible hosts may still deliver tool notifications.
  }

  if (!destroyed) {
    sendNotification("ui/notifications/initialized", {});
    reportSize();
  }
}

void initialize();
