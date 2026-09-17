const MCP_ORIGIN = "https://mcp.onkernel.com";
const OAUTH_ORIGIN = "https://auth.onkernel.com";

export function oauthResourceMetadata(
  request: Request,
  clerkMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) {
    url.port = "";
    url.host = host;
  }
  const isProduction = url.host === "mcp.onkernel.com";
  const resource = isProduction ? MCP_ORIGIN : url.origin;
  const authorizationServer = isProduction ? OAUTH_ORIGIN : url.origin;

  return {
    ...clerkMetadata,
    resource,
    authorization_servers: [authorizationServer],
    authorization_endpoint: `${authorizationServer}/authorize`,
    token_endpoint: `${authorizationServer}/token`,
    registration_endpoint: `${authorizationServer}/register`,
    scopes_supported: ["openid"],
  };
}
