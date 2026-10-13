import { describe, expect, test } from "bun:test";
import { APIError } from "@onkernel/sdk";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";
import { throwKernelVaultError } from "@/lib/mcp/vault-responses";

const card = {
  ...item,
  spec: {
    provider: "kernel",
    wallet: "wallet-1",
    amount: 100,
    currency: "usd",
    merchant_name: "Shop",
    merchant_url: "https://shop.example/pay",
    merchant_country: "US",
  },
  state: { provider: "kernel", status: "ready" },
};
const report = {
  status: "APPROVED",
  transaction_type: "PURCHASE",
  amount: 100,
  currency: "USD",
  occurred_at: "2026-09-01T12:00:00Z",
};

function failure(status: number) {
  return Response.json(
    {
      code: "conflict",
      message:
        "reconcile before retrying https://vault.example/approval#secret HTTPS://vault.example/enroll?secret=x",
    },
    { status },
  );
}

describe("kernel payment recovery", () => {
  test.each([
    {
      fields: [
        { field: "exp_month", selector: "#month" },
        { field: "exp_year", selector: "#year" },
      ],
    },
    {
      fields: [{ field: "expiration", selector: "#expiry", format: "MM/YYYY" }],
    },
  ])("fills supported expiration bindings %j", async ({ fields }) => {
    const fixture = await connectVaultTest([
      Response.json({ ...card, available_operations: [{ type: "fill" }] }),
      Response.json({ type: "fill", status: "completed" }),
    ]);
    try {
      const inputs = {
        browser_id: "browser-1",
        page_url: card.spec.merchant_url,
        fields,
      };
      expect(
        (
          await fixture.call("manage_vault_items", {
            action: "invoke",
            operation: "fill",
            vault: "checkout",
            key: "order-1",
            inputs,
          })
        ).isError,
      ).toBeUndefined();
      expect(fixture.requests[1].body).toEqual({ type: "fill", ...inputs });
    } finally {
      await fixture.close();
    }
  });

  test("recovery projection suppresses unsupported operations and stale URLs, not reconciliation metadata", async () => {
    const fixture = await connectVaultTest([
      Response.json({
        ...card,
        state: {
          provider: "kernel",
          status: "recovery_required",
          authorization: {
            id: "auth-1",
            reason: "outcome unknown",
            approval_url: "https://vault.example/stale",
          },
        },
        action: { name: "spend_approval", url: "https://vault.example/stale" },
        available_operations: [
          { type: "authorize" },
          { type: "restart_verification" },
        ],
      }),
    ]);
    try {
      const result = toolResultJSON(
        await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "order-1",
        }),
      );
      expect(result.item.available_operations).toEqual([
        { type: "restart_verification" },
      ]);
      expect(result.item.state.authorization).toEqual({
        id: "auth-1",
        reason: "outcome unknown",
      });
      expect(JSON.stringify(result)).not.toContain(
        "https://vault.example/stale",
      );
    } finally {
      await fixture.close();
    }
  });
  test.each([
    {
      tool: "manage_vault_cards",
      spec: {
        wallet: "wallet-1",
        payment_method_id: "pm_1",
        amount: 100,
        currency: "usd",
        merchant_name: "Shop",
        merchant_url: "https://shop.example",
        context: "x".repeat(100),
      },
      key: "payment_method_id",
    },
    {
      tool: "manage_vault_wallets",
      spec: { user_id: "usr_123" },
      key: "user_id",
    },
  ])(
    "locally rejects mismatched $tool specs without uncertain-request guidance",
    async ({ tool, spec, key }) => {
      const fixture = await connectVaultTest([]);
      try {
        const result = await fixture.call(tool, {
          action: "create",
          provider: "kernel",
          vault: "checkout",
          key: "item-1",
          spec,
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(key);
        expect(text).toContain("no request was sent");
        expect(text).not.toContain("uncertain");
        expect(fixture.requests).toHaveLength(0);
      } finally {
        await fixture.close();
      }
    },
  );

  test("authorize infers the provider from a freshly fetched item", async () => {
    const fixture = await connectVaultTest([
      Response.json(card),
      Response.json(card),
    ]);
    try {
      expect(
        (
          await fixture.call("manage_vault_cards", {
            action: "authorize",
            vault: "checkout",
            key: "order-1",
          })
        ).isError,
      ).toBeUndefined();
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
      ]);
      expect(fixture.requests[1].body).toEqual({ type: "authorize" });
    } finally {
      await fixture.close();
    }
  });

  test.each(["manage_vault_cards", "manage_vault_wallets"])(
    "create recovery uses the same key and identical spec for %s",
    async (tool) => {
      const spec = tool === "manage_vault_cards" ? card.spec : {};
      const fixture = await connectVaultTest([
        failure(500),
        Response.json(card),
      ]);
      try {
        const args = {
          action: "create",
          provider: "kernel",
          vault: "checkout",
          key: "item-1",
          spec,
        };
        const failed = await fixture.call(tool, args);
        expect(JSON.stringify(failed)).toContain(
          "identical key and identical spec",
        );
        expect(fixture.requests).toHaveLength(1);
        await fixture.call(tool, args);
        expect(fixture.requests[0].path).toEqual(fixture.requests[1].path);
        expect(fixture.requests[0].body).toEqual(fixture.requests[1].body);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["authorize", "confirm_transaction", "restart_verification"])(
    "%s retries re-fetch availability and stop after it disappears",
    async (operation) => {
      const advertised = {
        ...card,
        state: {
          ...card.state,
          status:
            operation === "restart_verification"
              ? "recovery_required"
              : "ready",
        },
        available_operations: [{ type: operation }],
      };
      const fixture = await connectVaultTest([
        Response.json(advertised),
        failure(500),
        Response.json(advertised),
        Response.json({ ...card, available_operations: [] }),
        Response.json({ ...card, available_operations: [] }),
      ]);
      try {
        const args = {
          action: "invoke",
          vault: "checkout",
          key: "order-1",
          operation,
          ...(operation === "confirm_transaction" && { inputs: report }),
        };
        const failed = await fixture.call("manage_vault_items", args);
        const text = JSON.stringify(failed);
        expect(text).toContain(
          `invoke ${operation} once more only if freshly advertised`,
        );
        expect(text).toContain("reconcile before retrying");
        expect(text).not.toContain("https://vault.example");
        expect(text).not.toContain("HTTPS://vault.example");
        expect(fixture.requests).toHaveLength(2);
        await fixture.call("manage_vault_items", args);
        expect((await fixture.call("manage_vault_items", args)).isError).toBe(
          true,
        );
        expect(fixture.requests.map(({ method }) => method)).toEqual([
          "GET",
          "POST",
          "GET",
          "POST",
          "GET",
        ]);
        expect(fixture.requests[1].body).toEqual(fixture.requests[3].body);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["30", "Wed, 14 Oct 2026 12:00:00 GMT"])(
    "429 preserves Retry-After %s and gates the next invocation",
    (after) => {
      expect(() =>
        throwKernelVaultError(
          "manage_vault_items",
          "invoke",
          new APIError(
            429,
            { code: "rate_limited", message: "provider limit" },
            undefined,
            new Headers({ "Retry-After": after }),
          ),
          "authorize",
        ),
      ).toThrow(`Retry-After (${after})`);
      expect(() =>
        throwKernelVaultError(
          "manage_vault_items",
          "invoke",
          new APIError(
            429,
            { message: "provider limit" },
            undefined,
            new Headers(),
          ),
          "authorize",
        ),
      ).toThrow("only if freshly advertised");
    },
  );

  test.each([400, 403, 404, 409, 500])(
    "fill rejection/uncertainty differs for HTTP %s",
    (status) => {
      expect(() =>
        throwKernelVaultError(
          "manage_vault_items",
          "invoke",
          new APIError(
            status,
            { message: "fix selector" },
            undefined,
            new Headers(),
          ),
          "fill",
        ),
      ).toThrow(
        status < 500
          ? "no fields were written"
          : "may have written some fields",
      );
    },
  );

  test.each([{ currency: "EUR" }, { amount: 101 }])(
    "confirmation must match approved purchase: %j",
    async (invalid) => {
      const fixture = await connectVaultTest([
        Response.json({
          ...card,
          available_operations: [{ type: "confirm_transaction" }],
        }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "invoke",
          operation: "confirm_transaction",
          vault: "checkout",
          key: "order-1",
          inputs: { ...report, ...invalid },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("operation was not invoked");
        expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("optional actual merchant category fields pass through", async () => {
    const fixture = await connectVaultTest([Response.json(card)]);
    try {
      const spec = {
        ...card.spec,
        merchant_category: "Books",
        merchant_category_code: "5942",
      };
      expect(
        (
          await fixture.call("manage_vault_cards", {
            action: "create",
            provider: "kernel",
            vault: "checkout",
            key: "order-1",
            spec,
          })
        ).isError,
      ).toBeUndefined();
      expect(fixture.requests[0].body).toMatchObject({ spec });
      expect(
        (
          await fixture.call("manage_vault_cards", {
            action: "create",
            provider: "kernel",
            vault: "checkout",
            key: "order-2",
            spec: { ...spec, merchant_category_code: "0000" },
          })
        ).isError,
      ).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    "degraded",
    "reconnect_required",
    "declined",
    "expired",
    "recovery_required",
  ])(
    "state %s has a bounded recovery path and safe support context",
    async (status) => {
      const fixture = await connectVaultTest([
        Response.json({
          ...card,
          type:
            status === "degraded" || status === "reconnect_required"
              ? "wallet"
              : "card",
          state: { provider: "kernel", status },
          available_operations: [],
        }),
      ]);
      try {
        const result = toolResultJSON(
          await fixture.call("manage_vault_items", {
            action: "get",
            vault: "checkout",
            key: "order-1",
          }),
        );
        const text = result.guidance.join(" ");
        for (const expected of [
          "reconnect_required",
          "degraded",
          "at most once",
          "network_token_unsupported",
          "network_token_failed",
        ])
          expect(text).toContain(expected);
        if (result.item.type === "card")
          for (const expected of [
            "PENDING means",
            "ERROR means",
            "even after card expiry",
            "merchant decline",
            "if never submitted",
          ])
            expect(text).toContain(expected);
        if (status === "recovery_required") {
          expect(text).toContain("support@kernel.sh");
          expect(text).toContain("project, vault, item key");
          expect(text).toContain("do not assume a new card is safe");
        }
      } finally {
        await fixture.close();
      }
    },
  );
});
