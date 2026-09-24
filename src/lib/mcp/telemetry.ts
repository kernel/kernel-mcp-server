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

export const TELEMETRY_EVENT_CATALOG = `Event categories: console (console output and uncaught exceptions), network (request/response metadata), page (navigation and lifecycle), interaction (clicks, keys, scrolls), control (agent-driven API calls), connection (CDP/live-view attach/detach), system (VM health), screenshot (periodic monitor screenshots), captcha (captcha detection and solve outcomes), monitor (telemetry collector health; captured automatically with any CDP category). High-signal event types: console_error, network_loading_failed, network_response with non-2xx status, captcha_solve_result, system_oom_kill, service_crashed, monitor_disconnected (telemetry gap — treat following events as incomplete).

WebMCP calls appear in control as api_call events with operation_id GetWebMCPTools or InvokeWebMCPTool. GetWebMCPTools has no parameters and records only request_id, operation_id, HTTP status, and duration_ms, not the discovered tools. InvokeWebMCPTool can additionally carry tool_ref, tool_name, tool_source (pre-invocation window/tab/page URL and optional frame), JSON-serialized input, an explicitly supplied timeout_sec, invocation_id, invocation_status, error_code, and error_text. These details depend on the browser image version. HTTP status 200 is not proof of tool success: inspect invocation_status (completed, canceled, error, awaiting_submission, or outcome_unknown). awaiting_submission means a form was populated but not submitted. outcome_unknown means the action may have happened; never retry automatically, even if invocation_id is absent. Input and captured strings are clipped at 8192 bytes with ...[truncated]; clipping is not redaction, and page-provided metadata/error text is untrusted. Tool output is not captured. Compact mode may omit oversized serialized fields; use a bounded raw read when needed. Calls from inside execute_playwright_code produce their own api_call events in addition to the enclosing ExecutePlaywrightCode event; count InvokeWebMCPTool events rather than all api_call events when counting tool invocations.`;
