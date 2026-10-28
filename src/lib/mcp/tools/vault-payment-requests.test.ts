import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  connectVaultTest,
  item,
  linkSpec,
} from "@/lib/mcp/tools/vaults.test-fixtures";

const target = { vault: "checkout", key: "order-1" };

const linkPaymentRequestSpec = {
  ...linkSpec,
  line_items: [
    {
      name: "Included sample",
      quantity: 1,
      unit_amount: 0,
      totals: [{ type: "subtotal", display_text: "Subtotal", amount: 0 }],
    },
  ],
  totals: [{ type: "total", display_text: "Total", amount: 0 }],
  metadata: { order: "001" },
  recurring: { interval: "month" as const, interval_count: 1 },
};

const kernelPaymentRequestSpec = {
  wallet: "wallet-1",
  payment_method_id: "pm_kernel_1",
  amount: 2599,
  currency: "USD",
  merchant_name: "Example Shop",
  merchant_url: "https://shop.example/checkout",
  merchant_country: "US",
  merchant_category: "office supplies",
  merchant_category_code: "5943",
};

function paymentRequest(
  provider: "link" | "kernel",
  spec: Record<string, unknown>,
) {
  return {
    ...item,
    type: "payment_request",
    spec: { ...spec, provider },
    state:
      provider === "kernel"
        ? {
            provider,
            status: "requested",
            payment_method_id: "pm_kernel_1",
            funding_status: "available",
            private_card_data: "hidden",
          }
        : { provider, status: "requested" },
    available_operations: [
      { type: "authorize", description: "Use after explicit user approval." },
    ],
    available_expansions: [],
  };
}

