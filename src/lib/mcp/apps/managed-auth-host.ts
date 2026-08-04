import type { JsonObject } from "./managed-auth-types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type HostMessage = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { message?: string };
};

export type LauncherSnapshot = {
  input: JsonObject | null;
  result: JsonObject | null;
  theme: "light" | "dark" | "auto";
  version: number;
};

export class ManagedAuthHostBridge {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<() => void>();
  private readonly oneShotKeys = new Set<string>();
  private origin: string | null = null;
  private teardown: (() => void) | null = null;
  private snapshot: LauncherSnapshot = {
    input: null,
    result: null,
    theme: "auto",
    version: 0,
  };
  destroyed = false;
  collapsed = false;

  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (!this.origin && event.origin && event.origin !== "null") {
      this.origin = event.origin;
    }
    const message = event.data as HostMessage | undefined;
    if (!message || message.jsonrpc !== "2.0") return;

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "Host request failed"),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "ui/resource-teardown" && message.id !== undefined) {
      this.destroyed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Managed-auth App was closed"));
      }
      this.pending.clear();
      this.listeners.clear();
      this.teardown?.();
      this.post({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    if (message.id !== undefined && message.method) {
      this.post({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    switch (message.method) {
      case "ui/notifications/tool-input":
        this.update({ input: message.params?.arguments as JsonObject });
        break;
      case "ui/notifications/tool-result":
        this.update({ result: message.params ?? null });
        break;
      case "ui/notifications/host-context-changed":
        this.applyHostContext(message.params);
        break;
    }
  };

  start(teardown: () => void) {
    this.teardown = teardown;
    window.addEventListener("message", this.onMessage);
  }

  stop() {
    window.removeEventListener("message", this.onMessage);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private update(patch: Partial<Omit<LauncherSnapshot, "version">>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      version: this.snapshot.version + 1,
    };
    for (const listener of this.listeners) listener();
  }

  private post(message: JsonObject) {
    // Opaque-origin sandboxes cannot know the parent origin before the first
    // message. Only the capability-free handshake uses this fallback.
    // nosemgrep
    window.parent.postMessage(message, this.origin ?? "*");
  }

  request<T = unknown>(method: string, params: JsonObject): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.post({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject) {
    this.post({ jsonrpc: "2.0", method, params });
  }

  callTool<T>(name: string, args: JsonObject): Promise<T> {
    return this.request("tools/call", { name, arguments: args });
  }

  openLink(url: string): Promise<unknown> {
    return this.request("ui/open-link", { url });
  }

  claimOneShot(key: string): boolean {
    if (this.oneShotKeys.has(key)) return false;
    try {
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, "1");
    } catch {
      // The in-memory guard remains when opaque origins deny storage.
    }
    this.oneShotKeys.add(key);
    return true;
  }

  reportSize() {
    const launcherReady = this.snapshot.input && this.snapshot.result;
    this.notify("ui/notifications/size-changed", {
      height:
        this.collapsed || !launcherReady
          ? 1
          : Math.max(document.documentElement.scrollHeight, 360),
    });
  }

  private applyHostContext(context: JsonObject | undefined) {
    const theme = context?.theme;
    const nextTheme =
      theme === "light" || theme === "dark" ? theme : this.snapshot.theme;
    const styles = context?.styles as
      | { variables?: Record<string, string> }
      | undefined;
    if (styles?.variables) {
      for (const [key, value] of Object.entries(styles.variables)) {
        document.documentElement.style.setProperty(key, value);
      }
    }
    this.update({ theme: nextTheme });
  }

  async initialize() {
    const handshake = this.request<{ hostContext?: JsonObject }>(
      "ui/initialize",
      {
        protocolVersion: "2026-01-26",
        capabilities: {},
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        clientInfo: { name: "kernel-managed-auth", version: "1.0.2" },
      },
    );
    const timeout = new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), 4000);
    });
    try {
      const result = await Promise.race([handshake, timeout]);
      if (result?.hostContext) this.applyHostContext(result.hostContext);
    } catch {
      // Compatible hosts may still deliver tool notifications.
    }
    if (!this.destroyed) {
      this.notify("ui/notifications/initialized", {});
      this.reportSize();
    }
  }
}
