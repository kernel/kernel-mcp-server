import type { KernelClient } from "@/lib/mcp/kernel-client";
import type {
  LoginResponse,
  ManagedAuth,
  ManagedAuthTimelineEvent,
} from "@onkernel/sdk/resources/auth/connections";
import {
  issueAuthFlowCheckpoint,
  verifyAuthFlowCheckpoint,
} from "@/lib/mcp/tools/managed-auth-checkpoint";
import type { ManagedAuthBrowserTelemetry } from "@/lib/mcp/tools/managed-auth-telemetry";

export interface SafeAuthConnection {
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
  flow_step:
    | "DISCOVERING"
    | "AWAITING_INPUT"
    | "AWAITING_EXTERNAL_ACTION"
    | "SUBMITTING"
    | "COMPLETED"
    | null;
  flow_type: "LOGIN" | "REAUTH" | null;
  flow_expires_at: string | null;
  can_reauth: boolean | null;
  can_reauth_reason: string | null;
  error_code: string | null;
  error_message: string | null;
}

export type AuthLoginMode = "new_login" | "reauth";

export interface AuthLoginInput {
  mode: AuthLoginMode;
  connection_id?: string;
  domain?: string;
  profile_name?: string;
  project?: string;
  project_id?: string;
  save_credentials?: boolean;
  record_session?: boolean;
  browser_telemetry?: ManagedAuthBrowserTelemetry;
  proxy_id?: string;
  proxy_name?: string;
}

export class AuthLoginStartError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = "AuthLoginStartError";
  }
}

export interface BeginAuthLoginResult {
  state:
    | "embedded_ready"
    | "hosted_fallback"
    | "observing"
    | "already_authenticated";
  connection: SafeAuthConnection;
  started_new_flow: boolean;
  resume_id: string;
  /** Signed server checkpoint identifying this exact flow or its predecessor. */
  flow_checkpoint?: string;
  handoff_code?: string;
  hosted_url?: string;
}

export interface AuthWaitSelector {
  connectionId?: string;
  domain?: string;
  profileName?: string;
  requiredFlowType?: "LOGIN" | "REAUTH";
  flowCheckpoint?: string;
}

export interface AuthWaitResult {
  state: "authenticated" | "failed" | "pending";
  connection?: SafeAuthConnection;
}

const TERMINAL_ERROR_MESSAGES: Partial<
  Record<NonNullable<ManagedAuth["flow_status"]>, string>
> = {
  FAILED: "Managed authentication failed. Retry the secure login flow.",
  EXPIRED: "Managed authentication expired. Start a new secure login flow.",
  CANCELED: "Managed authentication was canceled. Start again when ready.",
};

export function toSafeAuthConnection(
  connection: ManagedAuth,
): SafeAuthConnection {
  return {
    id: connection.id,
    domain: connection.domain,
    profile_name: connection.profile_name,
    status: connection.status,
    flow_status: connection.flow_status ?? null,
    flow_step: connection.flow_step ?? null,
    flow_type: connection.flow_type ?? null,
    flow_expires_at: connection.flow_expires_at ?? null,
    can_reauth: connection.can_reauth ?? null,
    can_reauth_reason: connection.can_reauth_reason ?? null,
    error_code: connection.error_code ?? null,
    error_message: connection.flow_status
      ? (TERMINAL_ERROR_MESSAGES[connection.flow_status] ?? null)
      : null,
  };
}

export function hasLiveAuthFlow(
  connection: Pick<ManagedAuth, "flow_status" | "flow_expires_at">,
  now = new Date(),
): boolean {
  if (connection.flow_status !== "IN_PROGRESS") return false;
  if (!connection.flow_expires_at) {
    // Expiry unknown: assume the flow is live rather than accepting a stale
    // pre-flow state while a (re-)auth may still be running.
    return true;
  }
  const expiresAt = Date.parse(connection.flow_expires_at);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt > now.getTime();
}

