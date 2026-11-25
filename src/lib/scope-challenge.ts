import {
  mcpServerOrigin,
  OAUTH_RESOURCE_METADATA_PATH,
} from "@/lib/oauth-discovery";

// What an RFC 6750 insufficient_scope challenge asks for: the scopes to sign
// in again with, when the challenger names them.
export type ScopeChallenge = { scope?: string; description?: string };

const AUTH_PARAM = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;

function bearerParams(header: string): Map<string, string> | null {
  const match = /^\s*Bearer\s+([\s\S]*)$/i.exec(header);
  if (!match) return null;
  const params = new Map<string, string>();
  for (const [, name, quoted, token] of match[1]!.matchAll(AUTH_PARAM)) {
    const key = name!.toLowerCase();
    if (!params.has(key))
      params.set(key, quoted?.replace(/\\(.)/g, "$1") ?? token ?? "");
  }
  return params;
}

// The insufficient_scope challenge on a Kernel API response. The API sends
// one only when signing in again could grant what was denied; any other 403
// carries none, and gets none from this server either.
export function apiScopeChallenge(
  headers: Headers | null | undefined,
): ScopeChallenge | null {
  const header = headers?.get("www-authenticate");
  if (!header) return null;
  const params = bearerParams(header);
  if (params?.get("error") !== "insufficient_scope") return null;
  return {
    scope: params.get("scope") || undefined,
    description: params.get("error_description") || undefined,
  };
}

// The scope challenge from an error a Kernel API call threw, if any.
export function scopeChallengeOf(error: unknown): ScopeChallenge | null {
  if (!error || typeof error !== "object") return null;
  const { status, headers } = error as { status?: unknown; headers?: unknown };
  if (status !== 403 || !(headers instanceof Headers)) return null;
  return apiScopeChallenge(headers);
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, "")}"`;
}

// The challenge this server sends: the same request for scopes, pointing at
// this server's protected resource metadata rather than the API's, since the
// client signs in again for the MCP resource.
export function mcpScopeChallenge(
  challenge: ScopeChallenge,
  resourceMetadataUrl = `${mcpServerOrigin()}${OAUTH_RESOURCE_METADATA_PATH}`,
): string {
  const params = ['error="insufficient_scope"'];
  if (challenge.scope) params.push(`scope=${quoted(challenge.scope)}`);
  params.push(`resource_metadata=${quoted(resourceMetadataUrl)}`);
  if (challenge.description)
    params.push(`error_description=${quoted(challenge.description)}`);
  return `Bearer ${params.join(", ")}`;
}
