/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

process.env.CLERK_SECRET_KEY ??= "test-clerk-secret";

import { resolveMcpOrgIdentity } from "@/lib/mcp/org-context";

function extraWithOrg(orgId: string) {
  return {
    authInfo: {
      token: "tok",
      extra: {
        connectionContext: { scope: { organizationId: orgId } },
      },
    },
  };
}

describe("resolveMcpOrgIdentity", () => {
  test("attributes events to the org from the route-resolved connection context", async () => {
    const identity = await resolveMcpOrgIdentity(extraWithOrg("org_123"));

    expect(identity?.groups).toEqual({ organization: "org_123" });
  });

  test("uses an org-pseudonymous distinct id, never the real org id", async () => {
    const identity = await resolveMcpOrgIdentity(extraWithOrg("org_123"));

    expect(identity?.distinctId).toStartWith("mcporg_");
    expect(identity?.distinctId).not.toContain("org_123");
  });

  test("derives a stable distinct id per organization", async () => {
    const a1 = await resolveMcpOrgIdentity(extraWithOrg("org_a"));
    const a2 = await resolveMcpOrgIdentity(extraWithOrg("org_a"));
    const b = await resolveMcpOrgIdentity(extraWithOrg("org_b"));

    expect(a1?.distinctId).toBe(a2?.distinctId);
    expect(b?.distinctId).not.toBe(a1?.distinctId);
  });

  test("returns null without a connection context", async () => {
    expect(await resolveMcpOrgIdentity(undefined)).toBeNull();
    expect(await resolveMcpOrgIdentity({})).toBeNull();
    expect(
      await resolveMcpOrgIdentity({ authInfo: { token: "tok", extra: {} } }),
    ).toBeNull();
    expect(
      await resolveMcpOrgIdentity({
        authInfo: { token: "tok", extra: { connectionContext: null } },
      }),
    ).toBeNull();
  });
});
