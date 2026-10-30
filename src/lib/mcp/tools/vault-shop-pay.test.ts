import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";

const walletSpec = {
  authorization: {
    method: "oauth" as const,
    client: { type: "kernel_managed" as const },
  },
};

const cardSpec = {
  wallet: "shop-pay-wallet",
  payment_method_id: "shop-card-1",
  amount: 12_000,
  currency: "USD",
  merchant_name: "Example Coffee",
  merchant_url: "https://shop.example.com/checkout",
  merchant_country: "US",
  context:
    "A ceramic pour-over coffee set as a birthday present for my sister, from the small roaster she likes, shipped to me so I can wrap it first.",
  line_items: [
    { name: "Ceramic pour-over set", quantity: 1, unit_amount: 10_500 },
  ],
  totals: [
    { type: "subtotal", amount: 10_500 },
    { type: "discount", amount: -500 },
    { type: "fulfillment", amount: 1_000 },
    { type: "tax", amount: 1_000 },
    { type: "total", amount: 12_000 },
  ],
};

const shopPayWallet = {
  ...item,
  key: "shop-pay-wallet",
  type: "wallet",
  spec: { provider: "shop_pay", ...walletSpec },
  state: { provider: "shop_pay", status: "pending_authorization" },
  action: {
    name: "shop_pay_oauth",
    url: "https://shop.example/connect?request=public-reference",
  },
  available_operations: [],
  available_expansions: [
    { type: "payment_methods", description: "Saved Shop Pay cards." },
  ],
};

const shopPayCard = {
  ...item,
  spec: { provider: "shop_pay", ...cardSpec },
  state: {
    provider: "shop_pay",
    status: "requested",
    masks: { brand: "visa", last4: "4242", token_last4: "1234" },
  },
};

const checkout = {
  browser_id: "browser-session-id",
  page_url: "https://shop.example.com/checkout?order=1#payment",
};

