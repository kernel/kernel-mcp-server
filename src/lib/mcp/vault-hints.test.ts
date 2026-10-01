import { describe, expect, test } from "bun:test";
import {
  organizationWideAuthInfo,
  projectScopedAuthInfo,
} from "@/lib/mcp/auth-context.test-fixtures";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { vaultItemResponse } from "@/lib/mcp/vault-responses";
import {
  connectVaultTest,
  item,
  linkSpec,
} from "@/lib/mcp/tools/vaults.test-fixtures";

const target = { project: "proj_test", vault: "checkout", key: "order-1" };

describe("vault next-step hints", () => {
  test("separates observation, advertised invocation, and provider-hosted approval", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...item,
          action: {
            name: "spend_approval",
            url: "https://provider.example/approve",
            secret: "hidden",
          },
          available_operations: [
            {
              type: "future_operation",
              description: "Require approval.",
              payload: "hidden",
            },
          ],
        },
        target,
      ),
    );
    expect(result.hints).toEqual({
      observation: [
        {
          tool: "manage_vault_items",
          arguments: { ...target, action: "get", wait: 0 },
        },
        {
          tool: "manage_vault_items",
          arguments: { ...target, action: "events", wait: 0 },
        },
      ],
      invocation: [
        {
          tool: "manage_vault_items",
          arguments: {
            ...target,
            action: "invoke",
            operation: "future_operation",
          },
          requires_user_approval: true,
        },
      ],
    });
    expect(result.item.action).toEqual({
      name: "spend_approval",
      url: "https://provider.example/approve",
    });
    expect(JSON.stringify(result.hints)).not.toContain("provider.example");
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(result.guidance.join(" ")).toContain(
      "Invocation hints are not approval",
    );
  });

  test.each(
    [
      [],
      undefined,
      null,
      [{ type: "" }],
      [{ type: " " }],
      [{ type: { secret: "hidden" } }],
    ].map((operations) => ({ operations })),
  )(
    "never infers operations from ready state or a provider action",
    ({ operations }) => {
      const result = toolResultJSON(
        vaultItemResponse(
          {
            key: item.key,
            type: item.type,
            state: { provider: "agentcard", status: "ready" },
            action: {
              name: "authorize",
              url: "https://provider.example/approve",
            },
            ...(operations !== undefined && {
              available_operations: operations,
            }),
          },
          target,
        ),
      );
      expect(result.hints.invocation).toEqual([]);
      expect(result.hints.observation).toHaveLength(2);
    },
  );

  test.each([
    {
      name: "manage_vault_wallets",
      args: { action: "create", provider: "agentcard", spec: {} },
    },
    { name: "manage_vault_wallets", args: { action: "payment_methods" } },
    {
      name: "manage_vault_cards",
      args: { action: "create", provider: "link", spec: linkSpec },
    },
    {
      name: "manage_vault_cards",
      args: { action: "update", provider: "link", spec: linkSpec },
    },
    { name: "manage_vault_items", args: { action: "get" } },
    {
      name: "manage_vault_items",
      args: { action: "invoke", operation: "authorize" },
    },
  ])(
    "attaches hints to $name/$args.action responses",
    async ({ name, args }) => {
      const updated = { ...item, available_operations: [] };
      const fixture = await connectVaultTest(
        args.action === "invoke"
          ? [Response.json(item), Response.json(updated)]
          : [Response.json(item)],
      );
      try {
        const result = toolResultJSON(
          await fixture.call(name, {
            ...args,
            vault: target.vault,
            key: target.key,
          }),
        );
        expect(result.hints.observation[0].arguments).toEqual({
          ...target,
          action: "get",
          wait: 0,
        });
        expect(result.hints.invocation).toHaveLength(
          args.action === "invoke" ? 0 : 1,
        );
        expect(fixture.requests).toHaveLength(args.action === "invoke" ? 2 : 1);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    {
      auth: projectScopedAuthInfo("proj_fixed"),
      selection: {},
      project: "proj_fixed",
    },
    {
      auth: organizationWideAuthInfo(),
      selection: { project: "chosen-project" },
      project: "chosen-project",
    },
    {
      auth: organizationWideAuthInfo(),
      selection: { project_id: "proj_chosen" },
      project: "proj_chosen",
    },
    { auth: organizationWideAuthInfo(), selection: {}, project: undefined },
  ])(
    "preserves the resolved project without inventing a default",
    async ({ auth, selection, project }) => {
      const fixture = await connectVaultTest([Response.json(item)], auth);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            action: "get",
            vault: "selected-vault",
            key: "selected-key",
            ...selection,
          }),
        );
        for (const hint of [
          ...result.hints.observation,
          ...result.hints.invocation,
        ]) {
          expect(hint.arguments.vault).toBe("selected-vault");
          expect(hint.arguments.key).toBe("selected-key");
          expect(hint.arguments.project).toBe(project);
          expect(hint.arguments).not.toHaveProperty("project_id");
          if (project === undefined)
            expect(hint.arguments).not.toHaveProperty("project");
        }
        expect(fixture.requests[0].headers.get("X-Kernel-Project")).toBe(
          project ?? null,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    {
      events: [{ id: "evt_next", name: "state_changed" }],
      after: "evt_before",
      next: "evt_next",
    },
    { events: [], after: "evt_before", next: "evt_before" },
    { events: [], after: undefined, next: undefined },
  ])(
    "includes a resumable observation hint in event responses",
    async ({ events, after, next }) => {
      const fixture = await connectVaultTest([Response.json(events)]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            ...target,
            action: "events",
            ...(after !== undefined && { after }),
          }),
        );
        expect(result.next_after).toBe(next ?? null);
        expect(result.hints.observation[1]).toEqual({
          tool: "manage_vault_items",
          arguments: {
            ...target,
            action: "events",
            wait: 0,
            ...(next !== undefined && { after: next }),
          },
        });
        expect(result.hints.observation[0].arguments).not.toHaveProperty(
          "after",
        );
        expect(result.hints).not.toHaveProperty("invocation");
      } finally {
        await fixture.close();
      }
    },
  );

  test("observation hints can be submitted unchanged without a payment operation", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(item),
      Response.json([]),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", { ...target, action: "get" }),
      );
      for (const hint of result.hints.observation) {
        const observed = await fixture.call(hint.tool, hint.arguments);
        expect(observed.isError).not.toBe(true);
      }
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
        "GET",
        "GET",
      ]);
      expect(
        fixture.requests.every(
          (request) =>
            request.headers.get("X-Kernel-Project") === target.project,
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
