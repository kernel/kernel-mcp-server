import { z } from "zod";

// Flat inputs kept as aliases for the nested fields that mirror the KERNEL api.
// Tool-call analytics records which of these each call used, so they can be
// removed once usage drops off.
const AUTH_LOGIN_DEPRECATED_PARAMS = ["region", "browser_telemetry"] as const;

export const DEPRECATED_TOOL_PARAMS = {
  manage_browsers: ["proxy_id", "disable_default_proxy"],
  manage_auth_connections: [
    "proxy_mode",
    "browser_region",
    "browser_stealth",
    "browser_telemetry",
  ],
  open_auth_login: AUTH_LOGIN_DEPRECATED_PARAMS,
  begin_auth_login: AUTH_LOGIN_DEPRECATED_PARAMS,
} as const satisfies Record<string, readonly string[]>;

// Flat inputs that were removed, mapped to their replacement. A call that still
// sends one is rejected with the replacement instead of having it silently
// dropped, and analytics records the attempt.
const AUTH_LOGIN_REMOVED_PARAMS = {
  proxy_id: "`browser.proxy.id`",
  proxy_name: "`browser.proxy.name`",
} as const;

export const REMOVED_TOOL_PARAMS = {
  manage_browsers: {
    clear_proxy: '`proxy: { mode: "default" }`',
    proxy_routes: "`network.proxy_routes`",
  },
  manage_auth_connections: AUTH_LOGIN_REMOVED_PARAMS,
  open_auth_login: AUTH_LOGIN_REMOVED_PARAMS,
  begin_auth_login: AUTH_LOGIN_REMOVED_PARAMS,
  manage_proxies: {
    country: "`config.country`",
    city: "`config.city`",
    state: "`config.state`",
    custom_host: "`config.host`",
    custom_port: "`config.port`",
    custom_username: "`config.username`",
    custom_password: "`config.password`",
  },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

type RemovedParamsTool = keyof typeof REMOVED_TOOL_PARAMS;

export function removedParamMessage(
  toolName: RemovedParamsTool,
  key: string,
): string | undefined {
  const replacements: Readonly<Record<string, string>> =
    REMOVED_TOOL_PARAMS[toolName];
  return Object.prototype.hasOwnProperty.call(replacements, key)
    ? `${key} was removed; use ${replacements[key]} instead.`
    : undefined;
}

// Builds a tool input object that rejects the tool's removed params with their
// replacement. The object is loose so a removed key reaches the check instead of
// being stripped; other unknown keys are still ignored.
export function objectRejectingRemovedParams(toolName: RemovedParamsTool) {
  return <Shape extends z.ZodRawShape>(shape: Shape) =>
    z.looseObject(shape).superRefine((value, ctx) => {
      for (const key of Object.keys(REMOVED_TOOL_PARAMS[toolName])) {
        const message = removedParamMessage(toolName, key);
        if (message && (value as Record<string, unknown>)[key] !== undefined) {
          ctx.addIssue({ code: "custom", path: [key], message });
        }
      }
    });
}

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
