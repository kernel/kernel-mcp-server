export function oauthResourceForIssuer(issuer: string): string {
  return new URL(issuer).origin;
}

export function resolveOAuthResource({
  requestedResource,
  issuer,
}: {
  requestedResource: string | null | undefined;
  issuer: string;
}): string {
  const expected = oauthResourceForIssuer(issuer);
  if (!requestedResource) return expected;

  let requested: URL;
  try {
    requested = new URL(requestedResource);
  } catch {
    throw new Error("Invalid OAuth resource");
  }
  if (
    requested.username ||
    requested.password ||
    requested.search ||
    requested.hash ||
    !["", "/", "/mcp"].includes(requested.pathname) ||
    requested.origin !== expected
  ) {
    throw new Error("OAuth resource does not identify this MCP server");
  }
  return requested.pathname === "/mcp" ? `${expected}/mcp` : expected;
}

export function oauthResourceAllowsRequest({
  resource,
  requestUrl,
}: {
  resource: string;
  requestUrl: string;
}): boolean {
  const request = new URL(requestUrl);
  const resolved = resolveOAuthResource({
    requestedResource: resource,
    issuer: request.origin,
  });
  const resourcePath = new URL(resolved).pathname;
  return resourcePath === "/" || resourcePath === request.pathname;
}
