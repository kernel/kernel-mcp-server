import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";

const actionURL = "https://vault.example/approve#token=private-capability";
const wallet = {
  ...item,
  type: "wallet",
  spec: { provider: "kernel" },
  state: { provider: "kernel", status: "pending_authorization" },
  action: { name: "card_enrollment", url: actionURL },
};
const card = {
  ...item,
  spec: {
    provider: "kernel",
    wallet: "wallet-1",
    amount: 1999,
    currency: "usd",
    merchant_name: "Shop",
    merchant_url: "https://shop.example/pay",
    merchant_country: "US",
  },
  state: { provider: "kernel", status: "pending_authorization" },
  action: { name: "spend_approval", url: actionURL },
};

async function callCard(
  replies: Response[],
  action: "create" | "authorize" | "update",
  spec?: Record<string, unknown>,
) {
  const fixture = await connectVaultTest(replies);
  const result = await fixture.call("manage_vault_cards", {
    action,
    provider: "kernel",
    vault: "checkout",
    key: "order-1",
    ...(spec && { spec }),
  });
  return { fixture, result };
}

describe("kernel-managed payment tools", () => {
  test("creates a wallet, returns enrollment and observes payment-method eligibility", async () => {
    const expanded = {
      ...wallet,
      state: { provider: "kernel", status: "connected" },
      action: undefined,
      expanded: {
        payment_methods: [
          {
            id: "pm_1",
            provider: "kernel",
            type: "card",
            is_default: false,
            display: { brand: "visa", last4: "4242" },
            capabilities: {
              single_use_card: {
                eligible: false,
                reasons: ["network_token_pending"],
              },
            },
          },
        ],
      },
    };
    const fixture = await connectVaultTest([
      Response.json(wallet),
      Response.json(expanded),
    ]);
    try {
      const created = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          action: "create",
          provider: "kernel",
          spec: {},
          vault: "checkout",
          key: "wallet-1",
        }),
      );
      expect(created.item.action).toEqual(wallet.action);
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: { type: "wallet", spec: { provider: "kernel" } },
      });
      const methods = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          action: "payment_methods",
          vault: "checkout",
          key: "wallet-1",
        }),
      );
      expect(methods.item.expanded).toEqual(expanded.expanded);
      expect(fixture.requests[1].path).toContain("expand=payment_methods");
    } finally {
      await fixture.close();
    }
  });

  test("advertises kernel as a provider without exposing card-number inputs", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      for (const name of ["manage_vault_wallets", "manage_vault_cards"]) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema;
        expect(schema?.properties?.provider).toMatchObject({
          enum: ["link", "agentcard", "kernel"],
        });
        expect(schema?.properties).not.toHaveProperty("card_number");
        expect(schema?.properties).not.toHaveProperty("cvc");
      }
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("creates a Visa card with merchant country but does not authorize", async () => {
    const { fixture, result } = await callCard(
      [Response.json(card)],
      "create",
      {
        wallet: "wallet-1",
        amount: 1999,
        currency: "usd",
        merchant_name: "Shop",
        merchant_url: "https://shop.example/pay",
        merchant_country: "US",
      },
    );
    try {
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).item.spec.merchant_country).toBe("US");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: { type: "card", spec: card.spec },
      });
    } finally {
      await fixture.close();
    }
  });

  test("authorizes only an advertised kernel card and returns the Visa action", async () => {
    const fixture = await connectVaultTest([
      Response.json(card),
      Response.json(card),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        action: "authorize",
        provider: "kernel",
        vault: "checkout",
        key: "order-1",
      });
      expect(toolResultJSON(result).item.action).toEqual(card.action);
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
      ]);
      expect(fixture.requests[1].body).toEqual({ type: "authorize" });
    } finally {
      await fixture.close();
    }
  });

  test("does not authorize unadvertised, non-kernel, or update requests", async () => {
    const fixture = await connectVaultTest([
      Response.json({ ...card, available_operations: [] }),
      Response.json(item),
    ]);
    try {
      const args = {
        action: "authorize",
        provider: "kernel",
        vault: "checkout",
        key: "order-1",
      };
      expect((await fixture.call("manage_vault_cards", args)).isError).toBe(
        true,
      );
      expect((await fixture.call("manage_vault_cards", args)).isError).toBe(
        true,
      );
      expect(
        (
          await fixture.call("manage_vault_cards", {
            ...args,
            action: "update",
            spec: card.spec,
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await fixture.call("manage_vault_cards", {
            ...args,
            provider: "link",
          })
        ).isError,
      ).toBe(true);
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "GET",
        "GET",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("rejects card data and malformed merchant country without sending a request", async () => {
    const fixture = await connectVaultTest([]);
    try {
      for (const spec of [
        { ...card.spec, number: "4111111111111111" },
        { ...card.spec, cvc: "123" },
        { ...card.spec, merchant_country: "USA" },
        { ...card.spec, merchant_url: "http://shop.example/pay" },
      ]) {
        const result = await fixture.call("manage_vault_cards", {
          action: "create",
          provider: "kernel",
          vault: "checkout",
          key: "order-1",
          spec,
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("4111111111111111");
      }
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("observes pending and ready cards without returning network token material", async () => {
    const ready = {
      ...card,
      action: undefined,
      state: {
        provider: "kernel",
        status: "ready",
        masks: { brand: "visa", last4: "4242", token_last4: "1234" },
        pan: "secret-pan",
      },
    };
    const fixture = await connectVaultTest([
      Response.json(card),
      Response.json(ready),
      Response.json([
        { id: "evt_1", name: "card.ready", data: { raw: "secret-event" } },
      ]),
    ]);
    try {
      const args = { action: "get", vault: "checkout", key: "order-1" };
      expect(
        toolResultJSON(await fixture.call("manage_vault_items", args)).item
          .state.status,
      ).toBe("pending_authorization");
      const observed = toolResultJSON(
        await fixture.call("manage_vault_items", args),
      );
      expect(observed.item.state.masks).toEqual(ready.state.masks);
      expect(JSON.stringify(observed)).not.toContain("secret-pan");
      const events = toolResultJSON(
        await fixture.call("manage_vault_items", { ...args, action: "events" }),
      );
      expect(events.next_after).toBe("evt_1");
      expect(JSON.stringify(events)).not.toContain("secret-event");
      expect(fixture.requests.every(({ method }) => method === "GET")).toBe(
        true,
      );
    } finally {
      await fixture.close();
    }
  });

  test("does not echo bearer action URLs from API errors", async () => {
    const fixture = await connectVaultTest([
      Response.json({ message: `failed: ${actionURL}` }, { status: 409 }),
    ]);
    try {
      const result = await fixture.call("manage_vault_wallets", {
        action: "create",
        provider: "kernel",
        spec: {},
        vault: "checkout",
        key: "wallet-1",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(actionURL);
    } finally {
      await fixture.close();
    }
  });
});
