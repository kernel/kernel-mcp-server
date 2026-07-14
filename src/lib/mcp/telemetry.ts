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

export const TELEMETRY_EVENT_CATALOG = `Event categories: console (console output and uncaught exceptions), network (request/response metadata), page (navigation and lifecycle), interaction (clicks, keys, scrolls), control (agent-driven API calls), connection (CDP/live-view attach/detach), system (VM health), screenshot (periodic monitor screenshots), captcha (captcha detection and solve outcomes), monitor (telemetry collector health; captured automatically with any CDP category). High-signal event types: console_error, network_loading_failed, network_response with non-2xx status, captcha_solve_result, system_oom_kill, service_crashed, monitor_disconnected (telemetry gap — treat following events as incomplete).`;
