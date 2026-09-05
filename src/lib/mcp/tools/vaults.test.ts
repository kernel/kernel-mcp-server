import { describe, expect, test } from "bun:test";
import {
  organizationWideAuthInfo,
  projectScopedAuthInfo,
} from "@/lib/mcp/auth-context.test-fixtures";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  agentcardSpec,
  connectVaultTest,
  item,
  linkSpec,
  vault,
} from "./vaults.test-fixtures";

describe("vault SDK request contracts", () => {
  test("advertises all four project-aware tools with conservative annotations", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "manage_vault_cards",
        "manage_vault_items",
        "manage_vault_wallets",
        "manage_vaults",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.properties).toHaveProperty("project");
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: true,
        });
      }
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("creates/gets/lists vaults with pagination and a public projection", async () => {
    const fixture = await connectVaultTest([
      Response.json({ ...vault, secret: "hidden" }),
      Response.json(vault),
      Response.json([vault], {
        headers: { "x-has-more": "true", "x-next-offset": "40" },
      }),
      Response.json([], {
        headers: { "x-has-more": "false", "x-next-offset": "0" },
      }),
    ]);
    try {
      expect(
        toolResultJSON(
          await fixture.call("manage_vaults", {
            action: "create",
            name: "checkout",
          }),
        ),
      ).toEqual(vault);
      expect(
        toolResultJSON(
          await fixture.call("manage_vaults", {
            action: "get",
            vault: "vlt_123",
          }),
        ),
      ).toEqual(vault);
      expect(
        toolResultJSON(
          await fixture.call("manage_vaults", {
            action: "list",
            limit: 20,
            offset: 20,
          }),
        ),
      ).toEqual({ items: [vault], has_more: true, next_offset: 40 });
      expect(
        toolResultJSON(
          await fixture.call("manage_vaults", { action: "list", offset: 40 }),
        ),
      ).toMatchObject({ items: [], has_more: false, next_offset: 0 });
      expect(
        fixture.requests.map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
      ).toEqual([
        { method: "POST", path: "/vaults", body: { name: "checkout" } },
        { method: "GET", path: "/vaults/vlt_123", body: undefined },
        { method: "GET", path: "/vaults?limit=20&offset=20", body: undefined },
        { method: "GET", path: "/vaults?offset=40", body: undefined },
      ]);
      for (const request of fixture.requests) {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("x-kernel-project")).toBe("proj_test");
      }
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      provider: "link",
      spec: {
        authorization: { method: "oauth", client: { type: "kernel_managed" } },
      },
    },
    { provider: "agentcard", spec: {} },
    { provider: "agentcard", spec: { user_id: "usr_enrolled" } },
  ])(
    "creates a $provider wallet without opening or completing its action",
    async ({ provider, spec }) => {
      const response = {
        ...item,
        type: "wallet",
        action: {
          name: "card_enrollment",
          url: "https://provider.example/enroll",
        },
      };
      const fixture = await connectVaultTest([Response.json(response)]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          action: "create",
          vault: "checkout",
          key: "wallet-1",
          provider,
          spec,
        });
        expect(result.isError).toBeUndefined();
        expect(toolResultJSON(result).item.action).toEqual(response.action);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({
          method: "PUT",
          path: "/vaults/checkout/items/wallet-1",
          body: { type: "wallet", spec: { ...spec, provider } },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["link", "agentcard"])(
    "creates and fully replaces a %s card without authorizing it",
    async (provider) => {
      const original =
        provider === "link"
          ? {
              ...linkSpec,
              provider,
              metadata: { order: "001" },
              expires_at: Number.MAX_SAFE_INTEGER,
              line_items: [
                {
                  name: "Supplies",
                  quantity: 1,
                  unit_amount: 1234,
                  description: "",
                  sku: "001",
                  url: "https://shop.example/item",
                  image_url: "https://shop.example/image",
                  product_url: "https://shop.example/product",
                  totals: [
                    {
                      type: "discount",
                      display_text: "Discount",
                      amount: -100,
                    },
                  ],
                },
              ],
              totals: [
                { type: "total", display_text: "Order total", amount: 1234 },
              ],
            }
          : {
              ...agentcardSpec,
              provider,
              card_id: "vc_chosen",
              amount: Number.MAX_SAFE_INTEGER,
            };
      const replacement = provider === "link" ? linkSpec : agentcardSpec;
      const fixture = await connectVaultTest([
        Response.json(item),
        Response.json(item),
      ]);
      try {
        for (const [action, spec] of [
          ["create", original],
          ["update", replacement],
        ]) {
          const result = await fixture.call("manage_vault_cards", {
            action,
            vault: "checkout",
            key: "order-1",
            provider,
            spec,
          });
          expect(result.isError).toBeUndefined();
        }
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests[0]).toMatchObject({
          method: "PUT",
          body: { type: "card", spec: original },
        });
        expect(fixture.requests[1]).toMatchObject({
          method: "PATCH",
          body: { spec: { ...replacement, provider } },
        });
        expect(fixture.requests[1].body).not.toHaveProperty("type");
      } finally {
        await fixture.close();
      }
    },
  );

  test("lists items and expands live payment methods through either tool", async () => {
    const expanded = {
      ...item,
      expanded: {
        payment_methods: [
          {
            id: "pm_choice",
            provider: "link",
            type: "card",
            is_default: true,
            display: { brand: "visa", last4: "4242" },
            capabilities: {
              single_use_card: { eligible: false, reasons: ["unsupported"] },
            },
          },
        ],
      },
    };
    const fixture = await connectVaultTest([
      Response.json([]),
      Response.json(expanded),
      Response.json(expanded),
    ]);
    try {
      expect(
        toolResultJSON(
          await fixture.call("manage_vault_items", {
            action: "list",
            vault: "checkout",
          }),
        ),
      ).toEqual({ items: [] });
      const wallet = await fixture.call("manage_vault_wallets", {
        action: "payment_methods",
        vault: "checkout",
        key: "wallet-1",
      });
      const get = await fixture.call("manage_vault_items", {
        action: "get",
        vault: "checkout",
        key: "wallet-1",
        expand: ["payment_methods"],
        wait: 0,
      });
      expect(toolResultJSON(wallet).item).toEqual(expanded);
      expect(toolResultJSON(get).item).toEqual(expanded);
      for (const request of fixture.requests.slice(1)) {
        const url = new URL(request.path, "https://api.example");
        expect(url.pathname).toBe("/vaults/checkout/items/wallet-1");
        expect(url.searchParams.getAll("expand")).toEqual(["payment_methods"]);
        expect(request.method).toBe("GET");
      }
    } finally {
      await fixture.close();
    }
  });
});

