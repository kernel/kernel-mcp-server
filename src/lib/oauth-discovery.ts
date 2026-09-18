const MCP_ORIGIN = "https://mcp.onkernel.com";
const OAUTH_ORIGIN = "https://auth.onkernel.com";

export const OAUTH_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp";

function mcpOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) {
    url.port = "";
    url.host = host;
  }
  return url.host === "mcp.onkernel.com" ? MCP_ORIGIN : url.origin;
}

export function oauthResourceMetadataUrl(request: Request): string {
  return `${mcpOrigin(request)}${OAUTH_RESOURCE_METADATA_PATH}`;
}

export function oauthResourceMetadata(
  request: Request,
  clerkMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const origin = mcpOrigin(request);
  const authorizationServer = origin === MCP_ORIGIN ? OAUTH_ORIGIN : origin;

  return {
    ...clerkMetadata,
    resource: `${origin}/mcp`,
    authorization_servers: [authorizationServer],
    authorization_endpoint: `${authorizationServer}/authorize`,
    token_endpoint: `${authorizationServer}/token`,
    registration_endpoint: `${authorizationServer}/register`,
    scopes_supported: ["openid"],
  };
}
