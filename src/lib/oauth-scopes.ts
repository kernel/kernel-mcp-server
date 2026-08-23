export const MCP_OAUTH_SCOPE = "mcp";
export const CLERK_OAUTH_SCOPE = "openid";

export function validatePublicOAuthScope(
  scope: string | null | undefined,
): string {
  if (!scope?.trim()) return MCP_OAUTH_SCOPE;
  const tokens = [...new Set(scope.trim().split(/\s+/))];
  if (
    tokens.length === 0 ||
    tokens.some(
      (token) => token !== MCP_OAUTH_SCOPE && token !== CLERK_OAUTH_SCOPE,
    )
  ) {
    throw new Error("Unsupported OAuth scope");
  }
  return tokens.join(" ");
}
