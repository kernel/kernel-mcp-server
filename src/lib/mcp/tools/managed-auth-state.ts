import type { KernelClient } from "@/lib/mcp/kernel-client";
import type {
  LoginResponse,
  ManagedAuth,
} from "@onkernel/sdk/resources/auth/connections";

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
  save_credentials?: boolean;
  proxy_id?: string;
  proxy_name?: string;
}

export interface AuthNextAction {
  tool:
    | "open_auth_login"
    | "manage_auth_connections"
    | "manage_browsers"
    | "ask_user";
  arguments: Record<string, unknown>;
  reason: string;
  required_user_input?: string[];
}

export interface AuthSelection {
  domain_filter: string | null;
  outcome: "none" | "single" | "multiple" | "page_incomplete";
}

export class AuthLoginStartError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
    this.name = "AuthLoginStartError";
  }
}

export interface AuthSteering {
  selection: AuthSelection;
  next_action?: AuthNextAction;
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
  /**
   * The connection's flow_expires_at captured before any new flow was started.
   * Waiters use it as a baseline so a completed flow from before this begin
   * call is never mistaken for the newly requested one.
   */
  previous_flow_expires_at: string | null;
  handoff_code?: string;
  hosted_url?: string;
}

export interface AuthWaitSelector {
  connectionId?: string;
  domain?: string;
  profileName?: string;
  requiredFlowType?: "LOGIN" | "REAUTH";
  previousFlowExpiresAt?: string | null;
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
        if (hasLiveAuthFlow(latest)) observedLiveFlow = true;
        // A wait is flow-guarded when the caller supplied a baseline (and/or a
        // required flow type): only a flow that completed after that baseline
        // counts. The flow type is never assumed ahead of time — the server
        // chooses LOGIN vs REAUTH — so any successful new flow satisfies the
        // guard. The observed-live-flow backstop covers servers that clear
        // flow_expires_at once a flow reaches a terminal state.
        const flowGuarded =
          selector.requiredFlowType !== undefined ||
          selector.previousFlowExpiresAt !== undefined;
        const flowFailed =
          latest.flow_status === "FAILED" ||
          latest.flow_status === "EXPIRED" ||
          latest.flow_status === "CANCELED";
        // A terminal failure observed only after this wait saw the flow live
        // is authoritative even when the connection still reads AUTHENTICATED
        // (e.g. a failed re-auth keeps its previous session): the App shows
        // the failure, so the wait must not report success. A terminal
        // failure with no live flow observed predates this wait and leaves
        // the authenticated state usable.
        const observedFlowFailed = observedLiveFlow && flowFailed;
        const requiredFlowCompleted =
          !flowGuarded ||
          (latest.flow_status === "SUCCESS" &&
            (selector.requiredFlowType === undefined ||
              latest.flow_type === selector.requiredFlowType) &&
            (selector.previousFlowExpiresAt === undefined ||
              latest.flow_expires_at !== selector.previousFlowExpiresAt ||
              observedLiveFlow));
        // AUTHENTICATED with a live in-progress flow means a (re-)auth is
        // still running: report pending instead of the stale pre-flow state.
        if (
          latest.status === "AUTHENTICATED" &&
          !hasLiveAuthFlow(latest) &&
          !observedFlowFailed &&
          requiredFlowCompleted
        ) {
          return { state: "authenticated", connection: latest };
        }
        if (flowFailed) {
          // A terminal flow this wait never saw live predates it: an old failed
          // attempt (the common case when the user is about to click Continue
          // for a retry), or one matching the caller's baseline. Keep polling
          // for the new flow instead of reporting a stale failure.
          const terminalIsStale =
            !observedLiveFlow &&
            (selector.previousFlowExpiresAt !== undefined
              ? latest.flow_expires_at === selector.previousFlowExpiresAt
              : !flowGuarded);
          if (!terminalIsStale) {
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

export function deriveAuthNextAction({
  items,
  hasMore,
  nextOffset,
  offset,
  domainFilter,
  profileFilter,
}: {
  items: SafeAuthConnection[];
  hasMore: boolean;
  nextOffset: number | null;
  offset?: number;
  domainFilter?: string;
  profileFilter?: string;
}): AuthSteering {
  const domain_filter = domainFilter ?? null;

  if (hasMore || (offset ?? 0) > 0) {
    return {
      selection: { domain_filter, outcome: "page_incomplete" },
      next_action: hasMore
        ? {
            tool: "manage_auth_connections",
            arguments: {
              action: "list",
              ...(domainFilter && { domain_filter: domainFilter }),
              ...(profileFilter && { profile_name: profileFilter }),
              ...(nextOffset !== null && { offset: nextOffset }),
            },
            reason:
              "More matching connections exist. Fetch every page and retain the earlier matches; do not infer a unique profile from this page.",
          }
        : {
            tool: "ask_user",
            arguments: {
              current_page: items.map(
                ({ id, profile_name, domain, status }) => ({
                  connection_id: id,
                  profile_name,
                  domain,
                  status,
                }),
              ),
              include_matches_from_prior_pages: true,
            },
            required_user_input: ["connection_id"],
            reason:
              "This is a continuation page. Combine it with every retained earlier page before deciding; if the combined result has multiple matches, ask the user to choose.",
          },
    };
  }

  if (items.length === 0) {
    return {
      selection: { domain_filter, outcome: "none" },
      ...(domainFilter && {
        next_action: {
          tool: "open_auth_login" as const,
          arguments: { mode: "new_login", domain: domainFilter },
          required_user_input: ["profile_name"],
          reason:
            "No connection matches this domain. Ask which profile name to use and get consent before opening secure login.",
        },
      }),
    };
  }

  if (items.length > 1) {
    return {
      selection: { domain_filter, outcome: "multiple" },
      next_action: {
        tool: "ask_user",
        arguments: {
          choices: items.map(({ id, profile_name, domain, status }) => ({
            connection_id: id,
            profile_name,
            domain,
            status,
          })),
        },
        required_user_input: ["connection_id"],
        reason:
          "Multiple profiles match. Ask the user to choose a profile; do not select one automatically.",
      },
    };
  }

  const connection = items[0];
  if (connection.status === "AUTHENTICATED") {
    if (hasLiveAuthFlow(connection)) {
      return {
        selection: { domain_filter, outcome: "single" },
        next_action: {
          tool: "manage_auth_connections",
          arguments: {
            action: "wait",
            id: connection.id,
          },
          reason:
            "This connection is authenticated but an authentication flow is still in progress. Wait for it to complete before creating a browser.",
        },
      };
    }
    return {
      selection: { domain_filter, outcome: "single" },
      next_action: {
        tool: "manage_browsers",
        arguments: {
          action: "create",
          profile_name: connection.profile_name,
        },
        reason:
          "This connection is authenticated. Create the browser with its existing profile; do not start another login.",
      },
    };
  }

  return {
    selection: { domain_filter, outcome: "single" },
    next_action: {
      tool: "open_auth_login",
      arguments: {
        mode: "reauth",
        connection_id: connection.id,
      },
      reason:
        connection.flow_status === "IN_PROGRESS"
          ? "Authentication is already in progress. Ask for consent, then reopen the secure panel to resume or observe it."
          : "This profile needs authentication. Ask for consent before opening the secure login panel.",
    },
  };
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
    previousFlowExpiresAt: string | null;
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
    previous_flow_expires_at: options.previousFlowExpiresAt,
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

  let connection: ManagedAuth;
  if (input.mode === "new_login") {
    try {
      connection = await client.auth.connections.create({
        domain: input.domain!,
        profile_name: input.profile_name!,
        ...(input.save_credentials !== undefined && {
          save_credentials: input.save_credentials,
        }),
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

  const previousFlowExpiresAt = connection.flow_expires_at ?? null;

  if (hasLiveAuthFlow(connection, now)) {
    // Handoff codes embedded in hosted_url are single-use. An existing flow may
    // already have redeemed its code in another panel, so reopening is strictly
    // observation-only until the API can mint a fresh resume capability.
    return readyResult(connection, {
      startedNewFlow: false,
      previousFlowExpiresAt,
    });
  }

  if (input.mode === "new_login" && connection.status === "AUTHENTICATED") {
    return {
      state: "already_authenticated",
      connection: toSafeAuthConnection(connection),
      started_new_flow: false,
      resume_id: randomResumeId(),
      previous_flow_expires_at: previousFlowExpiresAt,
    };
  }

  const proxy =
    input.proxy_id || input.proxy_name
      ? {
          ...(input.proxy_id && { id: input.proxy_id }),
          ...(input.proxy_name && { name: input.proxy_name }),
        }
      : undefined;

  try {
    const login = await client.auth.connections.login(
      connection.id,
      proxy ? { proxy } : undefined,
    );
    let current = withLoginState(connection, login);
    try {
      current = await client.auth.connections.retrieve(connection.id);
      current = withLoginState(current, login, true);
    } catch {
      // The login response plus the already-sanitized connection is sufficient.
    }
    return readyResult(current, {
      startedNewFlow: true,
      previousFlowExpiresAt,
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
