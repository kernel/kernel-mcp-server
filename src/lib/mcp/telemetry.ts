export const telemetryEventCategories = [
  "console",
  "network",
  "page",
  "interaction",
  "control",
  "connection",
  "system",
  "screenshot",
  "captcha",
  "monitor",
] as const;

export const TELEMETRY_EVENT_CATALOG = `event categories: console (console output and uncaught exceptions), network (request/response metadata), page (navigation and lifecycle), interaction (clicks, keys, scrolls), control (agent-driven api calls), connection (cdp/live-view attach/detach), system (vm health), screenshot (periodic monitor screenshots), captcha (verification prompts a site displayed during the session), monitor (telemetry collector health; captured automatically with any cdp category). high-signal event types: console_error, network_loading_failed, network_response with non-2xx status, system_oom_kill, service_crashed, monitor_disconnected (telemetry gap — treat following events as incomplete).`;
