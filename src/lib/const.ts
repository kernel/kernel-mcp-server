// Ensure these are set in the environment
if (!process.env.KERNEL_CLI_PROD_CLIENT_ID) {
  throw new Error("KERNEL_CLI_PROD_CLIENT_ID is not set");
}
if (!process.env.KERNEL_CLI_STAGING_CLIENT_ID) {
  throw new Error("KERNEL_CLI_STAGING_CLIENT_ID is not set");
}
if (!process.env.KERNEL_CLI_DEV_CLIENT_ID) {
  throw new Error("KERNEL_CLI_DEV_CLIENT_ID is not set");
}

// Shared client IDs that use JWT round-trip instead of Redis for org persistence
export const SHARED_CLIENT_IDS = [
  process.env.KERNEL_CLI_PROD_CLIENT_ID,
  process.env.KERNEL_CLI_STAGING_CLIENT_ID,
  process.env.KERNEL_CLI_DEV_CLIENT_ID,
].filter(Boolean) as string[];

export function isLegacyNonPkceClient(clientId: string): boolean {
  return (process.env.OAUTH_LEGACY_NON_PKCE_CLIENT_IDS ?? "")
    .split(",")
    .some((allowedClientId) => allowedClientId.trim() === clientId);
}

// Sliding TTL for refresh_token→org_id mapping (defaults to 30 days)
export const REFRESH_TOKEN_ORG_TTL_SECONDS = 60 * 60 * 24 * 30;
