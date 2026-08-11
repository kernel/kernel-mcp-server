import { createHmac } from "crypto";
import type { UserIdentity } from "@posthog/mcp";
import type { McpConnectionContext } from "@/lib/mcp/auth-context";

// distinct_id must not identify a person: person processing stays off
// ($process_person_profile is pinned false in the sanitizer), and the only person id
// this server holds at request time — the Clerk subject — isn't the Kernel user id
// other producers identify on. But the SDK needs a distinct id to carry the org group,
// so derive an org-pseudonymous one: a keyed hash of the org id, stable for the
// organization and joinable to neither the Clerk subject nor the Kernel user id nor
// the org id itself. The mcporg_ prefix keeps it from being mistaken for a real
// (org_…) id in PostHog.
function orgPseudonymousDistinctId(orgId: string): string {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable must be set");
  }
  return `mcporg_${createHmac("sha256", secretKey).update(orgId).digest("hex").slice(0, 32)}`;
}

/**
 * Resolves the calling organization's identity for PostHog MCP analytics: every event
 * for the session is stamped with `$groups = { organization: org_id }` — the same
 * convention as the Kernel API's own `api_call` events — under an org-pseudonymous
 * distinct id.
 *
 * The route resolves the connection context at auth time (handleMcpRequestWithIdentity)
 * and attaches it to authInfo.extra on every request, so this reads it straight out of
 * the request extras and adds no I/O. Returns null when no connection context is
 * attached, which leaves the event anonymous (SDK session id, no groups) rather than
 * blocking the tool call.
 */
export async function resolveMcpOrgIdentity(
  extra: unknown,
): Promise<UserIdentity | null> {
  const authInfo = (
    extra as
      | { authInfo?: { extra?: { connectionContext?: unknown } } }
      | undefined
  )?.authInfo;
  const context = authInfo?.extra?.connectionContext as
    | McpConnectionContext
    | null
    | undefined;
  const orgId = context?.scope?.organizationId;
  if (!orgId) return null;

  return {
    distinctId: orgPseudonymousDistinctId(orgId),
    groups: { organization: orgId },
  };
}
