"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { expandLocalhostUris } from "@/lib/auth-utils";
import { getOAuthClientMetadata } from "@/lib/oauth-client-metadata";
import {
  parseOAuthAttribution,
  type OAuthAttributionInput,
} from "./attribution";

export async function saveOAuthAttribution(
  input: OAuthAttributionInput,
): Promise<{ success: boolean }> {
  const attribution = parseOAuthAttribution(input);
  if (!attribution) return { success: false };

  const { userId } = await auth();
  if (!userId) return { success: false };

  const oauthClientId = boundedString(input.oauthClientId, 256);
  let clientMetadata = null;
  if (oauthClientId) {
    try {
      clientMetadata = await getOAuthClientMetadata(oauthClientId);
    } catch (error) {
      console.error("Failed to load OAuth client metadata:", error);
    }
  }

  // For dynamically registered clients, only trust the query-string redirect
  // URI when it matches one registered for that client.
  const redirectUri = boundedString(input.oauthRedirectUri, 2048);
  const redirectUriMatchesClient =
    !clientMetadata ||
    expandLocalhostUris(clientMetadata.redirectUris).includes(redirectUri);
  const oauthRedirectOrigin = redirectUriMatchesClient
    ? urlOrigin(redirectUri)
    : undefined;

  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(userId, {
    publicMetadata: {
      ...attribution,
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(clientMetadata?.clientName
        ? { oauthClientName: boundedString(clientMetadata.clientName, 256) }
        : {}),
      ...(clientMetadata?.clientUri
        ? { oauthClientUri: urlOrigin(clientMetadata.clientUri) }
        : {}),
      ...(oauthRedirectOrigin ? { oauthRedirectOrigin } : {}),
      oauthClientType: clientMetadata
        ? "dynamically_registered"
        : "pre_registered_or_unknown",
    },
  });

  return { success: true };
}

function urlOrigin(value: unknown): string | undefined {
  const bounded = boundedString(value, 2048);
  if (!bounded) return undefined;
  try {
    const url = new URL(bounded);
    const origin =
      url.protocol === "http:" || url.protocol === "https:"
        ? url.origin
        : url.protocol;
    return boundedString(origin, 512) || undefined;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
