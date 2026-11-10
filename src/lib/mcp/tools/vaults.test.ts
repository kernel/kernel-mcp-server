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
  test("advertises vault tools with scope-appropriate inputs and conservative annotations", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "manage_vault_cards",
        "manage_vault_credentials",
        "manage_vault_items",
        "manage_vault_provider_configs",
        "manage_vault_wallets",
        "manage_vaults",
      ]);
      for (const tool of tools) {
        if (tool.name === "manage_vault_provider_configs") {
          expect(tool.inputSchema.properties).not.toHaveProperty("project");
        } else {
          expect(tool.inputSchema.properties).toHaveProperty("project");
        }
        expect(JSON.stringify(tool.inputSchema)).not.toContain('"$ref"');
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: true,
        });
      }
      const cards = tools.find((tool) => tool.name === "manage_vault_cards");
      expect(cards?.description).toContain(
        "mode is determined by the wallet credentials",
      );
      expect(cards?.description).toContain(
        "pending issuance updates preserve omitted optional fields",
      );
      expect(cards?.description).toContain("recovery_required");
      expect(JSON.stringify(cards?.inputSchema)).toContain("checkout_origin");
      expect(cards?.description).toContain(
        "KERNEL does not compare it with the browser page",
      );
      expect(cards?.description).toContain(
        "prepared checkout uses preparation.merchant_origin",
      );
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("forwards AgentCard checkout_origin in the card specification", async () => {
    const spec = {
      ...agentcardSpec,
      checkout_origin: "https://shop.example",
    };
    const fixture = await connectVaultTest([Response.json(item)]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        action: "create",
        vault: "checkout",
        key: "order-1",
        provider: "agentcard",
        spec,
      });

      expect(result.isError).toBeUndefined();
      expect(fixture.requests[0].body).toMatchObject({
        type: "card",
        spec: { ...spec, provider: "agentcard" },
      });
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

  test("requests and projects Link user and shipping expansions with false, zero, and null", async () => {
    const expanded = {
      ...item,
      type: "wallet",
      spec: { provider: "link" },
      state: { provider: "link", status: "connected" },
      available_operations: [],
      available_expansions: [
        { type: "link_user_info", description: "Read user info" },
        {
          type: "link_shipping_addresses",
          description: "Read shipping addresses",
        },
      ],
      expanded: {
        link_user_info: {
          id: "usr_link",
          email: "jane@example.com",
          first_name: "Jane",
          last_name: "Doe",
          name: "Jane Doe",
          phone: null,
          eligible_for_balance: false,
          default_spend_request_currency: "usd",
          agent_wallet_spend_limits: {
            per_transaction: { limit: 0 },
            daily: { limit: null, used: 0, remaining: null },
            thirty_day: { limit: 50000, used: 0, remaining: 50000 },
          },
          agent_wallet_step_up: {
            status: "not_required",
            action_url: null,
          },
          hidden: "provider-secret",
        },
        link_shipping_addresses: [
          {
            id: "sa_1",
            is_default: false,
            nickname: null,
            address: {
              name: "Jane Doe",
              line_1: "510 Townsend St",
              line_2: null,
              locality: "San Francisco",
              dependent_locality: null,
              administrative_area: "CA",
              postal_code: "94103",
              sorting_code: null,
              country_code: "US",
            },
            hidden: "provider-secret",
          },
        ],
      },
    };
    const fixture = await connectVaultTest([Response.json(expanded)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "wallet-1",
          expand: ["link_user_info", "link_shipping_addresses"],
        }),
      );
      expect(result.item.expanded.link_user_info).toMatchObject({
        eligible_for_balance: false,
        phone: null,
        agent_wallet_spend_limits: {
          per_transaction: { limit: 0 },
          daily: { limit: null, used: 0, remaining: null },
        },
        agent_wallet_step_up: {
          status: "not_required",
          action_url: null,
        },
      });
      expect(result.item.expanded.link_shipping_addresses[0]).toMatchObject({
        is_default: false,
        nickname: null,
      });
      expect(JSON.stringify(result)).not.toContain("provider-secret");
      const url = new URL(fixture.requests[0].path, "https://api.example");
      expect(url.searchParams.getAll("expand")).toEqual([
        "link_user_info,link_shipping_addresses",
      ]);
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
    { ...linkSpec, amount: 50001 },
    { ...linkSpec, expires_at: 4102444800 },
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

describe("Link checkout through manage_vault_cards", () => {
  const target = { vault: "checkout", key: "order-1" };
  const checkout = {
    browser_id: "browser-session-id",
    page_url: "https://shop.example/checkout",
  };
  const pending = {
    ...item,
    state: { provider: "link", status: "pending_authorization" },
    action: { name: "spend_approval", url: "https://link.example/approve" },
    available_operations: [
      { type: "authorize", description: "Approval has been requested." },
    ],
  };

  test("tool descriptions name the checkout flow in order without internal terms", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const description = (name: string) =>
        tools.find((tool) => tool.name === name)?.description ?? "";
      const cards = description("manage_vault_cards");
      const order = [
        "reach the final checkout page",
        '"create" the card',
        '"authorize" with browser_id (browser session id) and page_url',
        "share the approval url",
        "until fill is advertised",
        "submit the checkout yourself",
      ].map((text) => cards.indexOf(text));
      expect(order).not.toContain(-1);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(cards).toContain(
        '"update" can change a link card until it is authorized at a checkout; after that it returns 409: delete the card and create a new one.',
      );
      expect(cards).toContain("available_operations descriptions");
      expect(description("manage_vault_wallets")).toContain(
        "a connected link wallet returns item.description with the checkout flow",
      );
      expect(description("manage_vaults")).toContain(
        "create the card, authorize it with browser_id and page_url, share the approval url, wait until fill is advertised, fill, then submit the checkout yourself",
      );
      const schema = tools.find(
        (tool) => tool.name === "manage_vault_cards",
      )?.inputSchema;
      expect(schema?.properties).toHaveProperty("browser_id");
      expect(schema?.properties).toHaveProperty("page_url");
      for (const tool of tools) {
        const text = JSON.stringify(tool);
        for (const term of [
          "execution method",
          "execution mode",
          "credential type",
          "merchant_account_id",
        ])
          expect(text).not.toContain(term);
      }
    } finally {
      await fixture.close();
    }
  });

  test("forwards recurring Link terms and the 50000 amount boundary", async () => {
    const recurringSpec = {
      ...linkSpec,
      amount: 50000,
      recurring: { interval: "week", interval_count: 2 },
    };
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        spec: { ...recurringSpec, provider: "link" },
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        action: "create",
        provider: "link",
        spec: recurringSpec,
      });
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).item.spec.recurring).toEqual(
        recurringSpec.recurring,
      );
      expect(fixture.requests[0].body).toEqual({
        type: "card",
        spec: { ...recurringSpec, provider: "link" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("authorizes a requested Link card with checkout context", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(pending),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        action: "authorize",
        provider: "link",
        ...checkout,
      });
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).item.action).toEqual(pending.action);
      expect(
        fixture.requests.map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
      ).toEqual([
        {
          method: "GET",
          path: "/vaults/checkout/items/order-1",
          body: undefined,
        },
        {
          method: "POST",
          path: "/vaults/checkout/items/order-1/operations",
          body: { type: "authorize", ...checkout },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("re-checks a pending Link card without checkout context", async () => {
    const fixture = await connectVaultTest([
      Response.json(pending),
      Response.json(pending),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        action: "authorize",
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({ type: "authorize" });
    } finally {
      await fixture.close();
    }
  });

  test.each<{ args: Record<string, unknown> }>([
    { args: { action: "authorize", browser_id: checkout.browser_id } },
    { args: { action: "authorize", page_url: checkout.page_url } },
    {
      args: {
        action: "authorize",
        ...checkout,
        page_url: "http://shop.example/checkout",
      },
    },
    { args: { action: "authorize", provider: "agentcard" } },
    {
      args: {
        action: "create",
        provider: "link",
        spec: linkSpec,
        ...checkout,
      },
    },
  ])("rejects $args before any request", async ({ args }) => {
    const fixture = await connectVaultTest([]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        ...args,
      });
      expect(result.isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("does not send checkout context for a KERNEL card", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...item,
        spec: { provider: "kernel", wallet: "wallet-1" },
        state: { provider: "kernel", status: "requested" },
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        action: "authorize",
        ...checkout,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "kernel cards do not accept browser_id or page_url",
      );
      expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
    } finally {
      await fixture.close();
    }
  });

  test("passes through a checkout inspection error with its recovery step", async () => {
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(
        {
          code: "ambiguous_page",
          message:
            "more than one tab is at page_url; close the extra tabs and authorize again",
        },
        { status: 400 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        action: "authorize",
        ...checkout,
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toBe(
        "error in manage_vault_cards (authorize): 400 more than one tab is at page_url; close the extra tabs and authorize again [code: ambiguous_page] no payment request was made. make sure the checkout is open in exactly one tab at page_url, then authorize again. if checkout inspection keeps failing, authorize without browser_id and page_url to issue a virtual card for the merchant_url origin.",
      );
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      stage: "after the POST was sent",
      replies: () => [Response.json(item), new Error("socket hang up")],
      submitted: true,
      requests: 2,
    },
    {
      stage: "before the POST",
      replies: () => [new Error("socket hang up")],
      submitted: false,
      requests: 1,
    },
  ])(
    "reports a lost Link authorize response $stage",
    async ({ replies, submitted, requests }) => {
      const fixture = await connectVaultTest(replies());
      try {
        const result = await fixture.call("manage_vault_cards", {
          ...target,
          action: "authorize",
          provider: "link",
          ...checkout,
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(result.isError).toBe(true);
        const note =
          "no response was received from the api after the operation was submitted.";
        if (submitted) expect(text).toEndWith(note);
        else expect(text).not.toContain(note);
        expect(fixture.requests).toHaveLength(requests);
      } finally {
        await fixture.close();
      }
    },
  );

  test("passes through the 409 for updating a card authorized at a checkout", async () => {
    const message =
      "this card was authorized at a checkout and cannot be changed; delete this card and create a new one with the updated details";
    const fixture = await connectVaultTest([
      Response.json({ code: "conflict", message }, { status: 409 }),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        ...target,
        action: "update",
        provider: "link",
        spec: linkSpec,
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toBe(
        `error in manage_vault_cards (update): 409 ${message} [code: conflict]`,
      );
      expect(fixture.requests.map(({ method }) => method)).toEqual(["PATCH"]);
    } finally {
      await fixture.close();
    }
  });

  test("returns a connected Link wallet's description", async () => {
    const wallet = {
      ...item,
      key: "wallet-1",
      type: "wallet",
      description: "Use this wallet to pay at checkout.",
      spec: { provider: "link" },
      state: { provider: "link", status: "connected" },
      available_operations: [],
    };
    const fixture = await connectVaultTest([Response.json(wallet)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          vault: "checkout",
          key: "wallet-1",
          action: "get",
        }),
      );
      expect(result.item.description).toBe(wallet.description);
    } finally {
      await fixture.close();
    }
  });
});