describe("vault scopes and input validation", () => {
  test.each([
    { auth: organizationWideAuthInfo(), project: undefined, expected: null },
    {
      auth: organizationWideAuthInfo(),
      project: "checkout-project",
      expected: "checkout-project",
    },
    {
      auth: projectScopedAuthInfo(),
      project: "proj_test",
      expected: "proj_test",
    },
  ])(
    "resolves the effective project without listing projects",
    async ({ auth, project, expected }) => {
      const fixture = await connectVaultTest([Response.json([])], auth);
      try {
        expect(
          (
            await fixture.call("manage_vaults", {
              action: "list",
              ...(project && { project }),
            })
          ).isError,
        ).toBeUndefined();
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0].headers.get("x-kernel-project")).toBe(
          expected,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    ["manage_vaults", { action: "get", vault: "checkout" }],
    [
      "manage_vault_wallets",
      { action: "payment_methods", vault: "checkout", key: "wallet-1" },
    ],
    [
      "manage_vault_cards",
      {
        action: "create",
        vault: "checkout",
        key: "order-1",
        provider: "agentcard",
        spec: agentcardSpec,
      },
    ],
    [
      "manage_vault_items",
      {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "authorize",
      },
    ],
  ] as const)(
    "%s rejects cross-project calls and unauthenticated calls",
    async (name, args) => {
      for (const auth of [projectScopedAuthInfo(), null]) {
        const fixture = await connectVaultTest([], auth);
        try {
          expect(
            (await fixture.call(name, { ...args, project: "another-project" }))
              .isError,
          ).toBe(true);
          expect(fixture.requests).toHaveLength(0);
        } finally {
          await fixture.close();
        }
      }
    },
  );

  test.each([
    ["manage_vaults", { action: "create" }],
    ["manage_vaults", { action: "get" }],
    ["manage_vaults", { action: "delete" }],
    ["manage_vaults", { action: "create", name: ".." }],
    ["manage_vaults", { action: "get", vault: "../other" }],
    ["manage_vaults", { action: "list", limit: 101 }],
    ["manage_vaults", { action: "list", offset: -1 }],
    [
      "manage_vault_wallets",
      {
        action: "create",
        vault: "checkout",
        key: "wallet-1",
        provider: "link",
      },
    ],
    [
      "manage_vault_wallets",
      {
        action: "create",
        vault: "checkout",
        key: "wallet-1",
        provider: "link",
        spec: {},
      },
    ],
    [
      "manage_vault_wallets",
      {
        action: "create",
        vault: "checkout",
        key: "wallet-1",
        provider: "link",
        spec: { provider: "agentcard" },
      },
    ],
    [
      "manage_vault_wallets",
      {
        action: "create",
        vault: "checkout",
        key: "wallet-1",
        provider: "agentcard",
        spec: { access_token: "hidden" },
      },
    ],
    ["manage_vault_items", { action: "get", vault: "checkout" }],
    [
      "manage_vault_items",
      { action: "invoke", vault: "checkout", key: "order-1" },
    ],
    [
      "manage_vault_items",
      { action: "get", vault: "checkout", key: "order-1", expand: ["secrets"] },
    ],
    [
      "manage_vault_items",
      { action: "get", vault: "checkout", key: "order-1", wait: 61 },
    ],
    [
      "manage_vault_items",
      { action: "events", vault: "checkout", key: "order-1", wait: -1 },
    ],
  ] as const)(
    "rejects invalid %s inputs without a request",
    async (name, args) => {
      const fixture = await connectVaultTest([]);
      try {
        expect((await fixture.call(name, args)).isError).toBe(true);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { ...linkSpec, provider: "agentcard" },
    { ...linkSpec, amount: 1.1 },
    { ...linkSpec, amount: 500001 },
    { ...linkSpec, expires_at: Number.MAX_SAFE_INTEGER + 1 },
    {
      ...linkSpec,
      line_items: [
        { name: "Supplies", unit_amount: Number.MAX_SAFE_INTEGER + 1 },
      ],
    },
    { ...linkSpec, number: "hidden", cvc: "hidden" },
    { ...linkSpec, domains: ["shop.example"] },
    { ...linkSpec, authorization: { access_token: "hidden" } },
    { type: "card", spec: linkSpec },
    JSON.stringify(linkSpec),
    null,
  ])("rejects invalid or secret-bearing card specs", async (spec) => {
    const fixture = await connectVaultTest([]);
    try {
      expect(
        (
          await fixture.call("manage_vault_cards", {
            action: "create",
            vault: "checkout",
            key: "order-1",
            provider: "link",
            spec,
          })
        ).isError,
      ).toBe(true);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});
