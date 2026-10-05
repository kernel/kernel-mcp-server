// Flat inputs kept as aliases for the nested fields that mirror the KERNEL api.
// Tool-call analytics records which of these each call used, so they can be
// removed once usage drops off.
const AUTH_LOGIN_DEPRECATED_PARAMS = [
  "proxy_id",
  "proxy_name",
  "region",
  "browser_telemetry",
] as const;

export const DEPRECATED_TOOL_PARAMS = {
  manage_browsers: [
    "proxy_id",
    "clear_proxy",
    "disable_default_proxy",
    "proxy_routes",
  ],
  manage_auth_connections: [
    "proxy_id",
    "proxy_name",
    "proxy_mode",
    "browser_region",
    "browser_stealth",
    "browser_telemetry",
  ],
  open_auth_login: AUTH_LOGIN_DEPRECATED_PARAMS,
  begin_auth_login: AUTH_LOGIN_DEPRECATED_PARAMS,
  manage_proxies: [
    "country",
    "city",
    "state",
    "custom_host",
    "custom_port",
    "custom_username",
    "custom_password",
  ],
} as const satisfies Record<string, readonly string[]>;

export function deprecatedParamsUsed(
  params: Record<string, unknown>,
  deprecated: readonly string[],
): string[] {
  return deprecated.filter((key) => params[key] !== undefined);
}

export function deprecatedParamConflict(
  field: string,
  params: Record<string, unknown>,
  deprecated: readonly string[],
): string | undefined {
  const used = deprecatedParamsUsed(params, deprecated);
  return used.length > 0
    ? `${field} cannot be combined with ${used.join(", ")}.`
    : undefined;
}
