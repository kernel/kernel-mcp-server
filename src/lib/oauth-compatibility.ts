type CompatibilityEvent = {
  surface: "verification" | "token" | "authorize" | "register";
  provider: "clerk" | "kernel";
  outcome: "verified" | "rejected" | "success" | "error" | "unavailable";
};

// Categorical events deliberately exclude identities, tokens, URLs and request bodies.
export function recordOAuthCompatibility(event: CompatibilityEvent): void {
  console.info(
    JSON.stringify({
      event: "oauth_compatibility",
      version: 1,
      issuer_alias: event.provider === "kernel" ? "canonical" : "legacy_mcp",
      cohort: event.provider === "kernel" ? "test" : "unknown",
      ...event,
    }),
  );
}
