import { describe, expect, test } from "bun:test";
import {
  isDisplaySafeVaultURL,
  projectVaultOutput,
  vaultItemFields,
} from "@/lib/mcp/vault-responses";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";

const aliases = {
  number: "4111111111111111",
  cvc: "123",
  exp_month: "01",
  exp_year: "2030",
};
const unsafeItem = {
  ...item,
  secret: "hidden-top-level",
  spec: {
    ...item.spec,
    metadata: { order: "hidden-metadata" },
    authorization: {
      method: "oauth",
      client: { type: "kernel_managed", client_secret: "hidden-client" },
      access_token: "hidden-token",
    },
  },
  action: {
    name: "spend_approval",
    url: "https://provider.example/approval",
    ciphertext: "hidden-action",
  },
  state: {
    provider: "agentcard",
    status: "ready",
    aliases: { ...aliases, secret: "hidden-alias" },
    masks: { brand: "visa", last4: "4242", pan: "hidden-pan" },
    authorization: {
      id: "auth_1",
      status: "approved",
      charged_kind: "captured",
      charged_amount_cents: 1234,
      charged_currency: "usd",
      amount_verified: false,
      replay_delivered: false,
      approval_url:
        "https://provider.example/approve?access_token=hidden-approval",
      raw: { secret: "hidden-provider" },
    },
  },
  expanded: {
    payment_methods: [
      {
        id: "pm_1",
        is_default: false,
        display: { brand: "visa", last4: "4242", number: "hidden-number" },
        capabilities: { single_use_card: { eligible: false, reasons: [] } },
        raw: "hidden-method",
      },
    ],
  },
};

