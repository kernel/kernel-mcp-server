const MCP_ORIGIN = "https://mcp.onkernel.com";
const DEV_MCP_ORIGIN = "https://mcp.dev.onkernel.com";

// Each public MCP origin trusts exactly one Kernel authorization server and
// forwards to exactly one Kernel API. Other origins (local, preview) keep
// their own origin as authorization server.
const KERNEL_DEPLOYMENTS: Record<
  string,
  { authorizationServer: string; api: string }
> = {
  [MCP_ORIGIN]: {
    authorizationServer: "https://auth.onkernel.com",
    api: "https://api.onkernel.com",
  },
  [DEV_MCP_ORIGIN]: {
    authorizationServer: "https://auth.dev.onkernel.com",
    api: "https://api.dev.onkernel.com",
  },
};

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

// This server's own public origin, as deployed. MANAGED_AUTH_APP_ORIGIN
// already names it for the managed-auth app.
export function mcpServerOrigin(): string {
  return new URL(process.env.MANAGED_AUTH_APP_ORIGIN ?? MCP_ORIGIN).origin;
}

export function kernelDeployment(
  origin: string,
): { authorizationServer: string; api: string } | undefined {
  return KERNEL_DEPLOYMENTS[origin];
}

export function oauthResourceMetadataUrl(request: Request): string {
  return `${oauthRequestOrigin(request)}${OAUTH_RESOURCE_METADATA_PATH}`;
}

export function oauthResourceMetadata(
  request: Request,
): Record<string, unknown> {
  const origin = oauthRequestOrigin(request);
  const authorizationServer =
    kernelDeployment(origin)?.authorizationServer ?? origin;

  return {
    resource: `${origin}/mcp`,
    authorization_servers: [authorizationServer],
    authorization_endpoint: `${authorizationServer}/authorize`,
    token_endpoint: `${authorizationServer}/token`,
    registration_endpoint: `${authorizationServer}/register`,
    scopes_supported: ["openid"],
    resource_name: "KERNEL",
    resource_documentation: "https://www.kernel.sh/docs",
  };
}
