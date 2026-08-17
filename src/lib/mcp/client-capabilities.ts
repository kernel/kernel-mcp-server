import { getSupportedElicitationModes } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION =
  "io.modelcontextprotocol/oauth-client-credentials";
export const MCP_ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION =
  "io.modelcontextprotocol/enterprise-managed-authorization";

export type RawClientCapabilities = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function initializeClientCapabilities(
  body: unknown,
): RawClientCapabilities | null {
  if (
    !isRecord(body) ||
    body.method !== "initialize" ||
    !isRecord(body.params) ||
    !isRecord(body.params.capabilities)
  ) {
    return null;
  }

  return body.params.capabilities;
}

export function clientDeclaresExtension(
  capabilities: unknown,
  extension: string,
): boolean {
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  return isRecord(extensions) && isRecord(extensions[extension]);
}

export function clientElicitationModes(capabilities: unknown) {
  if (!isRecord(capabilities) || !isRecord(capabilities.elicitation)) {
    return { supportsFormMode: false, supportsUrlMode: false };
  }

  const raw = capabilities.elicitation;
  const normalized: NonNullable<ClientCapabilities["elicitation"]> = {};
  if (isRecord(raw.form)) normalized.form = raw.form;
  if (isRecord(raw.url)) normalized.url = raw.url;

  const hasInvalidMode =
    (Object.prototype.hasOwnProperty.call(raw, "form") &&
      !isRecord(raw.form)) ||
    (Object.prototype.hasOwnProperty.call(raw, "url") && !isRecord(raw.url));
  if (hasInvalidMode && !normalized.form && !normalized.url) {
    return { supportsFormMode: false, supportsUrlMode: false };
  }

  return getSupportedElicitationModes(normalized);
}