async function findAuthConnection(
  client: KernelClient,
  selector: AuthWaitSelector,
): Promise<ManagedAuth | null> {
  if (selector.connectionId) {
    return await client.auth.connections.retrieve(selector.connectionId);
  }
  if (!selector.domain || !selector.profileName) {
    throw new AuthLoginStartError(
      "Waiting for managed authentication requires a connection ID or an exact domain and profile name.",
    );
  }

  const page = await client.auth.connections.list({
    domain: selector.domain,
    profile_name: selector.profileName,
    limit: 100,
  });
  const matches = page
    .getPaginatedItems()
    .filter(
      (item) =>
        item.domain === selector.domain &&
        item.profile_name === selector.profileName,
    );
  if (matches.length > 1 || (matches.length > 0 && page.hasNextPage())) {
    throw new AuthLoginStartError(
      "Multiple managed-auth connections matched while waiting. Select a connection explicitly.",
    );
  }
  return matches[0] ?? null;
}

async function authFlowEvents(
  client: KernelClient,
  connectionId: string,
): Promise<ManagedAuthTimelineEvent[]> {
  const page = await client.auth.connections.timeline(connectionId, {
    limit: 20,
  });
  return page
    .getPaginatedItems()
    .filter((event) => event.type === "login" || event.type === "reauth");
}

export async function issueAuthWaitCheckpoint(
  client: KernelClient,
  connectionId: string,
  kind: "after" | "event",
): Promise<string> {
  const latest = (await authFlowEvents(client, connectionId))[0] ?? null;
  if (kind === "event" && !latest) {
    throw new AuthLoginStartError(
      "The active managed-auth flow could not be identified. Retry shortly.",
    );
  }
  return kind === "event"
    ? issueAuthFlowCheckpoint({
        version: 1,
        connectionId,
        kind,
        eventId: latest!.id,
      })
    : issueAuthFlowCheckpoint({
        version: 1,
        connectionId,
        kind,
        eventId: latest?.id ?? null,
      });
}

function terminalFlowStatus(
  status: ManagedAuthTimelineEvent["status"],
): boolean {
  return status === "FAILED" || status === "EXPIRED" || status === "CANCELED";
}

async function waitFromCheckpoint(
  client: KernelClient,
  latest: SafeAuthConnection,
  token: string,
): Promise<AuthWaitResult> {
  const checkpoint = verifyAuthFlowCheckpoint(token);
  if (!checkpoint || checkpoint.connectionId !== latest.id) {
    throw new AuthLoginStartError(
      "The managed-auth wait checkpoint is invalid. Restart the secure login flow.",
    );
  }
  const events = await authFlowEvents(client, latest.id);
  let event: ManagedAuthTimelineEvent | undefined;
  if (checkpoint.kind === "event") {
    event = events.find((candidate) => candidate.id === checkpoint.eventId);
  } else if (checkpoint.eventId === null) {
    event = events[0];
  } else {
    // Timelines are newest-first. Only entries before the baseline were created
    // after the checkpoint; an absent baseline must fail closed.
    const baselineIndex = events.findIndex(
      (candidate) => candidate.id === checkpoint.eventId,
    );
    event = baselineIndex > 0 ? events.slice(0, baselineIndex)[0] : undefined;
  }
  if (!event || event.status === "IN_PROGRESS") {
    return { state: "pending", connection: latest };
  }
  if (terminalFlowStatus(event.status)) {
    return { state: "failed", connection: latest };
  }
  if (event.status === "SUCCESS" && latest.status === "AUTHENTICATED") {
    return { state: "authenticated", connection: latest };
  }
  return { state: "pending", connection: latest };
}

function authWaitDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Managed-auth wait was cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Managed-auth wait was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAuthConnection(
  client: KernelClient,
  selector: AuthWaitSelector,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AuthWaitResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 25_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1_000);
  const deadline = Date.now() + timeoutMs;
  let observedQuery = false;
  let observedLiveFlow = false;
  let latest: SafeAuthConnection | undefined;

  do {
    if (options.signal?.aborted) {
      throw new Error("Managed-auth wait was cancelled.");
    }
    try {
      const connection = await findAuthConnection(client, selector);
      observedQuery = true;
      if (connection) {
        latest = toSafeAuthConnection(connection);
        if (selector.flowCheckpoint) {
          const checkpointResult = await waitFromCheckpoint(
            client,
            latest,
            selector.flowCheckpoint,
          );
          if (checkpointResult.state !== "pending") return checkpointResult;
        } else if (hasLiveAuthFlow(latest)) {
          observedLiveFlow = true;
        } else {
          const flowFailed =
            latest.flow_status === "FAILED" ||
            latest.flow_status === "EXPIRED" ||
            latest.flow_status === "CANCELED";
          if (flowFailed && observedLiveFlow) {
            return { state: "failed", connection: latest };
          }
          if (
            latest.status === "AUTHENTICATED" &&
            (!selector.requiredFlowType ||
              latest.flow_type === selector.requiredFlowType)
          ) {
            return { state: "authenticated", connection: latest };
          }
          if (flowFailed && selector.connectionId) {
            return { state: "failed", connection: latest };
          }
        }
      }
    } catch (error) {
      if (error instanceof AuthLoginStartError) throw error;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await authWaitDelay(Math.min(pollIntervalMs, remaining), options.signal);
  } while (Date.now() <= deadline);

  if (!observedQuery) {
    throw new AuthLoginStartError(
      "Managed authentication status could not be checked. Retry the wait operation.",
    );
  }
  return { state: "pending", ...(latest && { connection: latest }) };
}

export function validateAuthLoginInput(input: AuthLoginInput): string | null {
  if (input.proxy_id && input.proxy_name) {
    return "proxy_id and proxy_name cannot be used together.";
  }

  if (input.mode === "new_login") {
    if (!input.domain || !input.profile_name) {
      return "domain and profile_name are required for new_login.";
    }
    if (input.connection_id) {
      return "connection_id is not allowed for new_login.";
    }
    return null;
  }

  if (!input.connection_id) {
    return "connection_id is required for reauth.";
  }
  if (
    input.domain ||
    input.profile_name ||
    input.save_credentials !== undefined
  ) {
    return "New-connection configuration is not allowed for reauth.";
  }
  return null;
}

function conflictExistingId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    error?: { existing_id?: unknown };
  };
  return candidate.status === 409 &&
    typeof candidate.error?.existing_id === "string"
    ? candidate.error.existing_id
    : null;
}

function loginConflictCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    error?: { code?: unknown };
  };
  return candidate.status === 409 && typeof candidate.error?.code === "string"
    ? candidate.error.code
    : null;
}

function randomResumeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `auth-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function withLoginState(
  connection: ManagedAuth,
  login: LoginResponse,
  preserveServerStep = false,
): ManagedAuth {
  return {
    ...connection,
    flow_status: "IN_PROGRESS",
    flow_step: preserveServerStep ? connection.flow_step : null,
    flow_type: login.flow_type,
    flow_expires_at: login.flow_expires_at,
    error_code: null,
    error_message: null,
    hosted_url: login.hosted_url,
  };
}

function readyResult(
  connection: ManagedAuth,
  options: {
    startedNewFlow: boolean;
    flowCheckpoint: string;
    handoffCode?: string;
    hostedUrl?: string;
  },
): BeginAuthLoginResult {
  return {
    state: options.handoffCode
      ? "embedded_ready"
      : options.hostedUrl
        ? "hosted_fallback"
        : "observing",
    connection: toSafeAuthConnection(connection),
    started_new_flow: options.startedNewFlow,
    resume_id: randomResumeId(),
    flow_checkpoint: options.flowCheckpoint,
    ...(options.handoffCode && { handoff_code: options.handoffCode }),
    ...(options.hostedUrl && { hosted_url: options.hostedUrl }),
  };
}

/**
 * Start or resume managed authentication. Capability-bearing fields are returned
 * only to the caller so the MCP tool can place them in App-private `_meta`.
 */
export async function beginAuthLogin(
  client: KernelClient,
  input: AuthLoginInput,
  now = new Date(),
): Promise<BeginAuthLoginResult> {
  const validationError = validateAuthLoginInput(input);
  if (validationError) throw new Error(validationError);

  const recordSession = input.record_session ?? true;
  const browserTelemetry = input.browser_telemetry ?? { enabled: true };

  let connection: ManagedAuth;
  if (input.mode === "new_login") {
    try {
      connection = await client.auth.connections.create({
        domain: input.domain!,
        profile_name: input.profile_name!,
        ...(input.save_credentials !== undefined && {
          save_credentials: input.save_credentials,
        }),
        record_session: recordSession,
        browser_telemetry: browserTelemetry,
        ...((input.proxy_id || input.proxy_name) && {
          proxy: {
            ...(input.proxy_id && { id: input.proxy_id }),
            ...(input.proxy_name && { name: input.proxy_name }),
          },
        }),
      });
    } catch (error) {
      const existingId = conflictExistingId(error);
      if (!existingId) throw error;
      connection = await client.auth.connections.retrieve(existingId);
    }
  } else {
    connection = await client.auth.connections.retrieve(input.connection_id!);
  }

  if (hasLiveAuthFlow(connection, now)) {
    // Handoff codes embedded in hosted_url are single-use. An existing flow may
    // already have redeemed its code in another panel, so reopening is strictly
    // observation-only. Its exact timeline event is checkpointed so a failure
    // before the first wait poll cannot be mistaken for stale authenticated state.
    return readyResult(connection, {
      startedNewFlow: false,
      flowCheckpoint: await issueAuthWaitCheckpoint(
        client,
        connection.id,
        "event",
      ),
    });
  }

  if (input.mode === "new_login" && connection.status === "AUTHENTICATED") {
    return {
      state: "already_authenticated",
      connection: toSafeAuthConnection(connection),
      started_new_flow: false,
      resume_id: randomResumeId(),
    };
  }

  const proxy =
    input.proxy_id || input.proxy_name
      ? {
          ...(input.proxy_id && { id: input.proxy_id }),
          ...(input.proxy_name && { name: input.proxy_name }),
        }
      : undefined;

  // Capture the latest server timeline identity before starting. A signed
  // "after" checkpoint then identifies the new event even if it reaches a
  // terminal state before either the App or model polls once.
  const flowCheckpoint = await issueAuthWaitCheckpoint(
    client,
    connection.id,
    "after",
  );

  try {
    const login = await client.auth.connections.login(connection.id, {
      record_session: recordSession,
      browser_telemetry: browserTelemetry,
      ...(proxy && { proxy }),
    });
    let current = withLoginState(connection, login);
    try {
      current = await client.auth.connections.retrieve(connection.id);
      current = withLoginState(current, login, true);
    } catch {
      // The login response plus the already-sanitized connection is sufficient.
    }
    return readyResult(current, {
      startedNewFlow: true,
      flowCheckpoint,
      handoffCode: login.handoff_code,
      hostedUrl: login.hosted_url,
    });
  } catch (error) {
    const conflictCode = loginConflictCode(error);
    if (conflictCode === "too_many_pending_sessions") {
      throw new AuthLoginStartError(
        "Too many managed-auth sessions are pending. Close or wait for an existing session to finish, then retry shortly.",
      );
    }
    if (conflictCode) {
      throw new AuthLoginStartError(
        `Managed authentication could not start (${conflictCode}). Retry after the current operation finishes.`,
      );
    }
    throw error;
  }
}
