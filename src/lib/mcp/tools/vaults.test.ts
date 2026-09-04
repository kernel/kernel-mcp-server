/// <reference types="bun-types" />

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Kernel, { APIConnectionTimeoutError, APIError } from "@onkernel/sdk";
import type {
  CardVaultItemSpec,
  VaultItem,
  WalletVaultItemSpec,
} from "@onkernel/sdk/resources/vaults/items";
import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  cardSpecSchema,
  vaultItemInputSchema,
} from "@/lib/mcp/tools/vault-schemas";
import { registerVaultTools } from "@/lib/mcp/tools/vaults";

const dates = {
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};
const vault = { id: "vault_1", name: "checkout", ...dates };
const linkWallet = {
  provider: "link",
  authorization: { method: "oauth", client: { type: "kernel_managed" } },
} satisfies WalletVaultItemSpec;
const linkCard = {
  provider: "link",
  wallet: "wallet",
  payment_method_id: "pm_1",
  merchant_name: "Test shop",
  merchant_url: "https://shop.example.test",
  amount: 1250,
  currency: "usd",
  context:
    "The user requested this purchase from the specified merchant. The requested amount and items have been checked against the cart.",
  test: true,
} satisfies CardVaultItemSpec;
const agentCard = {
  provider: "agentcard",
  wallet: "wallet",
  merchant: "Test shop",
  amount: 1250,
  currency: "usd",
} satisfies CardVaultItemSpec;
const aliases = {
  number: "0000000000000000",
  cvc: "000",
  exp_month: "01",
  exp_year: "2030",
};

function walletItem(
  spec: WalletVaultItemSpec = linkWallet,
): VaultItem.WalletVaultItem {
  return {
    id: "item_wallet",
    key: "wallet",
    type: "wallet",
    spec,
    state: { provider: spec.provider, status: "connected" },
    available_operations: [],
    available_expansions: [
      {
        type: "payment_methods",
        description: "Read display-safe funding methods.",
      },
    ],
    ...dates,
  };
}
function cardItem(spec: CardVaultItemSpec = linkCard): VaultItem.CardVaultItem {
  return {
    id: "item_card",
    key: "card",
    type: "card",
    spec,
    state: { provider: spec.provider, status: "requested" },
    available_operations:
      spec.provider === "link"
        ? [
            {
              type: "authorize",
              description:
                "Authorize this card request with the connected wallet.",
            },
          ]
        : [],
    available_expansions: [],
    ...dates,
  };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (result.content as Array<{ text: string }>)[0].text;
}

describe("vault schemas", () => {
  test("accepts both provider variants without inventing implicit authorization", () => {
    for (const spec of [
      linkWallet,
      { provider: "agentcard" },
      { provider: "agentcard", user_id: "usr_existing" },
    ]) {
      expect(
        vaultItemInputSchema.safeParse({ type: "wallet", spec }).success,
      ).toBeTrue();
    }
    for (const spec of [
      linkCard,
      { ...linkCard, test: false },
      agentCard,
      { ...agentCard, card_id: "vc_selected" },
    ]) {
      expect(cardSpecSchema.safeParse(spec).success).toBeTrue();
    }
    expect(cardSpecSchema.parse(linkCard)).not.toHaveProperty("authorize");
    expect(cardSpecSchema.parse(agentCard)).not.toHaveProperty("test");
  });

  test.each([
    { ...linkCard, amount: 0 },
    { ...linkCard, amount: 1.5 },
    { ...linkCard, amount: 500001 },
    { ...linkCard, currency: "dollars" },
    { ...linkCard, payment_method_id: "" },
    { ...linkCard, context: "too short" },
    { ...linkCard, test: undefined },
    { ...linkCard, authorize: true },
    { ...linkCard, domains: ["shop.example.test"] },
    { ...linkCard, card_number: "sensitive-value" },
    { ...linkCard, line_items: [{ name: "test", quantity: 0 }] },
    { ...linkCard, totals: [{ type: "subtotal", amount: 1250 }] },
    { ...agentCard, test: true },
    { ...agentCard, amount: Number.MAX_SAFE_INTEGER + 1 },
    { ...agentCard, card_id: "raw-card-data" },
    { ...agentCard, provider: "unsupported" },
  ])("rejects unsupported or out-of-bounds card specs %#", (spec) => {
    expect(cardSpecSchema.safeParse(spec).success).toBeFalse();
  });

  test("rejects wallet/card mismatches, secret inputs, and extra item fields", () => {
    for (const item of [
      { type: "wallet", spec: linkCard },
      { type: "card", spec: linkWallet },
      {
        type: "wallet",
        spec: { ...linkWallet, oauth_code: "sensitive-value" },
      },
      {
        type: "wallet",
        spec: {
          provider: "link",
          authorization: {
            method: "oauth",
            client: {
              type: "kernel_managed",
              client_secret: "sensitive-value",
            },
          },
        },
      },
      { type: "wallet", spec: linkWallet, new_key: "renamed" },
    ])
      expect(vaultItemInputSchema.safeParse(item).success).toBeFalse();
  });
});

