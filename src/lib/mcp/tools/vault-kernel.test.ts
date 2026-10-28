import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  connectVaultTest,
  item,
  linkSpec,
} from "@/lib/mcp/tools/vaults.test-fixtures";

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

  test("advertises the Kernel card amount cap in tools/list", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const schema = tools.find(
        (tool) => tool.name === "manage_vault_cards",
      )?.inputSchema;
      expect(schema?.properties?.spec).toMatchObject({
        anyOf: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              provider: expect.objectContaining({ const: "kernel" }),
              amount: expect.objectContaining({
                minimum: 1,
                maximum: 1_000_000,
              }),
            }),
          }),
        ]),
      });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test.each([1, 50_001, 750_000, 1_000_000])(
    "creates a Kernel card for %i minor units without authorizing",
    async (amount) => {
      const spec = { ...card.spec, amount };
      const { fixture, result } = await callCard(
        [Response.json({ ...card, spec })],
        "create",
        spec,
      );
      try {
        expect(result.isError).toBeUndefined();
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({
          method: "PUT",
          body: { type: "card", spec },
        });
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([0, -1, 1.1, 1_000_001])(
    "rejects a Kernel card for %s minor units without sending a request",
    async (amount) => {
      const { fixture, result } = await callCard([], "create", {
        ...card.spec,
        amount,
      });
      try {
        expect(result.isError).toBe(true);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

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

  test("does not authorize unadvertised, mismatched-provider, agentcard, or update requests", async () => {
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
            provider: "agentcard",
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

  test("fills only value-free card bindings with the exact expiration format", async () => {
    const inputs = {
      browser_id: "browser-1",
      page_url: "https://shop.example/pay?order=1#checkout",
      fields: [
        { field: "number", selector: "#card-number" },
        { field: "expiration", selector: "#expiration", format: "MM/YY" },
        { field: "cvc", selector: "#cvc" },
      ],
    };
    const fixture = await connectVaultTest([
      Response.json({
        ...card,
        state: { provider: "kernel", status: "ready" },
        available_operations: [{ type: "fill" }],
      }),
      Response.json({ type: "fill", status: "filled" }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        operation: "fill",
        inputs,
        vault: "checkout",
        key: "order-1",
      });
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({ type: "fill", ...inputs });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { status: 400, code: "field_unavailable" },
    { status: 409, code: "conflict" },
    { status: 500, code: "internal_error" },
    { status: undefined, code: undefined },
  ])(
    "Kernel fill errors pass the api response through: $status",
    async ({ status, code }) => {
      const fixture = await connectVaultTest([
        Response.json({
          ...card,
          state: { provider: "kernel", status: "ready" },
          available_operations: [{ type: "fill" }],
        }),
        status === undefined
          ? new Error(`network failed ${actionURL}`)
          : Response.json({ message: actionURL, code }, { status }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          operation: "fill",
          vault: "checkout",
          key: "order-1",
          inputs: {
            browser_id: "browser-1",
            page_url: "https://shop.example/pay",
            fields: [{ field: "number", selector: "#number" }],
          },
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).not.toContain("fields were written");
        expect(text).not.toContain("safe to retry");
        expect(text).not.toContain("nothing new was authorized");
        expect(text).not.toContain(actionURL);
        if (status !== undefined) {
          expect(text).toContain(
            `http status: ${status}. api code: ${code}. [redacted url]`,
          );
          expect(text).not.toContain("no response was received");
        } else {
          expect(text).toContain(
            "request failed. no response was received from the api after the operation was submitted.",
          );
        }
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          "GET",
          "POST",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["confirm_transaction", "restart_verification"])(
    "passes uncertain %s errors through without retry guidance",
    async (operation) => {
      const fixture = await connectVaultTest([
        Response.json({ ...card, available_operations: [{ type: operation }] }),
        Response.json(
          { message: actionURL, code: "internal_error" },
          { status: 500 },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          operation,
          vault: "checkout",
          key: "order-1",
          ...(operation === "confirm_transaction" && {
            inputs: {
              status: "APPROVED",
              transaction_type: "PURCHASE",
              amount: 1999,
              currency: "USD",
              occurred_at: "2026-09-01T12:00:00Z",
            },
          }),
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(
          "http status: 500. api code: internal_error. [redacted url]",
        );
        expect(text).not.toContain("freshly advertised");
        expect(text).not.toContain("safe to retry");
        expect(text).not.toContain(actionURL);
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          "GET",
          "POST",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("reports an observed transaction at the cap once using the advertised operation body", async () => {
    const amount = 1_000_000;
    const ready = {
      ...card,
      spec: { ...card.spec, amount },
      action: undefined,
      state: { provider: "kernel", status: "ready" },
      available_operations: [{ type: "confirm_transaction" }, { type: "fill" }],
    };
    const reported = { ...ready, available_operations: [{ type: "fill" }] };
    const inputs = {
      status: "APPROVED",
      transaction_type: "PURCHASE",
      amount,
      currency: "USD",
      occurred_at: "2026-06-01T12:00:00Z",
    };
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json(reported),
      Response.json(reported),
    ]);
    try {
      const args = {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "confirm_transaction",
        inputs,
      };
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", args),
      );
      expect(result.item.available_operations).toEqual(
        reported.available_operations,
      );
      expect(fixture.requests[1].body).toEqual({
        type: "confirm_transaction",
        ...inputs,
      });
      expect((await fixture.call("manage_vault_items", args)).isError).toBe(
        true,
      );
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
        "GET",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test.each([true, false])(
    "gates recovery_required verification restart on advertisement: %s",
    async (advertised) => {
      const recovery = {
        ...card,
        state: { provider: "kernel", status: "recovery_required" },
        action: undefined,
        available_operations: advertised
          ? [{ type: "restart_verification" }]
          : [],
      };
      const newAction = { name: "spend_approval", url: `${actionURL}-new` };
      const fixture = await connectVaultTest([
        Response.json(recovery),
        ...(advertised ? [Response.json({ ...card, action: newAction })] : []),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation: "restart_verification",
        });
        if (advertised) {
          expect(result.isError).toBeUndefined();
          expect(toolResultJSON(result).item.action).toEqual(newAction);
          expect(fixture.requests[1].body).toEqual({
            type: "restart_verification",
          });
        } else {
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("not advertised");
        }
        expect(fixture.requests.map(({ method }) => method)).toEqual(
          advertised ? ["GET", "POST"] : ["GET"],
        );
      } finally {
        await fixture.close();
      }
    },
  );

  test("discovery and item guidance explain reporting, fill boundaries, and gated recovery", async () => {
    const recovery = {
      ...card,
      state: { provider: "kernel", status: "recovery_required" },
      available_operations: [{ type: "restart_verification" }],
    };
    const fixture = await connectVaultTest([
      Response.json(recovery),
      Response.json({ ...recovery, available_operations: [] }),
    ]);
    try {
      const { tools } = await fixture.client.listTools();
      for (const name of ["manage_vault_items", "manage_vault_cards"]) {
        const description = tools.find(
          (tool) => tool.name === name,
        )?.description;
        for (const text of [
          "confirm_transaction",
          "restart_verification",
          "billing_*",
          "field_unavailable",
          "occurred_at",
          ...(name === "manage_vault_items" ? ["0..1000000"] : []),
        ])
          expect(description).toContain(text);
      }
      const args = { action: "get", vault: "checkout", key: "order-1" };
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", args),
      );
      const guidance = result.guidance.join(" ");
      for (const text of [
        "confirm_transaction",
        "report one observed outcome",
        "transaction_type",
        "occurred_at",
        "no additional properties",
        "0..1000000",
        "unknown means no reliable merchant outcome",
        "number, expiration",
        'format "MM/YY" or "MM/YYYY"',
        "billing_*",
        "400 field_unavailable",
        "exact current https top-level page_url",
        "restart_verification",
        "no inputs",
        "without a provider call",
        "proof no intent was dispatched",
        "privately",
        "non-restartable recovery_required",
        "safe to retry the field write, not authorization, checkout, or transaction reporting",
      ])
        expect(guidance).toContain(text);
      expect(result.hints.invocation[0]).toMatchObject({
        arguments: { operation: "restart_verification" },
        requires_user_approval: true,
      });
      const blocked = toolResultJSON(
        await fixture.call("manage_vault_items", args),
      );
      expect(blocked.guidance.join(" ")).not.toContain("restart_verification");
      expect(blocked.guidance.join(" ")).toContain("stop payment attempts");
      expect(blocked.hints.invocation).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test.each([400, 409, 422, 500, 503])(
    "redacts authorization errors but retains status and safe code: %s",
    async (status) => {
      const fixture = await connectVaultTest([
        Response.json(card),
        Response.json(
          { message: `failed: ${actionURL}`, code: "invalid_merchant_country" },
          { status },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_cards", {
          action: "authorize",
          provider: "kernel",
          vault: "checkout",
          key: "order-1",
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).not.toContain(actionURL);
        expect(text).not.toContain("private-capability");
        expect(text).toContain(
          `http status: ${status}. api code: invalid_merchant_country. failed: [redacted url]`,
        );
        expect(text).not.toContain("freshly advertised");
        expect(text).not.toContain("inputs to fix");
        expect(fixture.requests).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    { status: 400, code: actionURL },
    { status: 400, code: "x".repeat(65) },
    { status: 400, code: "invalid input" },
    { status: 400, code: { message: actionURL } },
    { status: 400, code: undefined },
  ])("omits unsafe or absent API codes: $code", async ({ status, code }) => {
    const fixture = await connectVaultTest([
      Response.json({ message: actionURL, code }, { status }),
    ]);
    try {
      const result = await fixture.call("manage_vault_cards", {
        action: "create",
        provider: "kernel",
        vault: "checkout",
        key: "order-1",
        spec: card.spec,
      });
      const text = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("http status: 400");
      expect(text).not.toContain("api code:");
      expect(text).not.toContain(actionURL);
    } finally {
      await fixture.close();
    }
  });

  test.each(["manage_vault_cards", "manage_vault_items"])(
    "handles transport failures consistently for authorize through %s",
    async (name) => {
      const fixture = await connectVaultTest([
        Response.json(card),
        new Error(`network failed ${actionURL}`),
      ]);
      try {
        const result = await fixture.call(name, {
          vault: "checkout",
          key: "order-1",
          ...(name === "manage_vault_cards"
            ? { action: "authorize", provider: "kernel" }
            : { action: "invoke", operation: "authorize" }),
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(
          "request failed. no response was received from the api after the operation was submitted.",
        );
        expect(text).not.toContain("re-get the item");
        expect(text).not.toContain(actionURL);
        expect(fixture.requests).toHaveLength(2);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    "authorize",
    "fill",
    "confirm_transaction",
    "restart_verification",
  ])(
    "redacts preflight errors before the provider is known for %s",
    async (operation) => {
      const fixture = await connectVaultTest([
        Response.json(
          { message: actionURL, code: "internal_error" },
          { status: 500 },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          operation,
          vault: "checkout",
          key: "order-1",
          ...(operation === "fill"
            ? {
                inputs: {
                  browser_id: "browser-1",
                  fields: [{ field: "number", selector: "#number" }],
                },
              }
            : {}),
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain("http status: 500");
        expect(text).toContain("api code: internal_error");
        expect(text).not.toContain(actionURL);
        expect(text).not.toContain("authorization outcome is uncertain");
        expect(text).not.toContain("safe to retry the field write");
        expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("generic authorize keeps validation rejection distinct from uncertainty", async () => {
    const fixture = await connectVaultTest([
      Response.json(card),
      Response.json({ message: actionURL, code: "conflict" }, { status: 409 }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        operation: "authorize",
        vault: "checkout",
        key: "order-1",
      });
      const text = JSON.stringify(result);
      expect(text).toContain("http status: 409");
      expect(text).toContain("api code: conflict");
      expect(text).not.toContain("inputs to fix");
      expect(text).not.toContain(actionURL);
      expect(fixture.requests[1].body).toEqual({ type: "authorize" });
    } finally {
      await fixture.close();
    }
  });

  test("does not echo bearer action URLs from API errors", async () => {
    const fixture = await connectVaultTest([
      Response.json(
        { message: `failed: ${actionURL}`, code: "invalid_wallet" },
        { status: 409 },
      ),
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
      expect(JSON.stringify(result)).toContain("http status: 409");
      expect(JSON.stringify(result)).toContain("api code: invalid_wallet");
      expect(JSON.stringify(result)).toContain("failed: [redacted url]");
      expect(JSON.stringify(result)).not.toContain("the request was rejected");
    } finally {
      await fixture.close();
    }
  });
});

describe("kernel wallet payment methods", () => {
  const captureToken = "private-capture-token";
  const connected = {
    ...wallet,
    state: { provider: "kernel", status: "connected" },
    action: undefined,
    available_operations: [
      { type: "add_payment_method", description: "Enroll a card." },
      { type: "remove_payment_method", description: "Remove a card." },
    ],
  };
  const pending = {
    id: "pm_2",
    provider: "kernel",
    type: "card",
    is_default: false,
    status: "pending_enrollment",
    display: {},
    capabilities: {
      single_use_card: { eligible: false, reasons: ["pending_enrollment"] },
    },
    action: {
      name: "card_enrollment",
      url: actionURL,
      capture_token: captureToken,
    },
    expires_at: "2026-10-28T12:30:00Z",
  };

  async function callWallet(
    replies: Response[],
    args: Record<string, unknown>,
  ) {
    const fixture = await connectVaultTest(replies);
    const result = await fixture.call("manage_vault_wallets", {
      vault: "checkout",
      key: "wallet-1",
      ...args,
    });
    return { fixture, result };
  }

  test("discovery advertises payment-method actions and payment_request items", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const wallets = tools.find(({ name }) => name === "manage_vault_wallets");
      const cards = tools.find(({ name }) => name === "manage_vault_cards");
      expect(wallets?.inputSchema.properties?.action).toMatchObject({
        enum: [
          "create",
          "payment_methods",
          "add_payment_method",
          "remove_payment_method",
        ],
      });
      expect(wallets?.inputSchema.properties).toHaveProperty(
        "payment_method_id",
      );
      for (const text of [
        "may be connected with none",
        "intended cardholder",
        "explicit user confirmation",
        "removal is not proof that a payment did not occur",
        "403 insufficient_scope",
      ])
        expect(wallets?.description).toContain(text);
      expect(cards?.inputSchema.properties?.item_type).toMatchObject({
        enum: ["card", "payment_request"],
      });
      expect(cards?.description).toContain(
        "agentcard purchases stay card items",
      );
    } finally {
      await fixture.close();
    }
  });

  test("an empty connected wallet advertises adding a card", async () => {
    const { fixture, result } = await callWallet([Response.json(connected)], {
      action: "create",
      provider: "kernel",
      spec: {},
    });
    try {
      const body = toolResultJSON(result);
      expect(body.item.state.status).toBe("connected");
      expect(body.item).not.toHaveProperty("action");
      expect(body.hints.invocation).toEqual([
        expect.objectContaining({
          arguments: expect.objectContaining({
            operation: "add_payment_method",
          }),
          requires_user_approval: true,
        }),
        expect.objectContaining({
          arguments: expect.objectContaining({
            operation: "remove_payment_method",
          }),
          required_inputs: ["payment_method_id"],
        }),
      ]);
      expect(body.guidance.join(" ")).toContain(
        "a connected KERNEL wallet may hold no cards",
      );
    } finally {
      await fixture.close();
    }
  });

  test("add_payment_method returns the enrollment url without the capture token", async () => {
    const { fixture, result } = await callWallet(
      [
        Response.json(connected),
        Response.json({ type: "add_payment_method", payment_method: pending }),
      ],
      { action: "add_payment_method" },
    );
    try {
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(captureToken);
      const body = toolResultJSON(result);
      expect(body.result).toEqual({
        type: "add_payment_method",
        payment_method: {
          ...pending,
          action: { name: "card_enrollment", url: actionURL },
        },
      });
      expect(body.hints.observation).toEqual([
        {
          tool: "manage_vault_wallets",
          arguments: {
            project: "proj_test",
            vault: "checkout",
            key: "wallet-1",
            action: "payment_methods",
          },
        },
      ]);
      expect(body.guidance).toContain("only to the intended cardholder");
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
      ]);
      expect(fixture.requests[1]).toMatchObject({
        path: "/vaults/checkout/items/wallet-1/operations",
        body: { type: "add_payment_method" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("remove_payment_method forwards the selected id", async () => {
    const removed = {
      type: "remove_payment_method",
      payment_method_id: "pm_2",
      status: "removed",
    };
    const { fixture, result } = await callWallet(
      [Response.json(connected), Response.json(removed)],
      { action: "remove_payment_method", payment_method_id: "pm_2" },
    );
    try {
      const body = toolResultJSON(result);
      expect(body.result).toEqual(removed);
      expect(body.guidance).toContain(
        "removal is not proof that a payment did not occur",
      );
      expect(fixture.requests[1].body).toEqual({
        type: "remove_payment_method",
        payment_method_id: "pm_2",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { action: "remove_payment_method" },
    { action: "add_payment_method", payment_method_id: "pm_2" },
    { action: "payment_methods", payment_method_id: "pm_2" },
  ])("requires payment_method_id only for removal: $action", async (args) => {
    const { fixture, result } = await callWallet([], args);
    try {
      expect(result.isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      name: "unadvertised",
      current: { ...connected, available_operations: [] },
      expected: "vaults:write",
    },
    {
      name: "link wallet",
      current: { ...connected, spec: { provider: "link" } },
      expected: "only for KERNEL wallets",
    },
  ])("does not submit for an $name item", async ({ current, expected }) => {
    const { fixture, result } = await callWallet([Response.json(current)], {
      action: "add_payment_method",
    });
    try {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(expected);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { status: 403, code: "insufficient_scope" },
    { status: 409, code: "purchase_unresolved" },
    { status: 409, code: "provider_revocation_pending" },
  ])("passes $status $code through from removal", async ({ status, code }) => {
    const { fixture, result } = await callWallet(
      [
        Response.json(connected),
        Response.json({ message: "refused", code }, { status }),
      ],
      { action: "remove_payment_method", payment_method_id: "pm_2" },
    );
    try {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        `http status: ${status}. api code: ${code}. refused`,
      );
    } finally {
      await fixture.close();
    }
  });

  test("lists payment-method lifecycle fields without capture tokens", async () => {
    const expanded = {
      ...connected,
      expanded: {
        payment_methods: [
          {
            ...pending,
            id: "pm_1",
            status: "recovery_required",
            status_reason: "enrollment outcome unknown",
            action: undefined,
            expires_at: undefined,
          },
          pending,
        ],
      },
    };
    const { fixture, result } = await callWallet([Response.json(expanded)], {
      action: "payment_methods",
    });
    try {
      expect(JSON.stringify(result)).not.toContain(captureToken);
      const [recovery, enrolling] =
        toolResultJSON(result).item.expanded.payment_methods;
      expect(recovery).toMatchObject({
        status: "recovery_required",
        status_reason: "enrollment outcome unknown",
      });
      expect(enrolling).toMatchObject({
        status: "pending_enrollment",
        expires_at: pending.expires_at,
        action: { name: "card_enrollment", url: actionURL },
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("kernel payment requests", () => {
  const paymentRequest = {
    ...card,
    type: "payment_request",
    spec: { ...card.spec, payment_method_id: "pm_1" },
    state: {
      provider: "kernel",
      status: "requested",
      payment_method_id: "pm_1",
      funding_status: "available",
    },
    action: undefined,
  };

  async function callCards(replies: Response[], args: Record<string, unknown>) {
    const fixture = await connectVaultTest(replies);
    const result = await fixture.call("manage_vault_cards", {
      vault: "checkout",
      key: "order-1",
      ...args,
    });
    return { fixture, result };
  }

  test("a Kernel card forwards an explicitly selected payment method", async () => {
    const spec = { ...card.spec, payment_method_id: "pm_1" };
    const { fixture, result } = await callCard(
      [Response.json({ ...card, spec })],
      "create",
      spec,
    );
    try {
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[0].body).toEqual({
        type: "card",
        spec: { ...spec, provider: "kernel" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("creates a Kernel payment_request with its payment method", async () => {
    const { fixture, result } = await callCards(
      [Response.json(paymentRequest)],
      {
        action: "create",
        provider: "kernel",
        item_type: "payment_request",
        spec: paymentRequest.spec,
      },
    );
    try {
      const body = toolResultJSON(result);
      expect(body.item.type).toBe("payment_request");
      expect(body.item.state).toMatchObject({
        payment_method_id: "pm_1",
        funding_status: "available",
      });
      expect(body.guidance.join(" ")).toContain(
        "funding_status unavailable means",
      );
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        body: { type: "payment_request", spec: paymentRequest.spec },
      });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      name: "a Kernel payment_request without a payment method",
      args: { provider: "kernel", spec: card.spec },
    },
    {
      name: "an AgentCard payment_request",
      args: {
        provider: "agentcard",
        spec: {
          wallet: "wallet-1",
          merchant: "Shop",
          amount: 1,
          currency: "usd",
        },
      },
    },
  ])("rejects $name without sending a request", async ({ args }) => {
    const { fixture, result } = await callCards([], {
      action: "create",
      item_type: "payment_request",
      ...args,
    });
    try {
      expect(result.isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("updates a Link payment_request with its item type", async () => {
    const { fixture, result } = await callCards(
      [Response.json({ ...item, type: "payment_request" })],
      {
        action: "update",
        provider: "link",
        item_type: "payment_request",
        spec: linkSpec,
      },
    );
    try {
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[0]).toMatchObject({
        method: "PATCH",
        body: {
          type: "payment_request",
          spec: { ...linkSpec, provider: "link" },
        },
      });
    } finally {
      await fixture.close();
    }
  });

  test("authorizes an advertised Kernel payment_request", async () => {
    const { fixture, result } = await callCards(
      [Response.json(paymentRequest), Response.json(card)],
      { action: "authorize" },
    );
    try {
      expect(result.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({ type: "authorize" });
    } finally {
      await fixture.close();
    }
  });

  test("checks confirm_transaction against the payment_request purchase", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...paymentRequest,
        state: { ...paymentRequest.state, status: "consumed" },
        available_operations: [
          { type: "confirm_transaction", description: "Report outcome." },
        ],
      }),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "invoke",
        vault: "checkout",
        key: "order-1",
        operation: "confirm_transaction",
        inputs: {
          status: "APPROVED",
          transaction_type: "PURCHASE",
          amount: paymentRequest.spec.amount + 1,
          currency: "USD",
          occurred_at: "2026-10-28T12:00:00Z",
        },
      });
      expect(result.isError).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});
