const MCP_ORIGIN = "https://mcp.onkernel.com";
const OAUTH_ORIGIN = "https://auth.onkernel.com";
const DEV_MCP_ORIGIN = "https://mcp.dev.onkernel.com";
const DEV_OAUTH_ORIGIN = "https://auth.dev.onkernel.com";

export const OAUTH_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp";

export function oauthRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) {
    url.port = "";
    url.host = host;
  }
  if (url.host === "mcp.onkernel.com") return MCP_ORIGIN;
  if (url.host === "mcp.dev.onkernel.com") return DEV_MCP_ORIGIN;
  return url.origin;
}

export function oauthResourceMetadataUrl(request: Request): string {
  return `${oauthRequestOrigin(request)}${OAUTH_RESOURCE_METADATA_PATH}`;
}

export function oauthResourceMetadata(
  request: Request,
  clerkMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const origin = oauthRequestOrigin(request);
  let authorizationServer = origin;
  if (origin === MCP_ORIGIN) authorizationServer = OAUTH_ORIGIN;
  if (origin === DEV_MCP_ORIGIN) authorizationServer = DEV_OAUTH_ORIGIN;

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
