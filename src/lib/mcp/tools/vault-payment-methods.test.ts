import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";

const target = { vault: "checkout", key: "wallet-1" };
const enrollmentURL =
  "https://vault.kernel.example/card#capability=private-enrollment";

const kernelWallet = {
  ...item,
  key: "wallet-1",
  type: "wallet",
  spec: { provider: "kernel" },
  state: { provider: "kernel", status: "connected" },
  available_operations: [
    {
      type: "add_payment_method",
      description: "Start hosted card enrollment.",
    },
    {
      type: "remove_payment_method",
      description: "Remove one card.",
    },
  ],
  available_expansions: [{ type: "payment_methods", description: "Cards." }],
};

const pendingPaymentMethod = {
  id: "pm_kernel_2",
  provider: "kernel",
  type: "card",
  is_default: false,
  display: { label: "Visa 0000", brand: "visa", last4: "0000" },
  capabilities: {
    single_use_card: { eligible: false, reasons: ["enrollment_pending"] },
  },
  status: "pending_enrollment",
  status_reason: "",
  action: {
    name: "card_enrollment",
    url: enrollmentURL,
    capture_token: "private-capture-token",
  },
  expires_at: "2026-10-01T12:30:00Z",
  provider_private: "hidden",
};

describe("Kernel wallet payment methods", () => {
  test("advertises grouped add/remove actions and explicit card funding selection", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const wallets = tools.find(({ name }) => name === "manage_vault_wallets");
      const cards = tools.find(({ name }) => name === "manage_vault_cards");
      const items = tools.find(({ name }) => name === "manage_vault_items");
      expect(wallets?.inputSchema.properties?.action).toMatchObject({
        enum: [
          "create",
          "payment_methods",
          "add_payment_method",
          "remove_payment_method",
        ],
      });
      expect(wallets?.description).toContain(
        "returns an empty connected wallet",
      );
      expect(wallets?.description).toContain("vaults:write plus vaults:use");
      expect(cards?.description).toContain(
        "payment_method_id may explicitly select a method",
      );
      expect(items?.description).toContain(
        "connected KERNEL wallets may advertise add_payment_method",
      );
      expect(JSON.stringify(wallets?.inputSchema)).not.toContain(
        "capture_token",
      );
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("projects every Kernel payment-method status from the live expansion", async () => {
    const statuses = [
      "pending_enrollment",
      "active",
      "removal_pending",
      "recovery_required",
    ] as const;
    const expanded = {
      ...kernelWallet,
      expanded: {
        payment_methods: statuses.map((status, index) => ({
          ...pendingPaymentMethod,
          id: `pm_${index}`,
          status,
          status_reason: `${status}_reason`,
          ...(status !== "pending_enrollment" && {
            action: undefined,
            expires_at: undefined,
          }),
        })),
      },
    };
    const fixture = await connectVaultTest([Response.json(expanded)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          ...target,
          action: "payment_methods",
        }),
      );
      expect(
        result.item.expanded.payment_methods.map(
          (method: { status: string }) => method.status,
        ),
      ).toEqual(statuses);
      expect(
        result.item.expanded.payment_methods.map(
          (method: { status_reason: string }) => method.status_reason,
        ),
      ).toEqual(statuses.map((status) => `${status}_reason`));
      expect(JSON.stringify(result)).not.toContain("private-capture-token");
      expect(result.guidance.join(" ")).toContain(
        "removal_pending refuses payments",
      );
      expect(result.guidance.join(" ")).toContain(
        "unreadable stored card requires private support",
      );
    } finally {
      await fixture.close();
    }
  });

  test("starts hosted enrollment and preserves false values without exposing capture tokens", async () => {
    const fixture = await connectVaultTest([
      Response.json(kernelWallet),
      Response.json({
        type: "add_payment_method",
        payment_method: pendingPaymentMethod,
      }),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          ...target,
          action: "add_payment_method",
        }),
      );
      expect(result.result).toEqual({
        type: "add_payment_method",
        payment_method: {
          id: "pm_kernel_2",
          provider: "kernel",
          type: "card",
          is_default: false,
          status: "pending_enrollment",
          status_reason: "",
          expires_at: "2026-10-01T12:30:00Z",
          display: { label: "Visa 0000", brand: "visa", last4: "0000" },
          capabilities: {
            single_use_card: {
              eligible: false,
              reasons: ["enrollment_pending"],
            },
          },
          action: { name: "card_enrollment", url: enrollmentURL },
        },
      });
      expect(result.guidance).toContain("single-use card_enrollment");
      expect(JSON.stringify(result)).not.toContain("private-capture-token");
      expect(JSON.stringify(result)).not.toContain("provider_private");
      expect(
        fixture.requests.map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
      ).toEqual([
        {
          method: "GET",
          path: "/vaults/checkout/items/wallet-1",
          body: undefined,
        },
        {
          method: "POST",
          path: "/vaults/checkout/items/wallet-1/operations",
          body: { type: "add_payment_method" },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { type: "add_payment_method", payment_method: { id: "pm_kernel_2" } },
    "unexpected",
  ])(
    "does not report a malformed add response as success",
    async (response) => {
      const fixture = await connectVaultTest([
        Response.json(kernelWallet),
        Response.json(response),
      ]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          ...target,
          action: "add_payment_method",
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(
          "unrecognized payment-method response",
        );
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          "GET",
          "POST",
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("removes exactly one selected payment method", async () => {
    const fixture = await connectVaultTest([
      Response.json(kernelWallet),
      Response.json({
        type: "remove_payment_method",
        payment_method_id: "pm_kernel_2",
        status: "removed",
        opaque: "hidden",
      }),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_wallets", {
          ...target,
          action: "remove_payment_method",
          payment_method_id: "pm_kernel_2",
        }),
      );
      expect(result.result).toEqual({
        type: "remove_payment_method",
        payment_method_id: "pm_kernel_2",
        status: "removed",
      });
      expect(result.guidance).toContain(
        "wallet remains connected even if none remain",
      );
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(fixture.requests[1].body).toEqual({
        type: "remove_payment_method",
        payment_method_id: "pm_kernel_2",
      });
    } finally {
      await fixture.close();
    }
  });

  test("reports a lost removal response after submission without exposing capability URLs", async () => {
    const fixture = await connectVaultTest([
      Response.json(kernelWallet),
      new Error(`network failed ${enrollmentURL}`),
    ]);
    try {
      const result = await fixture.call("manage_vault_wallets", {
        ...target,
        action: "remove_payment_method",
        payment_method_id: "pm_kernel_2",
      });
      const text = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(text).toContain(
        "no response was received from the api after the operation was submitted",
      );
      expect(text).not.toContain(enrollmentURL);
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
      ]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      name: "unadvertised add",
      wallet: { ...kernelWallet, available_operations: [] },
      action: "add_payment_method",
      payment_method_id: undefined,
    },
    {
      name: "unadvertised remove",
      wallet: { ...kernelWallet, available_operations: [] },
      action: "remove_payment_method",
      payment_method_id: "pm_kernel_2",
    },
    {
      name: "non-Kernel wallet",
      wallet: {
        ...kernelWallet,
        spec: { provider: "link" },
        state: { provider: "link", status: "connected" },
      },
      action: "add_payment_method",
      payment_method_id: undefined,
    },
  ])("does not submit $name", async ({ wallet, action, payment_method_id }) => {
    const fixture = await connectVaultTest([Response.json(wallet)]);
    try {
      const result = await fixture.call("manage_vault_wallets", {
        ...target,
        action,
        ...(payment_method_id && { payment_method_id }),
      });
      expect(result.isError).toBe(true);
      expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { action: "remove_payment_method", payment_method_id: undefined },
    { action: "remove_payment_method", payment_method_id: "" },
    { action: "add_payment_method", payment_method_id: "pm_kernel_2" },
  ])(
    "rejects invalid grouped action inputs before reading the wallet: $action",
    async ({ action, payment_method_id }) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_wallets", {
          ...target,
          action,
          ...(payment_method_id !== undefined && { payment_method_id }),
        });
        expect(result.isError).toBe(true);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("supports both payment-method operations through advertised generic invocation", async () => {
    const fixture = await connectVaultTest([
      Response.json(kernelWallet),
      Response.json({
        type: "add_payment_method",
        payment_method: pendingPaymentMethod,
      }),
      Response.json(kernelWallet),
      Response.json({
        type: "remove_payment_method",
        payment_method_id: "pm_kernel_2",
        status: "removed",
      }),
    ]);
    try {
      const added = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "add_payment_method",
        inputs: {},
      });
      const removed = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "remove_payment_method",
        inputs: { payment_method_id: "pm_kernel_2" },
      });
      expect(added.isError).toBeUndefined();
      expect(removed.isError).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({
        type: "add_payment_method",
      });
      expect(fixture.requests[3].body).toEqual({
        type: "remove_payment_method",
        payment_method_id: "pm_kernel_2",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { operation: "add_payment_method", inputs: { unexpected: true } },
    { operation: "remove_payment_method", inputs: {} },
    {
      operation: "remove_payment_method",
      inputs: { payment_method_id: "x".repeat(129) },
    },
    {
      operation: "remove_payment_method",
      inputs: { payment_method_id: "pm_kernel_2", unexpected: false },
    },
  ])(
    "rejects invalid generic $operation inputs before reading the wallet",
    async ({ operation, inputs }) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation,
          inputs,
        });
        expect(result.isError).toBe(true);
        expect(fixture.requests).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain("x".repeat(129));
      } finally {
        await fixture.close();
      }
    },
  );

  test("adds operation-specific invocation hints without treating them as approval", async () => {
    const fixture = await connectVaultTest([Response.json(kernelWallet)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          ...target,
          action: "get",
        }),
      );
      const hints = Object.fromEntries(
        result.hints.invocation.map(
          (hint: {
            arguments: { operation: string };
            required_inputs?: string[];
            requires_user_approval: boolean;
          }) => [hint.arguments.operation, hint],
        ),
      );
      expect(hints.add_payment_method).toMatchObject({
        requires_user_approval: true,
      });
      expect(hints.add_payment_method.required_inputs).toBeUndefined();
      expect(hints.remove_payment_method).toMatchObject({
        required_inputs: ["payment_method_id"],
        requires_user_approval: true,
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("Kernel purchase funding selection", () => {
  const cardSpec = {
    wallet: "wallet-1",
    payment_method_id: "pm_kernel_2",
    amount: 1999,
    currency: "USD",
    merchant_name: "Example Shop",
    merchant_url: "https://shop.example/pay",
    merchant_country: "US",
  };

  test("forwards an optional Kernel card payment_method_id and projects funding state", async () => {
    const response = {
      ...item,
      spec: { ...cardSpec, provider: "kernel" },
      state: {
        provider: "kernel",
        status: "requested",
        payment_method_id: "pm_kernel_2",
        funding_status: "removed",
      },
    };
    const fixture = await connectVaultTest([Response.json(response)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_cards", {
          action: "create",
          provider: "kernel",
          vault: "checkout",
          key: "order-1",
          spec: cardSpec,
        }),
      );
      expect(fixture.requests[0].body).toEqual({
        type: "card",
        spec: { ...cardSpec, provider: "kernel" },
      });
      expect(result.item.spec.payment_method_id).toBe("pm_kernel_2");
      expect(result.item.state).toMatchObject({
        payment_method_id: "pm_kernel_2",
        funding_status: "removed",
      });
    } finally {
      await fixture.close();
    }
  });

  test.each(["", "x".repeat(129)])(
    "rejects invalid Kernel card payment_method_id %p",
    async (payment_method_id) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call("manage_vault_cards", {
          action: "create",
          provider: "kernel",
          vault: "checkout",
          key: "order-1",
          spec: { ...cardSpec, payment_method_id },
        });
        expect(result.isError).toBe(true);
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );
});