describe("Shop Pay vault coverage", () => {
  test("advertises Shop Pay wallet and card schemas from the API contract", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const wallets = tools.find(({ name }) => name === "manage_vault_wallets");
      const cards = tools.find(({ name }) => name === "manage_vault_cards");
      const items = tools.find(({ name }) => name === "manage_vault_items");
      const providerConfigs = tools.find(
        ({ name }) => name === "manage_vault_provider_configs",
      );

      for (const tool of [wallets, cards]) {
        expect(tool?.inputSchema.properties?.provider).toMatchObject({
          enum: ["link", "agentcard", "kernel", "shop_pay"],
        });
      }
      expect(providerConfigs?.inputSchema.properties?.provider).toMatchObject({
        enum: ["link", "agentcard"],
      });
      expect(wallets?.description).toContain("shop_pay_oauth");
      expect(wallets?.description).toContain("shared unchanged");
      expect(cards?.description).toContain("billing_first_name");
      expect(cards?.description).toContain(
        "`PURCHASE`, `AUTHORIZATION`, or `CAPTURE`",
      );
      expect(items?.description).toContain("order_id");
      expect(items?.description).toContain("payment_declined");

      const cardSchema = cards?.inputSchema.properties?.spec as
        | { anyOf?: Array<{ properties?: Record<string, unknown> }> }
        | undefined;
      const shopPay = cardSchema?.anyOf?.find(
        (variant) =>
          (variant.properties?.provider as { const?: string } | undefined)
            ?.const === "shop_pay",
      );
      expect(shopPay?.properties).toMatchObject({
        amount: { minimum: 1, maximum: 1_000_000 },
        currency: { pattern: "^[Uu][Ss][Dd]$" },
        context: { minLength: 100, maxLength: 500 },
        totals: { minItems: 1 },
      });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("creates a Shop Pay wallet and returns the user authorization action", async () => {
    const fixture = await connectVaultTest([Response.json(shopPayWallet)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          action: "create",
          provider: "shop_pay",
          vault: "checkout",
          key: "shop-pay-wallet",
          spec: walletSpec,
        }),
      );

      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        path: "/vaults/checkout/items/shop-pay-wallet",
        body: {
          type: "wallet",
          spec: { provider: "shop_pay", ...walletSpec },
        },
      });
      expect(result.item).toMatchObject({
        type: "wallet",
        spec: { provider: "shop_pay", ...walletSpec },
        state: { provider: "shop_pay", status: "pending_authorization" },
        action: shopPayWallet.action,
      });
      expect(result.guidance.join(" ")).toContain(
        "share item.action.url unchanged",
      );
      expect(result.guidance.join(" ")).toContain("payment_methods");
    } finally {
      await fixture.close();
    }
  });

  test("lists saved Shop Pay cards through the live payment-method expansion", async () => {
    const paymentMethods = [
      {
        id: "shop-card-1",
        provider: "shop_pay",
        type: "card",
        is_default: true,
        display: { label: "Visa 4242", brand: "visa", last4: "4242" },
        capabilities: {},
      },
      {
        id: "shop-card-2",
        provider: "shop_pay",
        type: "card",
        is_default: false,
        display: { brand: "mastercard", last4: "4444" },
        capabilities: {},
      },
    ];
    const fixture = await connectVaultTest([
      Response.json({
        ...shopPayWallet,
        state: { provider: "shop_pay", status: "connected" },
        action: undefined,
        expanded: { payment_methods: paymentMethods },
      }),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          action: "payment_methods",
          vault: "checkout",
          key: "shop-pay-wallet",
        }),
      );
      expect(fixture.requests[0]).toMatchObject({
        method: "GET",
        path: "/vaults/checkout/items/shop-pay-wallet?expand=payment_methods",
      });
      expect(result.item.expanded.payment_methods).toEqual(paymentMethods);
      expect(result.guidance.join(" ")).toContain(
        "shopper's saved shop pay cards",
      );
    } finally {
      await fixture.close();
    }
  });

  test("creates and updates the complete Shop Pay purchase specification", async () => {
    const { payment_method_id: _selectedMethod, ...cardSpecWithoutMethod } =
      cardSpec;
    const updatedSpec = {
      ...cardSpecWithoutMethod,
      line_items: [
        { name: "Ceramic pour-over set", quantity: 1, unit_amount: 0 },
      ],
    };
    const fixture = await connectVaultTest([
      Response.json(shopPayCard),
      Response.json({
        ...shopPayCard,
        spec: { provider: "shop_pay", ...updatedSpec },
      }),
    ]);
    try {
      const created = await fixture.call("manage_vault_cards", {
        action: "create",
        provider: "shop_pay",
        vault: "checkout",
        key: "order-1",
        spec: cardSpec,
      });
      const updated = await fixture.call("manage_vault_cards", {
        action: "update",
        provider: "shop_pay",
        vault: "checkout",
        key: "order-1",
        spec: updatedSpec,
      });

      expect(created.isError).toBeFalsy();
      expect(updated.isError).toBeFalsy();
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: { type: "card", spec: { provider: "shop_pay", ...cardSpec } },
      });
      expect(fixture.requests[1]).toMatchObject({
        method: "PATCH",
        body: {
          spec: {
            provider: "shop_pay",
            ...updatedSpec,
          },
        },
      });
      expect(fixture.requests[1].body).not.toHaveProperty(
        "spec.payment_method_id",
      );
    } finally {
      await fixture.close();
    }
  });

  test("authorizes at final checkout and projects Shop Pay card state", async () => {
    const pending = {
      ...shopPayCard,
      state: { provider: "shop_pay", status: "pending_authorization" },
      action: {
        name: "spend_approval",
        url: "https://shop.example/approve?request=public-reference",
      },
      available_operations: [],
    };
    const fixture = await connectVaultTest([
      Response.json(shopPayCard),
      Response.json(pending),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_cards", {
          action: "authorize",
          provider: "shop_pay",
          vault: "checkout",
          key: "order-1",
          ...checkout,
        }),
      );
      expect(fixture.requests[1].body).toEqual({
        type: "authorize",
        ...checkout,
      });
      expect(result.item).toMatchObject({
        spec: { provider: "shop_pay" },
        state: { provider: "shop_pay", status: "pending_authorization" },
        action: pending.action,
      });
      expect(result.guidance.join(" ")).toContain(
        "sends the page to shop as the merchant",
      );
    } finally {
      await fixture.close();
    }
  });

  test("uses Shop Pay checkout recovery without exposing an action URL", async () => {
    const actionUrl = "https://shop.example/approve?secret=do-not-expose";
    const fixture = await connectVaultTest([
      Response.json(shopPayCard),
      Response.json(
        {
          code: "page_not_found",
          message: `checkout was not found; retry at ${actionUrl}`,
        },
        { status: 400 },
      ),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        action: "authorize",
        provider: "shop_pay",
        vault: "checkout",
        key: "order-1",
        ...checkout,
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(result.isError).toBe(true);
      expect(text).toContain("api code: page_not_found");
      expect(text).toContain("authorize for merchant_url");
      expect(text).not.toContain("virtual card");
      expect(text).not.toContain(actionUrl);
      expect(text).toContain("[redacted url]");
    } finally {
      await fixture.close();
    }
  });

  test("fills separate billing names and forwards a zero-amount outcome with Shop Pay details", async () => {
    const ready = {
      ...shopPayCard,
      state: { provider: "shop_pay", status: "ready" },
      available_operations: [
        { type: "fill", description: "Fill the issued card." },
        {
          type: "confirm_transaction",
          description: "Report the observed merchant outcome.",
        },
      ],
    };
    const consumed = {
      ...ready,
      state: { provider: "shop_pay", status: "consumed" },
      available_operations: [],
    };
    const fillInputs = {
      ...checkout,
      fields: [
        { field: "billing_first_name", selector: "#first-name" },
        { field: "billing_last_name", selector: "#last-name" },
      ],
    };
    const report = {
      status: "APPROVED",
      transaction_type: "CAPTURE",
      amount: 0,
      currency: "USD",
      occurred_at: "2026-10-01T12:00:00Z",
      order_id: "ORDER-123",
      order_url: "https://shop.example.com/orders/ORDER-123",
    };
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json({ type: "fill", status: "completed", fields: [] }),
      Response.json(ready),
      Response.json(consumed),
    ]);
    try {
      const filled = await fixture.call("manage_vault_items", {
        action: "invoke",
        operation: "fill",
        vault: "checkout",
        key: "order-1",
        inputs: fillInputs,
      });
      const confirmed = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "invoke",
          operation: "confirm_transaction",
          vault: "checkout",
          key: "order-1",
          inputs: report,
        }),
      );

      expect(filled.isError).toBeFalsy();
      expect(fixture.requests[1].body).toEqual({ type: "fill", ...fillInputs });
      expect(fixture.requests[3].body).toEqual({
        type: "confirm_transaction",
        ...report,
      });
      expect(confirmed.item.state.status).toBe("consumed");
      expect(confirmed.guidance.join(" ")).toContain(
        "reporting consumes the card",
      );
    } finally {
      await fixture.close();
    }
  });

  test("forwards the Shop Pay declined failure code with a zero amount", async () => {
    const ready = {
      ...shopPayCard,
      state: { provider: "shop_pay", status: "ready" },
      available_operations: [{ type: "confirm_transaction" }],
    };
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json({
        ...ready,
        state: { provider: "shop_pay", status: "consumed" },
        available_operations: [],
      }),
    ]);
    try {
      const inputs = {
        status: "DECLINED",
        transaction_type: "PURCHASE",
        amount: 0,
        currency: "USD",
        occurred_at: "2026-10-01T12:00:00Z",
        failure_code: "payment_declined",
      };
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        operation: "confirm_transaction",
        vault: "checkout",
        key: "order-1",
        inputs,
      });
      expect(result.isError).toBeFalsy();
      expect(fixture.requests[1].body).toEqual({
        type: "confirm_transaction",
        ...inputs,
      });
    } finally {
      await fixture.close();
    }
  });

  test("rejects invalid Shop Pay transaction inputs before submission", async () => {
    const ready = {
      ...shopPayCard,
      state: { provider: "shop_pay", status: "ready" },
      available_operations: [{ type: "confirm_transaction" }],
    };
    const base = {
      status: "APPROVED",
      transaction_type: "PURCHASE",
      amount: 1,
      currency: "USD",
      occurred_at: "2026-10-01T12:00:00Z",
    };
    const fixture = await connectVaultTest([Response.json(ready)]);
    try {
      const invalidTotals = await fixture.call("manage_vault_cards", {
        action: "create",
        provider: "shop_pay",
        vault: "checkout",
        key: "order-2",
        spec: {
          ...cardSpec,
          totals: [{ type: "subtotal", amount: 12_000 }],
        },
      });
      expect(invalidTotals.isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);

      const unknown = await fixture.call("manage_vault_items", {
        action: "invoke",
        operation: "confirm_transaction",
        vault: "checkout",
        key: "order-1",
        inputs: { ...base, unexpected: false },
      });
      expect(unknown.isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);

      const unsupported = await fixture.call("manage_vault_items", {
        action: "invoke",
        operation: "confirm_transaction",
        vault: "checkout",
        key: "order-1",
        inputs: { ...base, transaction_type: "REFUND" },
      });
      expect(unsupported.isError).toBe(true);
      expect(JSON.stringify(unsupported)).toContain(
        "accepts only PURCHASE, AUTHORIZATION, or CAPTURE",
      );
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].method).toBe("GET");
    } finally {
      await fixture.close();
    }
  });
});