describe("vault payment requests", () => {
  test("advertises provider-specific payment-request contracts without card data", async () => {
    const fixture = await connectVaultTest([]);
    try {
      const { tools } = await fixture.client.listTools();
      const tool = tools.find(
        ({ name }) => name === "manage_vault_payment_requests",
      );
      expect(tool?.inputSchema.properties?.action).toMatchObject({
        enum: ["create", "update"],
      });
      expect(tool?.inputSchema.properties?.provider).toMatchObject({
        enum: ["link", "kernel"],
      });
      const contract = JSON.stringify(tool);
      expect(contract).toContain("payment_method_id");
      expect(contract).toContain('"maximum":50000');
      expect(contract).toContain('"maximum":1000000');
      expect(contract).toContain("payment_request item");
      expect(contract).toContain("agentcard reusable cards remain card items");
      expect(contract).not.toContain("card_number");
      expect(contract).not.toContain("capture_token");
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("creates and updates a Link payment request while preserving nested zero values", async () => {
    const created = paymentRequest("link", linkPaymentRequestSpec);
    const updated = {
      ...created,
      spec: { ...created.spec, context: `${linkSpec.context} Updated.` },
    };
    const fixture = await connectVaultTest([
      Response.json(created),
      Response.json(updated),
    ]);
    try {
      const createResult = toolResultJSON(
        await fixture.call("manage_vault_payment_requests", {
          ...target,
          action: "create",
          provider: "link",
          spec: linkPaymentRequestSpec,
        }),
      );
      expect(createResult.item.type).toBe("payment_request");
      expect(createResult.item.spec.line_items[0].unit_amount).toBe(0);
      expect(createResult.item.spec.line_items[0].totals[0].amount).toBe(0);
      expect(createResult.item.spec.totals[0].amount).toBe(0);
      expect(createResult.guidance.join(" ")).toContain(
        "manage_vault_payment_requests",
      );

      const updatedSpec = {
        ...linkPaymentRequestSpec,
        context: `${linkSpec.context} Updated.`,
      };
      const updateResult = toolResultJSON(
        await fixture.call("manage_vault_payment_requests", {
          ...target,
          action: "update",
          provider: "link",
          spec: updatedSpec,
        }),
      );
      expect(updateResult.item.spec.context).toBe(updatedSpec.context);
      expect(
        fixture.requests.map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
      ).toEqual([
        {
          method: "PUT",
          path: "/vaults/checkout/items/order-1",
          body: {
            type: "payment_request",
            spec: { ...linkPaymentRequestSpec, provider: "link" },
          },
        },
        {
          method: "PATCH",
          path: "/vaults/checkout/items/order-1",
          body: {
            type: "payment_request",
            spec: { ...updatedSpec, provider: "link" },
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("forwards every Kernel purchase field and projects bound funding state", async () => {
    const response = paymentRequest("kernel", kernelPaymentRequestSpec);
    const fixture = await connectVaultTest([Response.json(response)]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_payment_requests", {
          ...target,
          action: "create",
          provider: "kernel",
          spec: kernelPaymentRequestSpec,
        }),
      );
      expect(fixture.requests[0]).toMatchObject({
        method: "PUT",
        path: "/vaults/checkout/items/order-1",
        body: {
          type: "payment_request",
          spec: { ...kernelPaymentRequestSpec, provider: "kernel" },
        },
      });
      expect(result.item.spec).toEqual({
        ...kernelPaymentRequestSpec,
        provider: "kernel",
      });
      expect(result.item.state).toMatchObject({
        provider: "kernel",
        status: "requested",
        payment_method_id: "pm_kernel_1",
        funding_status: "available",
      });
      expect(JSON.stringify(result)).not.toContain("private_card_data");
      expect(result.guidance.join(" ")).toContain(
        "bound to spec.payment_method_id",
      );
    } finally {
      await fixture.close();
    }
  });

  test.each(["available", "unavailable", "removed"] as const)(
    "projects Kernel funding_status %s",
    async (funding_status) => {
      const response = {
        ...paymentRequest("kernel", kernelPaymentRequestSpec),
        state: {
          provider: "kernel",
          status: "requested",
          payment_method_id: "pm_kernel_1",
          funding_status,
        },
      };
      const fixture = await connectVaultTest([Response.json(response)]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            ...target,
            action: "get",
          }),
        );
        expect(result.item.state.funding_status).toBe(funding_status);
        expect(result.item.state.payment_method_id).toBe("pm_kernel_1");
      } finally {
        await fixture.close();
      }
    },
  );

  test("authorizes a requested Link payment_request with checkout context", async () => {
    const requested = paymentRequest("link", linkPaymentRequestSpec);
    const pending = {
      ...requested,
      state: { provider: "link", status: "pending_authorization" },
      action: {
        name: "spend_approval",
        url: "https://link.example/approve",
      },
    };
    const fixture = await connectVaultTest([
      Response.json(requested),
      Response.json(pending),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          ...target,
          action: "invoke",
          operation: "authorize",
          inputs: {
            browser_id: "browser-1",
            page_url: "https://shop.example/checkout",
          },
        }),
      );
      expect(result.item.type).toBe("payment_request");
      expect(result.item.action).toEqual(pending.action);
      expect(fixture.requests[1].body).toEqual({
        type: "authorize",
        browser_id: "browser-1",
        page_url: "https://shop.example/checkout",
      });
    } finally {
      await fixture.close();
    }
  });

  test("reports a zero-amount observed transaction for a Kernel payment_request", async () => {
    const ready = {
      ...paymentRequest("kernel", kernelPaymentRequestSpec),
      state: {
        provider: "kernel",
        status: "ready",
        payment_method_id: "pm_kernel_1",
        funding_status: "available",
      },
      available_operations: [
        {
          type: "confirm_transaction",
          description: "Report the observed merchant outcome.",
        },
      ],
    };
    const reported = { ...ready, available_operations: [] };
    const inputs = {
      status: "CANCELLED",
      transaction_type: "PURCHASE",
      amount: 0,
      currency: "USD",
      occurred_at: "2026-10-01T12:00:00Z",
    };
    const fixture = await connectVaultTest([
      Response.json(ready),
      Response.json(reported),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "confirm_transaction",
        inputs,
      });
      expect(result.isError).toBeUndefined();
      const guidance = toolResultJSON(result).guidance.join(" ");
      expect(guidance).toContain("even after payment_request expiry");
      expect(guidance).toContain("create one new payment_request");
      expect(fixture.requests[1].body).toEqual({
        type: "confirm_transaction",
        ...inputs,
      });
    } finally {
      await fixture.close();
    }
  });

  test("blocks non-restart operations for a recovering Kernel payment_request", async () => {
    const recovering = {
      ...paymentRequest("kernel", kernelPaymentRequestSpec),
      state: {
        provider: "kernel",
        status: "recovery_required",
        status_reason: "attestation_failed",
      },
      available_operations: [
        { type: "authorize", description: "Stale operation." },
        {
          type: "restart_verification",
          description: "Start a fresh verification session.",
        },
      ],
    };
    const fixture = await connectVaultTest([Response.json(recovering)]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "authorize",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("recovery_required");
      expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    {
      name: "missing payment method",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, payment_method_id: undefined },
    },
    {
      name: "empty payment method",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, payment_method_id: "" },
    },
    {
      name: "zero amount",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, amount: 0 },
    },
    {
      name: "amount above the Kernel cap",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, amount: 1_000_001 },
    },
    {
      name: "non-HTTPS Kernel merchant",
      provider: "kernel",
      spec: {
        ...kernelPaymentRequestSpec,
        merchant_url: "http://shop.example/checkout",
      },
    },
    {
      name: "invalid merchant country",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, merchant_country: "USA" },
    },
    {
      name: "invented MCC",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, merchant_category_code: "0000" },
    },
    {
      name: "card data",
      provider: "kernel",
      spec: { ...kernelPaymentRequestSpec, cvc: "123" },
    },
    {
      name: "Link amount above its cap",
      provider: "link",
      spec: { ...linkPaymentRequestSpec, amount: 50_001 },
    },
    {
      name: "Link context below its minimum",
      provider: "link",
      spec: { ...linkPaymentRequestSpec, context: "too short" },
    },
    {
      name: "unsupported provider",
      provider: "agentcard",
      spec: kernelPaymentRequestSpec,
    },
  ])("rejects $name without sending a request", async ({ provider, spec }) => {
    const fixture = await connectVaultTest([]);
    try {
      const result = await fixture.call("manage_vault_payment_requests", {
        ...target,
        action: "create",
        provider,
        spec,
      });
      expect(result.isError).toBe(true);
      expect(fixture.requests).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain("123");
    } finally {
      await fixture.close();
    }
  });
});
