import {
  getOAuthClientMetadataValue,
  setOAuthClientMetadataValue,
} from "./redis";

const OAUTH_CLIENT_METADATA_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface OAuthClientMetadata {
  clientName: string;
  clientUri?: string;
  redirectUris: string[];
}

function key(clientId: string): string {
  return `oauth-client-metadata:${clientId}`;
}

export async function saveOAuthClientMetadata({
  clientId,
  clientName,
  clientUri,
  redirectUris,
}: OAuthClientMetadata & { clientId: string }): Promise<void> {
  const safeClientName = clientName.trim().slice(0, 256);
  const safeClientUri = clientUri?.trim().slice(0, 2048);
  const safeRedirectUris = redirectUris.map((uri) => uri.trim().slice(0, 2048));
  await setOAuthClientMetadataValue({
    key: key(clientId),
    ttlSeconds: OAUTH_CLIENT_METADATA_TTL_SECONDS,
    value: JSON.stringify({
      clientName: safeClientName,
      ...(safeClientUri ? { clientUri: safeClientUri } : {}),
      redirectUris: safeRedirectUris,
    }),
  });
}

export async function getOAuthClientMetadata(
  clientId: string,
): Promise<OAuthClientMetadata | null> {
  const value = await getOAuthClientMetadataValue(key(clientId));
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<OAuthClientMetadata>;
    if (
      typeof parsed.clientName !== "string" ||
      !Array.isArray(parsed.redirectUris) ||
      !parsed.redirectUris.every((uri) => typeof uri === "string")
    ) {
      return null;
    }
    return {
      clientName: parsed.clientName,
      ...(typeof parsed.clientUri === "string"
        ? { clientUri: parsed.clientUri }
        : {}),
      redirectUris: parsed.redirectUris,
    };
  } catch {
    return null;
  }
}
