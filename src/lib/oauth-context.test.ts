import { describe, expect, test } from "bun:test";
import {
  authorizationContextFromSelection,
  deriveS256CodeChallenge,
  organizationAuthorizationContext,
  parseAuthorizationContext,
  projectAuthorizationContext,
  serializeAuthorizationContext,
} from "./oauth-context";

describe("OAuth authorization context", () => {
  test("decodes legacy org mappings as organization-wide", () => {
    expect(parseAuthorizationContext("org_legacy")).toEqual(
      organizationAuthorizationContext({ clerkOrgId: "org_legacy" }),
    );
  });

  test("round-trips organization and project contexts", () => {
    const contexts = [
      organizationAuthorizationContext({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
      }),
      projectAuthorizationContext({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        projectId: "proj_1",
      }),
    ];

    for (const context of contexts) {
      expect(
        parseAuthorizationContext(serializeAuthorizationContext(context)),
      ).toEqual(context);
    }
  });

  test("rejects malformed authorization boundaries", () => {
    for (const value of [
      "",
      "{",
      "not-an-org",
      "null",
      "[]",
      '{"version":2,"clerk_org_id":"org_1","access_scope":"organization"}',
      '{"version":1,"access_scope":"organization"}',
      '{"version":1,"clerk_org_id":"org_1","access_scope":"project"}',
      '{"version":1,"clerk_org_id":"org_1","access_scope":"organization","project_id":"proj_1"}',
      '{"version":1,"clerk_org_id":"org_1","access_scope":"account"}',
    ]) {
      expect(() => parseAuthorizationContext(value)).toThrow();
    }
  });

  test("validates authorization selections", () => {
    expect(
      authorizationContextFromSelection({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        accessScope: null,
        projectId: null,
      }),
    ).toEqual(
      organizationAuthorizationContext({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
      }),
    );

    expect(
      authorizationContextFromSelection({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        accessScope: "project",
        projectId: "proj_1",
      }),
    ).toEqual(
      projectAuthorizationContext({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        projectId: "proj_1",
      }),
    );

    expect(() =>
      authorizationContextFromSelection({
        clerkUserId: "user_1",
        clerkOrgId: "org_1",
        accessScope: "project",
        projectId: null,
      }),
    ).toThrow("Project access requires a project");
  });
});

test("derives RFC 7636 S256 challenge", () => {
  expect(
    deriveS256CodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
