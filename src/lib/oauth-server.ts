const CLI_AUTH_HOSTS = new Set(["auth.onkernel.com", "auth.dev.onkernel.com"]);

export function isMcpAuthorizationServer(origin: string): boolean {
  return !CLI_AUTH_HOSTS.has(new URL(origin).hostname);
}
