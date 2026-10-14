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
  spec: { ...item.spec, merchant_url: "https://shop.example" },
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
        "fill follows its advertised description",
        "for a link pay token, pass {browser_id, page_url} and omit fields",
        "for a virtual card, also pass ordered field/selector bindings, never values",
        "format mm/yy or mm/yyyy",
        "KERNEL supplies the token through the checkout's webmcp tool, so do not inspect or invoke it yourself",
        "never submits payment: submit the checkout yourself",
        "failed or unknown fills are safe to retry",
        "does not expose aliases or support egress substitution",
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

  test("a requested Link card is steered through the checkout authorize flow in order", () => {
    const result = toolResultJSON(vaultItemResponse(item, target));
    const guidance = result.guidance.join(" ");
    const order = [
      "reach the final checkout page",
      "create the card",
      "invoke authorize with inputs {browser_id, page_url}",
      "share the approval url from item.action",
      "get the item until fill is advertised",
      "fill follows its advertised description",
      "submit the checkout yourself",
    ].map((text) => guidance.indexOf(text));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(guidance).toContain(
      "each advertised operation's description in available_operations is the source of truth",
    );
    expect(result.hints.invocation[0]).toMatchObject({
      arguments: { operation: "authorize" },
      required_inputs: ["browser_id", "page_url"],
    });
  });

  test("a pending Link card's authorize re-check hint needs no checkout context", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...item,
          state: { provider: "link", status: "pending_authorization" },
        },
        target,
      ),
    );
    expect(result.hints.invocation[0].arguments.operation).toBe("authorize");
    expect(result.hints.invocation[0]).not.toHaveProperty("required_inputs");
  });

  test("Link guidance gives every failure a recovery step", () => {
    const guidance = toolResultJSON(
      vaultItemResponse(item, target),
    ).guidance.join(" ");
    for (const text of [
      "change it with manage_vault_cards update; after that, update returns 409: delete the card and create a new one",
      "browser_not_found, browser_unavailable, destination_denied, page_not_found, ambiguous_page, timeout, and browser_error happen before any payment request",
      "make sure the checkout is open in exactly one tab at page_url, then authorize again",
      "authorize without browser_id and page_url to issue a virtual card for the merchant_url origin",
      "declined: read the item's status_reason, then delete the card and create a new one",
      "expired: delete the card and create a new one",
      "exceeds the virtual card limit (50000 minor units)",
      "check the merchant's order confirmation or order history before paying again",
    ])
      expect(guidance).toContain(text);
    for (const text of [
      "do not retry failed",
      "execution",
      "credential type",
      "merchant_account_id",
    ])
      expect(guidance).not.toContain(text);
  });

  test("Link virtual cards keep webmcp_invoke guidance when it is advertised", () => {
    const result = toolResultJSON(
      vaultItemResponse(
        {
          ...linkCard,
          available_operations: [
            fillOperation,
            { type: "webmcp_invoke", description: "Invoke a WebMCP tool" },
          ],
        },
        target,
      ),
    );
    const guidance = result.guidance.join(" ");
    expect(guidance).toContain("list the browser's tools with webmcp");
    expect(guidance).toContain("never retry unknown");
    expect(
      result.hints.invocation.map(
        (hint: { arguments: { operation: string } }) =>
          hint.arguments.operation,
      ),
    ).toEqual(["fill", "webmcp_invoke"]);
  });

  test("the do-not-invoke-webmcp step is scoped to authorize and link pay token fills", () => {
    const guidance = toolResultJSON(
      vaultItemResponse(linkCard, target),
    ).guidance.join(" ");
    expect(guidance).toContain(
      "you do not inspect or invoke the checkout's webmcp tools to authorize",
    );
    expect(guidance).not.toContain("list the browser's tools with webmcp");
    const virtualCardFill = guidance
      .split(". ")
      .find((sentence: string) => sentence.startsWith("for a virtual card"));
    expect(virtualCardFill).toBeDefined();
    expect(virtualCardFill).not.toContain("webmcp");
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
    expect(guidance).toContain("agentcard aliases remain supported");
    expect(guidance).toContain(
      "checkout hold, approval, and replay remain supported",
    );
    expect(guidance).toContain("for checkout preparation");
    expect(guidance).toContain("preparations are single-use");
    expect(guidance).toContain("never fall back to aliases");
    expect(guidance).not.toContain("nested fill object");
    expect(guidance).not.toContain("link cards");
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
        "wallets connect a payment provider; they are not fillable cards",
      );
      expect(guidance).toContain("follow it for this provider's checkout flow");
      expect(guidance).toContain("manage_vault_cards");
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
      "invocation hints are not approval to execute. invoke the advertised browser field-writing operation with manage_vault_items using an inputs object containing browser_id and ordered fields of field/selector bindings, never values. bind the vault at browser creation, authorize the destination, and follow the advertised description. fill does not submit or navigate; real values enter the browser and may be read by an agent with browser access. fill is safe to retry after a failed or unknown outcome; do not fall back to aliases.",
    );
    expect(result.guidance.join(" ")).not.toContain("link cards");
    expect(result.guidance.join(" ")).not.toContain("agentcard aliases");
  });

  test("discovery distinguishes Link fill from AgentCard aliases", async () => {
    const fixture = await connectVaultTest([], undefined, true);
    try {
      const { tools } = await fixture.client.listTools();
      const items = tools.find(({ name }) => name === "manage_vault_items");
      expect(items?.description).toContain(
        "link cards use the advertised fill operation, not aliases or egress substitution",
      );
      expect(items?.description).toContain("inputs.page_url");
      expect(items?.description).toContain(
        "agentcard aliases and checkout hold/approval/replay remain supported",
      );
      const browsers = tools.find(({ name }) => name === "manage_browsers");
      expect(JSON.stringify(browsers?.inputSchema)).toContain(
        "link cards use fill, not aliases or egress substitution",
      );
      expect(JSON.stringify(browsers?.inputSchema)).toContain(
        "agentcard aliases remain",
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
});