describe("manage_vaults", () => {
  test("advertises one project-aware tool with payment safety and conservative annotations", async () => {
    const { client, close } = await connectTestMcp(registerVaultTools, {});
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(["manage_vaults"]);
      const tool = tools[0];
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tool.inputSchema.properties).toHaveProperty("project");
      expect(tool.inputSchema.properties).toHaveProperty("project_id");
      for (const phrase of [
        "do not submit a merchant payment",
        "project_id) cannot change",
        "state.domains",
        "no writable domains",
        "available_operations",
        "payment_methods",
        "Sandbox/live",
        "non-secret state.aliases",
        "Never retry failed, timed-out, rejected, or indeterminate payments",
      ]) {
        expect(tool.description).toContain(phrase);
      }
      for (const action of ["rename", "authorize", "callback"]) {
        const result = await client.callTool({
          name: "manage_vaults",
          arguments: { action },
        });
        expect(result.isError).toBeTrue();
      }
    } finally {
      await close();
    }
  });

  test("forwards vault lifecycle, pagination, and fixed-project scope without changing ownership", async () => {
    const calls: unknown[] = [];
    const scopes: unknown[] = [];
    const { client, close } = await connectTestMcp(
      (server, dependencies) =>
        registerVaultTools(server, {
          createKernelClient: (token, project) => {
            scopes.push([token, project]);
            return dependencies!.createKernelClient(token, project);
          },
        }),
      {
        vaults: {
          upsert: async (...args: unknown[]) => {
            calls.push(["upsert", ...args]);
            return vault;
          },
          retrieve: async (...args: unknown[]) => {
            calls.push(["get", ...args]);
            return vault;
          },
          list: async (...args: unknown[]) => {
            calls.push(["list", ...args]);
            return {
              getPaginatedItems: () => [vault],
              has_more: true,
              next_offset: 5,
            };
          },
          delete: async (...args: unknown[]) => {
            calls.push(["delete", ...args]);
          },
        },
      },
    );
    try {
      const created = toolResultJSON(
        await client.callTool({
          name: "manage_vaults",
          arguments: {
            action: "upsert",
            name: "checkout",
            project: "proj_test",
          },
        }),
      );
      expect(created).toEqual(vault);
      await client.callTool({
        name: "manage_vaults",
        arguments: {
          action: "get",
          id_or_name: "checkout",
          project_id: "proj_test",
        },
      });
      const listed = toolResultJSON(
        await client.callTool({
          name: "manage_vaults",
          arguments: { action: "list", limit: 2, offset: 3 },
        }),
      );
      expect(listed).toEqual({
        items: [vault],
        has_more: true,
        next_offset: 5,
      });
      expect(
        text(
          await client.callTool({
            name: "manage_vaults",
            arguments: { action: "delete", id_or_name: "vault_1" },
          }),
        ),
      ).toContain("invalidated");
      const requestOptions = expect.objectContaining({
        maxRetries: 0,
        timeout: 90000,
        signal: expect.any(AbortSignal),
      });
      expect(calls).toEqual([
        ["upsert", { name: "checkout" }, requestOptions],
        ["get", "checkout", requestOptions],
        ["list", { limit: 2, offset: 3 }, requestOptions],
        ["delete", "vault_1", requestOptions],
      ]);
      expect(scopes).toEqual(Array(4).fill(["test-token", "proj_test"]));
      const wrongProject = await client.callTool({
        name: "manage_vaults",
        arguments: { action: "list", project: "other_project" },
      });
      expect(wrongProject.isError).toBeTrue();
      expect(calls).toHaveLength(4);
    } finally {
      await close();
    }
  });

  test("handles empty collections with setup guidance", async () => {
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: {
        list: async () => ({
          getPaginatedItems: () => [],
          has_more: false,
          next_offset: null,
        }),
        items: { list: async () => [] },
      },
    });
    try {
      const listed = toolResultJSON(
        await client.callTool({
          name: "manage_vaults",
          arguments: { action: "list" },
        }),
      );
      expect(listed.items).toEqual([]);
      expect(listed.note).toContain("upsert");
      const items = toolResultJSON(
        await client.callTool({
          name: "manage_vaults",
          arguments: { action: "list_items", id_or_name: "checkout" },
        }),
      );
      expect(items.items).toEqual([]);
      expect(items.note).toContain("wallet");
    } finally {
      await close();
    }
  });

  test("forwards the Link wallet/card lifecycle through the real preview SDK", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const pendingWallet = {
      ...walletItem(),
      state: { provider: "link", status: "pending_authorization" },
      action: {
        name: "link_oauth",
        url: "https://provider.example.test/connect",
      },
    };
    const pendingCard = {
      ...cardItem(),
      state: { provider: "link", status: "pending_authorization" },
      action: {
        name: "spend_approval",
        url: "https://provider.example.test/approve",
      },
    };
    const readyCard = {
      ...cardItem(),
      state: {
        provider: "link",
        status: "ready",
        aliases,
        domains: ["shop.example.test"],
      },
      available_operations: [],
    };
    const expandedWallet = {
      ...walletItem(),
      expanded: {
        payment_methods: [
          {
            id: "pm_1",
            provider: "link",
            type: "card",
            display: { last4: "1234" },
            is_default: true,
            capabilities: {},
          },
        ],
      },
    };
    const responses = [
      pendingWallet,
      expandedWallet,
      cardItem(),
      cardItem(),
      cardItem(),
      pendingCard,
      readyCard,
      [
        {
          id: "event_1",
          name: "payment_unknown",
          browser_id: "browser_1",
          created_at: dates.created_at,
          data: { raw_response: "sensitive-value" },
        },
      ],
      null,
    ];
    const sdk = new Kernel({
      apiKey: "test-key",
      baseURL: "https://api.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push({
          method: request.method,
          path: url.pathname + url.search,
          body: request.body ? await request.json() : undefined,
        });
        const response = responses.shift();
        return response === null
          ? new Response(null, { status: 204 })
          : Response.json(response);
      },
    });
    const { client, close } = await connectTestMcp(registerVaultTools, sdk);
    try {
      const call = (args: Record<string, unknown>) =>
        client.callTool({
          name: "manage_vaults",
          arguments: { id_or_name: "checkout", ...args },
        });
      expect(
        toolResultJSON(
          await call({
            action: "upsert_item",
            key: "wallet",
            item: { type: "wallet", spec: linkWallet },
          }),
        ).action,
      ).toEqual(pendingWallet.action);
      const methods = toolResultJSON(
        await call({
          action: "get_item",
          key: "wallet",
          expand: ["payment_methods"],
          wait: 0,
        }),
      );
      expect(methods.expanded.payment_methods[0].capabilities).toEqual({});
      const purchaseSpec = {
        ...linkCard,
        test: false,
        expires_at: 1900000000,
        metadata: { purpose: "purchase" },
        line_items: [
          {
            name: "Item",
            quantity: 1,
            unit_amount: 1250,
            description: "Purchase",
            sku: "sku_1",
            url: "https://shop.example.test/item",
            image_url: "https://shop.example.test/image",
            product_url: "https://shop.example.test/product",
            totals: [
              { type: "subtotal", display_text: "Subtotal", amount: 1250 },
            ],
          },
        ],
        totals: [{ type: "total", display_text: "Total", amount: 1250 }],
      };
      await call({
        action: "upsert_item",
        key: "card",
        item: { type: "card", spec: purchaseSpec },
      });
      await call({
        action: "update_item",
        key: "card",
        spec: { ...linkCard, amount: 2000 },
      });
      expect(
        toolResultJSON(
          await call({
            action: "perform_item_operation",
            key: "card",
            operation: "authorize",
          }),
        ).action,
      ).toEqual(pendingCard.action);
      const ready = toolResultJSON(
        await call({ action: "get_item", key: "card", wait: 60 }),
      );
      expect(ready.state.aliases).toEqual(aliases);
      expect(ready.state.domains).toEqual(["shop.example.test"]);
      const events = toolResultJSON(
        await call({
          action: "item_events",
          key: "card",
          after: "event_0",
          wait: 5,
        }),
      );
      expect(events.items[0]).toEqual({
        id: "event_1",
        name: "payment_unknown",
        browser_id: "browser_1",
        created_at: dates.created_at,
      });
      expect(events.note).toContain("does not establish payment success");
      await call({ action: "delete_item", key: "card" });
      expect(calls).toEqual([
        {
          method: "PUT",
          path: "/vaults/checkout/items/wallet",
          body: { type: "wallet", spec: linkWallet },
        },
        {
          method: "GET",
          path: "/vaults/checkout/items/wallet?expand=payment_methods&wait=0",
          body: undefined,
        },
        {
          method: "PUT",
          path: "/vaults/checkout/items/card",
          body: { type: "card", spec: purchaseSpec },
        },
        {
          method: "PATCH",
          path: "/vaults/checkout/items/card",
          body: { spec: { ...linkCard, amount: 2000 } },
        },
        { method: "GET", path: "/vaults/checkout/items/card", body: undefined },
        {
          method: "POST",
          path: "/vaults/checkout/items/card/operations",
          body: { type: "authorize" },
        },
        {
          method: "GET",
          path: "/vaults/checkout/items/card?wait=60",
          body: undefined,
        },
        {
          method: "GET",
          path: "/vaults/checkout/items/card/events?after=event_0&wait=5",
          body: undefined,
        },
        {
          method: "DELETE",
          path: "/vaults/checkout/items/card",
          body: undefined,
        },
      ]);
    } finally {
      await close();
    }
  });

  test("supports AgentCard enrollment, configured cards, and approval/outcome inspection", async () => {
    const calls: unknown[] = [];
    const authorization = {
      id: "auth_1",
      status: "approved",
      psp: "stripe",
      merchant: "Test shop",
      amount_cents: 1250,
      currency: "usd",
      created_at: dates.created_at,
      approval_url: "https://provider.example.test/approve",
      charged_kind: "none",
      replay_attempted: true,
      replay_delivered: false,
      reason: "sensitive-value",
    };
    const card = {
      ...cardItem(agentCard),
      state: { provider: "agentcard", status: "ready", aliases, authorization },
    };
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: {
        items: {
          upsert: async (
            key: string,
            params: { spec: WalletVaultItemSpec | CardVaultItemSpec },
          ) => {
            calls.push(["upsert", key, params]);
            return key === "wallet"
              ? {
                  ...walletItem({ provider: "agentcard" }),
                  action: {
                    name: "card_enrollment",
                    url: "https://provider.example.test/enroll",
                  },
                }
              : card;
          },
          update: async (...args: unknown[]) => {
            calls.push(["update", ...args]);
            return card;
          },
          retrieve: async () => card,
          performOperation: async () => {
            calls.push(["unexpected_authorization"]);
            return card;
          },
        },
      },
    });
    try {
      const call = (args: Record<string, unknown>) =>
        client.callTool({
          name: "manage_vaults",
          arguments: { id_or_name: "checkout", ...args },
        });
      expect(
        toolResultJSON(
          await call({
            action: "upsert_item",
            key: "wallet",
            item: {
              type: "wallet",
              spec: { provider: "agentcard", user_id: "usr_existing" },
            },
          }),
        ).action.name,
      ).toBe("card_enrollment");
      await call({
        action: "upsert_item",
        key: "card",
        item: { type: "card", spec: { ...agentCard, card_id: "vc_selected" } },
      });
      await call({
        action: "update_item",
        key: "card",
        spec: { ...agentCard, amount: 1500 },
      });
      const result = await call({ action: "get_item", key: "card" });
      expect(text(result)).not.toContain("sensitive-value");
      expect(toolResultJSON(result).state.authorization).toMatchObject({
        status: "approved",
        charged_kind: "none",
        replay_delivered: false,
      });
      expect(
        (
          await call({
            action: "perform_item_operation",
            key: "card",
            operation: "authorize",
          })
        ).isError,
      ).toBeTrue();
      expect(calls[0]).toEqual([
        "upsert",
        "wallet",
        {
          id_or_name: "checkout",
          type: "wallet",
          spec: { provider: "agentcard", user_id: "usr_existing" },
        },
      ]);
      expect(calls[1]).toEqual([
        "upsert",
        "card",
        {
          id_or_name: "checkout",
          type: "card",
          spec: { ...agentCard, card_id: "vc_selected" },
        },
      ]);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual([
        "update",
        "card",
        { id_or_name: "checkout", spec: { ...agentCard, amount: 1500 } },
        expect.objectContaining({ maxRetries: 0 }),
      ]);
    } finally {
      await close();
    }
  });

  test("strips unknown secrets while preserving actions, aliases, domains, and state", async () => {
    const secret = "sensitive-value";
    const unsafe = {
      ...cardItem(),
      secret_enc: secret,
      provider_response: secret,
      spec: { ...linkCard, metadata: { token: secret } },
      state: {
        provider: "link",
        status: "ready",
        aliases: { ...aliases, card_number: secret },
        masks: { brand: "test", last4: "1234", token: secret },
        domains: ["shop.example.test"],
        oauth_token: secret,
      },
      action: { name: "collect", data: { card_number: secret } },
    };
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: {
        items: { retrieve: async () => unsafe, list: async () => [unsafe] },
      },
    });
    try {
      for (const action of ["get_item", "list_items"]) {
        const result = await client.callTool({
          name: "manage_vaults",
          arguments: { action, id_or_name: "checkout", key: "card" },
        });
        expect(result.isError).not.toBeTrue();
        expect(text(result)).not.toContain(secret);
        const parsed = toolResultJSON(result);
        const item = action === "get_item" ? parsed : parsed.items[0];
        expect(item.state.aliases).toEqual(aliases);
        expect(item.state.masks).toEqual({ brand: "test", last4: "1234" });
        expect(item.action).toEqual({ name: "collect" });
      }
    } finally {
      await close();
    }
  });

  test.each([400, 401, 403, 404, 409, 429, 500])(
    "withholds HTTP %i provider errors without retrying the real SDK request",
    async (status) => {
      let attempts = 0;
      const sdk = new Kernel({
        apiKey: "test-key",
        baseURL: "https://api.example.test",
        fetch: async () => {
          attempts++;
          return Response.json(
            {
              message: "sensitive-value",
              code: "sensitive-value",
              card_number: "sensitive-value",
              oauth_token: "sensitive-value",
            },
            { status },
          );
        },
      });
      const { client, close } = await connectTestMcp(registerVaultTools, sdk);
      try {
        const result = await client.callTool({
          name: "manage_vaults",
          arguments: {
            action: "upsert_item",
            id_or_name: "checkout",
            key: "card",
            item: { type: "card", spec: linkCard },
          },
        });
        expect(attempts).toBe(1);
        expect(result.isError).toBeTrue();
        expect(text(result)).toContain(`HTTP ${status}`);
        expect(text(result)).not.toContain("sensitive-value");
        expect(text(result)).toContain("Do not retry a payment");
      } finally {
        await close();
      }
    },
  );

  test.each([
    new APIConnectionTimeoutError(),
    new Error("sensitive-value"),
    APIError.generate(
      409,
      { message: "sensitive-value" },
      undefined,
      new Headers(),
    ),
  ])("withholds transport and unexpected errors %#", async (error) => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: {
        items: {
          retrieve: async () => {
            calls++;
            throw error;
          },
        },
      },
    });
    try {
      const result = await client.callTool({
        name: "manage_vaults",
        arguments: { action: "get_item", id_or_name: "checkout", key: "card" },
      });
      expect(result.isError).toBeTrue();
      expect(text(result)).not.toContain("sensitive-value");
      expect(text(result)).toContain("item_events");
      expect(calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("waits beyond the requested long-poll budget without automatic retries", async () => {
    const calls: unknown[] = [];
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: {
        items: {
          retrieve: async (...args: unknown[]) => {
            calls.push(args);
            return cardItem();
          },
          events: async (...args: unknown[]) => {
            calls.push(args);
            return [];
          },
        },
      },
    });
    try {
      for (const action of ["get_item", "item_events"]) {
        await client.callTool({
          name: "manage_vaults",
          arguments: { action, id_or_name: "checkout", key: "card", wait: 60 },
        });
      }
      expect(calls).toEqual(
        Array(2).fill([
          "card",
          { id_or_name: "checkout", wait: 60 },
          { timeout: 90000, maxRetries: 0, signal: expect.any(AbortSignal) },
        ]),
      );
    } finally {
      await close();
    }
  });

  test("does not leak schema validation details from an unexpected provider response", async () => {
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: {
        items: {
          retrieve: async () => ({
            ...cardItem(),
            state: { provider: "sensitive-value", status: "sensitive-value" },
          }),
        },
      },
    });
    try {
      const result = await client.callTool({
        name: "manage_vaults",
        arguments: { action: "get_item", id_or_name: "checkout", key: "card" },
      });
      expect(result.isError).toBeTrue();
      expect(text(result)).not.toContain("sensitive-value");
    } finally {
      await close();
    }
  });

  test("validates required action fields, wait, and expansions before SDK calls", async () => {
    const { client, close } = await connectTestMcp(registerVaultTools, {
      vaults: { items: {} },
    });
    try {
      for (const args of [
        { action: "upsert" },
        { action: "get" },
        { action: "get_item", id_or_name: "checkout" },
        { action: "upsert_item", id_or_name: "checkout", key: "card" },
        { action: "update_item", id_or_name: "checkout", key: "card" },
        {
          action: "perform_item_operation",
          id_or_name: "checkout",
          key: "card",
        },
        ...[-1, 61, 0.5].map((wait) => ({
          action: "get_item",
          id_or_name: "checkout",
          key: "card",
          wait,
        })),
        {
          action: "get_item",
          id_or_name: "checkout",
          key: "card",
          expand: ["secrets"],
        },
        {
          action: "get_item",
          id_or_name: "checkout",
          key: "card",
          expand: ["payment_methods", "payment_methods"],
        },
      ]) {
        const result = await client.callTool({
          name: "manage_vaults",
          arguments: args,
        });
        expect(result.isError).toBeTrue();
        expect(text(result)).not.toContain("is not a function");
      }
    } finally {
      await close();
    }
  });
});
