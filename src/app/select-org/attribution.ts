export const DISCOVERY_SOURCE_VALUES = [
  "ai_answer",
  "search_engine",
  "social_or_content",
  "friend_or_coworker",
  "existing_user",
  "other",
] as const;

export const CONNECTOR_TRIGGER_VALUES = [
  "claude_suggestion",
  "claude_connector_directory",
  "kernel_documentation",
  "manual_connector_url",
  "product_or_template",
  "other",
] as const;

export type DiscoverySource = (typeof DISCOVERY_SOURCE_VALUES)[number];
export type ConnectorTrigger = (typeof CONNECTOR_TRIGGER_VALUES)[number];

export interface OAuthAttributionInput {
  firstDiscoverySource?: unknown;
  connectorTrigger?: unknown;
  oauthClientId?: unknown;
  oauthRedirectUri?: unknown;
}

export interface OAuthAttributionMetadata {
  firstDiscoverySource: DiscoverySource;
  connectorTrigger: ConnectorTrigger;
  signupPath: "oauth_picker";
}

export function parseOAuthAttribution(
  input: OAuthAttributionInput,
): OAuthAttributionMetadata | null {
  if (
    !DISCOVERY_SOURCE_VALUES.includes(
      input.firstDiscoverySource as DiscoverySource,
    ) ||
    !CONNECTOR_TRIGGER_VALUES.includes(
      input.connectorTrigger as ConnectorTrigger,
    )
  ) {
    return null;
  }

  return {
    firstDiscoverySource: input.firstDiscoverySource as DiscoverySource,
    connectorTrigger: input.connectorTrigger as ConnectorTrigger,
    signupPath: "oauth_picker",
  };
}
