import { afterEach, describe, expect, test } from "bun:test";
import type { KernelClient } from "@/lib/mcp/kernel-client";
import {
  clearProjectSelectionScopeCacheForTests,
  connectionAllowsProjectSelection,
  expireProjectSelectionScopeCacheForTests,
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

function authContext(projectID: string | null) {
  return {
    authentication: {
      method: "api_key" as const,
      source: "api_key" as const,
      credential_id: "key_123",
    },
    principal: { type: "api_key" as const, id: "key_123" },
    organization: { id: "org_123" },
    authorization: {
      credential_scope: { project_id: projectID },
      effective_scope: { project_id: projectID },
    },
  };
}

function dependencies(projectID: string | null) {
  return {
    createKernelClient: () =>
      ({
        auth: {
          context: {
            retrieve: async () => authContext(projectID),
          },
        },
      }) as unknown as KernelClient,
  };
}

describe("connectionAllowsProjectSelection", () => {
  test("allows organization-wide credentials", async () => {
    delete process.env.KERNEL_PROJECT;
    expect(
      await connectionAllowsProjectSelection(
        "org-wide-token",
        dependencies(null),
      ),
    ).toBe(true);
  });

  test("does not allow project-scoped credentials", async () => {
    delete process.env.KERNEL_PROJECT;
    expect(
      await connectionAllowsProjectSelection(
        "project-token",
        dependencies("proj_123"),
      ),
    ).toBe(false);
  });

  test("resolves scope from the authenticated API context", async () => {
    delete process.env.KERNEL_PROJECT;
    const token = "sk_identifier.secret";
    let receivedToken: string | undefined;
    let contextCalls = 0;
    await connectionAllowsProjectSelection(token, {
      createKernelClient: (candidate) => {
        receivedToken = candidate;
        return {
          auth: {
            context: {
              retrieve: async () => {
                contextCalls += 1;
                return authContext(null);
              },
            },
          },
        } as unknown as KernelClient;
      },
    });
    expect(receivedToken).toBe(token);
    expect(contextCalls).toBe(1);
  });

  test("reuses an auth context resolved for connection analytics", async () => {
    delete process.env.KERNEL_PROJECT;
    const context = await dependencies(null)
      .createKernelClient()
      .auth.context.retrieve();
    expect(
      await connectionAllowsProjectSelection(
        "org-wide-token",
        {
          createKernelClient: () => {
            throw new Error("unexpected duplicate context lookup");
          },
        },
        undefined,
        Promise.resolve(context),
      ),
    ).toBe(true);
  });

  test("keeps a previously resolved scope during a transient refresh failure", async () => {
    delete process.env.KERNEL_PROJECT;
    const token = "org-wide-stale";
    expect(
      await connectionAllowsProjectSelection(token, dependencies(null)),
    ).toBe(true);

    expireProjectSelectionScopeCacheForTests();
    expect(
      await connectionAllowsProjectSelection(token, {
        createKernelClient: () => {
          throw new Error("temporary outage");
        },
      }),
    ).toBe(true);
  });

  test("keeps project selection stable across token refreshes in one session", async () => {
    delete process.env.KERNEL_PROJECT;
    const cacheIdentity = "user:scope\0session_123";
    let lookups = 0;
    const firstDependencies = {
      createKernelClient: () =>
        ({
          auth: {
            context: {
              retrieve: async () => {
                lookups += 1;
                return authContext(null);
              },
            },
          },
        }) as unknown as KernelClient,
    };
    expect(
      await connectionAllowsProjectSelection(
        "old-token",
        firstDependencies,
        cacheIdentity,
      ),
    ).toBe(true);

    expect(
      await connectionAllowsProjectSelection(
        "new-token",
        {
          createKernelClient: () => {
            lookups += 1;
            throw new Error("unexpected scope refresh");
          },
        },
        cacheIdentity,
      ),
    ).toBe(true);
    expect(lookups).toBe(1);
  });

  test("does not expose project selection when the server is pinned", async () => {
    process.env.KERNEL_PROJECT = "proj_server";
    expect(
      await connectionAllowsProjectSelection(
        "org-wide-token",
        dependencies(null),
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
