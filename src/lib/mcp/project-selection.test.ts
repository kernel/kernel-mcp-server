import { afterEach, describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  clearProjectSelectionScopeCacheForTests,
  connectionAllowsProjectSelection,
  projectIDFromParams,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

const originalKernelProject = process.env.KERNEL_PROJECT;

afterEach(() => {
  clearProjectSelectionScopeCacheForTests();
  if (originalKernelProject === undefined) {
    delete process.env.KERNEL_PROJECT;
  } else {
    process.env.KERNEL_PROJECT = originalKernelProject;
  }
});

function dependencies({
  jwtContext = null,
  projectID = null,
}: {
  jwtContext?: string | null;
  projectID?: string | null;
}) {
  return {
    getJwtContext: async () => jwtContext,
    createClient: () =>
      ({
        apiKeys: {
          list: async () => ({
            getPaginatedItems: () => [{ project_id: projectID }],
          }),
        },
      }) as unknown as KernelClient,
  };
}

describe("connectionAllowsProjectSelection", () => {
  test("allows legacy organization-wide OAuth connections", async () => {
    delete process.env.KERNEL_PROJECT;
    expect(
      await connectionAllowsProjectSelection(
        "jwt.org-wide.1",
        true,
        dependencies({ jwtContext: "org_123" }),
      ),
    ).toBe(true);
  });

  test("allows structured organization-wide OAuth connections", async () => {
    delete process.env.KERNEL_PROJECT;
    expect(
      await connectionAllowsProjectSelection(
        "jwt.org-wide.2",
        true,
        dependencies({
          jwtContext: JSON.stringify({ access_scope: "organization" }),
        }),
      ),
    ).toBe(true);
  });

  test("does not allow project-scoped OAuth connections", async () => {
    delete process.env.KERNEL_PROJECT;
    expect(
      await connectionAllowsProjectSelection(
        "jwt.project.1",
        true,
        dependencies({
          jwtContext: JSON.stringify({
            access_scope: "project",
            project_id: "proj_123",
          }),
        }),
      ),
    ).toBe(false);
  });

  test("uses the authenticated API key metadata to distinguish scope", async () => {
    delete process.env.KERNEL_PROJECT;
    expect(
      await connectionAllowsProjectSelection(
        "sk_11111111-1111-1111-1111-111111111111.secret",
        false,
        dependencies({ projectID: null }),
      ),
    ).toBe(true);
    expect(
      await connectionAllowsProjectSelection(
        "sk_22222222-2222-2222-2222-222222222222.secret",
        false,
        dependencies({ projectID: "proj_123" }),
      ),
    ).toBe(false);
  });

  test("looks up API key scope without sending the key secret as a query", async () => {
    delete process.env.KERNEL_PROJECT;
    let query: string | undefined;
    const token = "sk_33333333-3333-3333-3333-333333333333.secret";
    await connectionAllowsProjectSelection(token, false, {
      getJwtContext: async () => null,
      createClient: () =>
        ({
          apiKeys: {
            list: async (params: { query?: string }) => {
              query = params.query;
              return {
                getPaginatedItems: () => [{ project_id: null }],
              };
            },
          },
        }) as unknown as KernelClient,
    });
    expect(query).toBe("sk_33333333-3333-3333-3333-333333333333");
    expect(query).not.toContain("secret");
  });

  test("does not expose project selection when the server is pinned", async () => {
    process.env.KERNEL_PROJECT = "proj_server";
    expect(
      await connectionAllowsProjectSelection(
        "jwt.org-wide.3",
        true,
        dependencies({ jwtContext: "org_123" }),
      ),
    ).toBe(false);
  });
});

describe("project selection helpers", () => {
  test("omits the schema unless selection is enabled", () => {
    expect(projectSelectionInputSchema(false)).not.toHaveProperty("project_id");
    expect(projectSelectionInputSchema(true)).toHaveProperty("project_id");
  });

  test("reads only non-empty project IDs", () => {
    expect(projectIDFromParams({ project_id: "proj_123" })).toBe("proj_123");
    expect(projectIDFromParams({ project_id: "" })).toBeUndefined();
    expect(projectIDFromParams(null)).toBeUndefined();
  });
});