describe("vault public responses", () => {
  test("projects nested public fields while preserving aliases, false, empty arrays, and absence", () => {
    const projected = projectVaultOutput(unsafeItem, vaultItemFields);
    expect(JSON.stringify(projected)).not.toContain("hidden");
    expect(projected).toMatchObject({
      state: {
        aliases,
        authorization: {
          amount_verified: false,
          replay_delivered: false,
          charged_kind: "captured",
          charged_amount_cents: 1234,
        },
      },
      action: {
        name: "spend_approval",
        url: "https://provider.example/approval",
      },
      expanded: {
        payment_methods: [
          {
            id: "pm_1",
            is_default: false,
            capabilities: { single_use_card: { eligible: false, reasons: [] } },
          },
        ],
      },
    });
    expect(projected).not.toHaveProperty("expires_at");
    expect(projected).not.toHaveProperty("state.authorization.approval_url");
  });

  test("does not pass opaque objects through scalar leaves", () => {
    const projected = projectVaultOutput(
      {
        state: {
          status_reason: { secret: "hidden" },
          domains: [{ secret: "hidden" }],
        },
        action: null,
      },
      vaultItemFields,
    );
    expect(projected).toEqual({
      state: { status_reason: null, domains: [null] },
      action: null,
    });
  });

  test.each([
    "https://provider.example/?code=hidden",
    "https://provider.example/?ACCESS_TOKEN=hidden",
    "https://provider.example/#refresh_token=hidden",
    "https://provider.example/?%63lient_secret=hidden",
    "https://provider.example/#id_token=hidden",
    "https://user:hidden@provider.example/",
    "javascript:alert(1)",
    "not-a-url",
  ])("omits unsafe URLs: %s", (url) => {
    expect(isDisplaySafeVaultURL(url)).toBe(false);
    expect(
      projectVaultOutput(
        { action: { name: "spend_approval", url } },
        vaultItemFields,
      ),
    ).toEqual({ action: { name: "spend_approval" } });
  });

  test("keeps full safe action URLs and operation descriptions", () => {
    const url = "https://provider.example/approve?request=" + "x".repeat(300);
    expect(
      projectVaultOutput(
        { ...item, action: { name: "spend_approval", url } },
        vaultItemFields,
      ),
    ).toMatchObject({
      action: { url },
      available_operations: item.available_operations,
    });
  });

  test("applies the same projection to get, list, and audit events", async () => {
    const event = {
      id: "evt_1",
      name: "checkout.outcome",
      browser_id: "brr_1",
      data: {
        outcome_reason: "indeterminate",
        charged_amount_cents: 0,
        replay_delivered: false,
        raw: { secret: "hidden-event" },
        credential: "hidden-credential",
      },
      raw: "hidden",
    };
    const fixture = await connectVaultTest([
      Response.json(unsafeItem),
      Response.json([unsafeItem]),
      Response.json([event]),
    ]);
    try {
      const get = await fixture.call("manage_vault_items", {
        action: "get",
        vault: "checkout",
        key: "order-1",
      });
      const list = await fixture.call("manage_vault_items", {
        action: "list",
        vault: "checkout",
      });
      const events = await fixture.call("manage_vault_items", {
        action: "events",
        vault: "checkout",
        key: "order-1",
      });
      for (const result of [get, list, events]) {
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("hidden");
      }
      expect(toolResultJSON(get).item).toEqual(toolResultJSON(list).items[0]);
      expect(toolResultJSON(events).events).toEqual([
        {
          id: "evt_1",
          name: "checkout.outcome",
          browser_id: "brr_1",
          data: {
            outcome_reason: "indeterminate",
            charged_amount_cents: 0,
            replay_delivered: false,
          },
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("does not return opaque provider data through the event cursor", async () => {
    const fixture = await connectVaultTest([
      Response.json([
        { id: { secret: "hidden-cursor" }, name: "checkout.outcome" },
      ]),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        action: "events",
        vault: "checkout",
        key: "order-1",
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test.each([
    [400, "invalid_request", "Invalid vault request."],
    [404, "not_found", "Vault, item, or project not found or unavailable."],
    [409, "conflict", "conflicts with the current configuration or state"],
    [500, "project_error", "Unable to resolve the vault's project."],
    [500, "db_error", "The vault storage request could not be completed."],
    [
      500,
      "provider_error",
      "The payment provider could not complete the vault request.",
    ],
    [500, "provider_rate_limited", "rate limited requests"],
    [429, "spend_request_rate_limited", "rate limited spend requests"],
  ] as const)(
    "returns curated text for HTTP %s / %s",
    async (status, code, message) => {
      const fixture = await connectVaultTest([
        Response.json(
          {
            code,
            message: "access_token=hidden-free-text",
            details: "hidden-details",
          },
          { status },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "order-1",
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain(`${status} `);
        expect(text).toContain(message);
        expect(text).toContain(`[code: ${code}]`);
        expect(text).toContain("Do not replay a payment.");
        expect(text).not.toContain("hidden");
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(
    [
      undefined,
      null,
      123,
      {},
      [],
      "",
      "unknown_error",
      "__proto__",
      "constructor",
      "invalid_request hidden-suffix",
    ].map((code) => ({ code })),
  )(
    "uses a generic fallback for unrecognized error codes",
    async ({ code }) => {
      const fixture = await connectVaultTest([
        Response.json(
          { code, message: "password=hidden-password" },
          { status: 400 },
        ),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "order-1",
        });
        const text = JSON.stringify(result);
        expect(result.isError).toBe(true);
        expect(text).toContain("400 Vault request failed.");
        expect(text).not.toContain("[code:");
        expect(text).not.toContain("hidden");
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([
    {
      message: "Expansion unavailable",
      code: "expansion_unavailable",
      opaque: "hidden-opaque",
      headers: { authorization: "hidden-auth" },
    },
    { raw_provider: { secret: "hidden-without-message" } },
    {
      code: "invalid_request",
      message: "access_token=hidden-plaintext-secret",
    },
    { code: "access_token=hidden-code-secret", message: "Invalid request" },
    { code: "conflict", message: "password=hidden-password-secret" },
    {
      message: "Follow https://provider.example/?code=hidden-code",
      code: "action_required",
    },
    { message: { secret: "hidden-object-message" }, code: "provider_error" },
  ])(
    "does not dump provider bodies or credential-bearing URLs in errors",
    async (body) => {
      const fixture = await connectVaultTest([
        Response.json(body, { status: 409 }),
      ]);
      try {
        const result = await fixture.call("manage_vault_items", {
          action: "get",
          vault: "checkout",
          key: "order-1",
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("hidden");
        if (
          ["provider_error", "invalid_request", "conflict"].includes(
            body.code ?? "",
          )
        ) {
          expect(JSON.stringify(result)).toContain(`[code: ${body.code}]`);
        } else {
          expect(JSON.stringify(result)).not.toContain("[code:");
        }
        if (body.message === "Expansion unavailable")
          expect(JSON.stringify(result)).not.toContain(body.message);
      } finally {
        await fixture.close();
      }
    },
  );
});
