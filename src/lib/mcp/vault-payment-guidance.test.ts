import { describe, expect, test } from "bun:test";
import { toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import { vaultItemResponse } from "@/lib/mcp/vault-responses";
import { connectVaultTest, item } from "@/lib/mcp/tools/vaults.test-fixtures";

const target = { vault: "checkout", key: "order-1" };
const fillOperation = {
  type: "fill",
  description: "Fill selected card fields",
};
const aliases = {
  number: "4111111111111111",
  cvc: "123",
  exp_month: "01",
  exp_year: "2030",
};
const linkCard = {
  ...item,
  state: { provider: "link", status: "ready" },
  available_operations: [fillOperation],
};

describe("provider-specific vault payment guidance", () => {
  test.each([false, true])(
    "Link uses fill even with legacy aliases: %s",
    (legacy) => {
      const result = toolResultJSON(
        vaultItemResponse(
          {
            ...linkCard,
            state: { ...linkCard.state, ...(legacy && { aliases }) },
          },
          target,
        ),
      );
      const guidance = result.guidance.join(" ");
      for (const text of [
        "Link cards are immutable",
        "spec.browser_id and spec.page_url",
        "give the user item.action.url",
        "there is no authorize operation",
        "Link Pay Token on Stripe Checkout pages",
        "otherwise a one-time virtual card",
        "delete this card and create a new one",
        "Fill only when advertised",
        "read its description for the exact inputs",
        "no fields",
        "field/selector bindings, never values",
        "never submits payment or clicks Pay",
        "browser access can expose written values",
        "Failed or unknown fills may leave partial changes",
        "Never automatically retry or fall back to aliases",
        "not that the payment succeeded",
      ])
        expect(guidance).toContain(text);
      expect(guidance).not.toContain(
        "explicitly chosen egress-substitution integrations",
      );
      expect(guidance).not.toContain("prepare_checkout");
      expect(result.hints.invocation[0].arguments.operation).toBe("fill");
      if (!legacy) expect(result.item.state).not.toHaveProperty("aliases");
    },
  );

  test("pending Link approval is a user action, not an invocation hint", () => {
    const approvalURL = "https://link.example/approve";
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...item,
          state: { provider: "link", status: "pending_authorization" },
          action: { name: "spend_approval", url: approvalURL },
          available_operations: [],
        },
        target,
      ),
    );
    expect(result.item.action).toEqual({
      name: "spend_approval",
      url: approvalURL,
    });
    expect(result.guidance.join(" ")).toContain("Fill only when advertised");
    expect(result.hints.invocation).toEqual([]);
  });

  test("AgentCard retains aliases, masks, and checkout approval/replay guidance", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...item,
          spec: { provider: "agentcard", wallet: "wallet-1" },
          state: {
            provider: "agentcard",
            status: "ready",
            aliases,
            masks: { brand: "visa", last4: "4242" },
          },
          available_operations: [
            { type: "prepare_checkout", description: "Prepare checkout" },
          ],
        },
        target,
      ),
    );
    expect(result.item.state.aliases).toEqual(aliases);
    expect(result.item.state.masks).toEqual({ brand: "visa", last4: "4242" });
    const guidance = result.guidance.join(" ");
    expect(guidance).toContain("AgentCard aliases remain supported");
    expect(guidance).toContain(
      "Checkout hold, approval, and replay remain supported",
    );
    expect(guidance).toContain("For checkout preparation");
    expect(guidance).toContain("Preparations are single-use");
    expect(guidance).toContain("Never fall back to aliases");
    expect(guidance).not.toContain("nested fill object");
    expect(guidance).not.toContain("Link cards");
    expect(result.hints.invocation[0].arguments.operation).toBe(
      "prepare_checkout",
    );
  });

  test.each(["link", "agentcard"])(
    "%s wallets are not presented as fillable cards",
    (provider) => {
      const result = toolResultJSON(
        vaultItemResponse(
          {
            ...item,
            type: "wallet",
            spec: { provider },
            state: { provider, status: "connected" },
            available_operations: [],
          },
          target,
        ),
      );
      const guidance = result.guidance.join(" ");
      expect(guidance).toContain(
        "Wallets connect a payment provider; they are not fillable cards",
      );
      expect(guidance).toContain("manage_vault_cards");
      expect(guidance).toContain(
        "for Link, only after the vault-attached browser reaches final checkout",
      );
      expect(guidance).not.toContain("nested fill object");
      expect(guidance).not.toContain("state.aliases");
      expect(guidance).not.toContain("prepare_checkout");
    },
  );

  test("credential fill guidance is unchanged and does not inherit provider guidance", () => {
    const result = toolResultJSON(
      vaultItemResponse({ type: "credential" }, target),
    );
    expect(result.guidance).toHaveLength(5);
    expect(result.guidance[4]).toBe(
      "Invocation hints are not approval to execute. Invoke the advertised browser field-writing operation with manage_vault_items using an inputs object containing browser_id and ordered fields of field/selector bindings, never values. Bind the vault at browser creation, authorize the destination, and follow the advertised description. Fill does not submit or navigate; real values enter the browser and may be read by an agent with browser access. Never retry an uncertain fill or fall back to aliases.",
    );
    expect(result.guidance.join(" ")).not.toContain("Link cards");
    expect(result.guidance.join(" ")).not.toContain("AgentCard aliases");
  });

  test("discovery distinguishes Link fill from AgentCard aliases", async () => {
    const fixture = await connectVaultTest([], undefined, true);
    try {
      const { tools } = await fixture.client.listTools();
      const items = tools.find(({ name }) => name === "manage_vault_items");
      expect(items?.description).toContain(
        "Link cards use the advertised fill operation, not aliases or egress substitution",
      );
      expect(items?.description).toContain(
        "a Link Pay Token fill needs no fields",
      );
      expect(items?.description).toContain("there is no authorize operation");
      expect(items?.description).toContain(
        "Fill never submits payment or clicks buttons",
      );
      expect(items?.description).toContain(
        "AgentCard aliases and checkout hold/approval/replay remain supported",
      );
      const browsers = tools.find(({ name }) => name === "manage_browsers");
      expect(JSON.stringify(browsers?.inputSchema)).toContain(
        "Link cards are created against a live browser at final checkout and use fill, not aliases or egress substitution",
      );
      expect(JSON.stringify(browsers?.inputSchema)).toContain(
        "AgentCard aliases remain",
      );
    } finally {
      await fixture.close();
    }
  });

  test("Link checkout accepts nested bindings, expiration format, and timeout without returning values", async () => {
    const fill = {
      browser_id: "browser-session-id",
      page_url: "https://shop.example/checkout?order=1#payment",
      fields: [
        { field: "number", selector: "#card-number" },
        { field: "expiration", selector: "#expiry", format: "MM/YY" },
        { field: "cvc", selector: "#security-code" },
      ],
      timeout_ms: 10000,
    };
    const outcome = {
      type: "fill",
      status: "completed",
      fields: fill.fields.map((_, index) => ({ index, status: "filled" })),
    };
    const fixture = await connectVaultTest([
      Response.json(linkCard),
      Response.json(outcome),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "fill",
        inputs: fill,
      });
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).result).toEqual(outcome);
      expect(
        fixture.requests.map(({ method, body }) => ({ method, body })),
      ).toEqual([
        { method: "GET", body: undefined },
        { method: "POST", body: { type: "fill", ...fill } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("Link Pay Token fill sends only browser_id and page_url", async () => {
    const fill = {
      browser_id: "browser-session-id",
      page_url: "https://shop.example/checkout",
    };
    const outcome = { type: "fill", status: "completed", fields: [] };
    const fixture = await connectVaultTest([
      Response.json(item),
      Response.json(outcome),
    ]);
    try {
      const result = await fixture.call("manage_vault_items", {
        ...target,
        action: "invoke",
        operation: "fill",
        inputs: fill,
      });
      expect(result.isError).toBeUndefined();
      expect(toolResultJSON(result).result).toEqual(outcome);
      expect(fixture.requests[1]).toMatchObject({
        method: "POST",
        body: { type: "fill", ...fill },
      });
      expect(fixture.requests[1].body).not.toHaveProperty("fields");
    } finally {
      await fixture.close();
    }
  });
});
