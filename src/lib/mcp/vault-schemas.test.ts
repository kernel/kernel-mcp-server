import { describe, expect, test } from "bun:test";
import {
  agentcardCardSpecSchema,
  authorizeInputsSchema,
} from "./vault-schemas";

describe("vault authorize inputs", () => {
  test.each([
    {},
    { browser_id: "brr_123" },
    { browser_id: "brr_123", page_url: "https://shop.example/checkout" },
  ])("accepts supported provider context shape %p", (inputs) => {
    expect(authorizeInputsSchema.safeParse(inputs).success).toBe(true);
  });

  test.each([
    { page_url: "https://shop.example/checkout" },
    { browser_id: "" },
    { browser_id: "brr_123", page_url: "http://shop.example/checkout" },
  ])("rejects invalid context shape %p", (inputs) => {
    expect(authorizeInputsSchema.safeParse(inputs).success).toBe(false);
  });
});

describe("AgentCard checkout_origin", () => {
  test.each([
    "https://shop.example",
    "https://shop.example:8443",
    "http://localhost",
    "http://localhost:3000",
  ])("accepts canonical origin %s", (checkout_origin) => {
    expect(
      agentcardCardSpecSchema.safeParse({
        wallet: "wallet-1",
        merchant: "Example Shop",
        amount: 1234,
        currency: "USD",
        checkout_origin,
      }).success,
    ).toBe(true);
  });

  test.each([
    "http://shop.example",
    "https://Shop.example",
    "https://shop.example:443",
    "https://shop.example/",
    "https://shop.example/cart",
    "https://shop.example?cart=1",
    "https://user@shop.example",
    "http://127.0.0.1:3000",
    "not a URL",
  ])("rejects non-canonical or unsupported origin %s", (checkout_origin) => {
    expect(
      agentcardCardSpecSchema.safeParse({
        wallet: "wallet-1",
        merchant: "Example Shop",
        amount: 1234,
        currency: "USD",
        checkout_origin,
      }).success,
    ).toBe(false);
  });
});

describe("AgentCard display cart", () => {
  const base = {
    wallet: "wallet-1",
    merchant: "Example Shop",
    amount: 1234,
    currency: "USD",
  };

  test("accepts line items and zero-valued totals", () => {
    expect(
      agentcardCardSpecSchema.parse({
        ...base,
        line_items: [
          {
            title: "Free sample",
            quantity: 1,
            unit_amount: 0,
            amount: 0,
            brand: "Example",
            options: "Size S",
            image_url: "https://images.example/sample.png",
          },
        ],
        subtotal: 0,
        shipping: 0,
        tax: 0,
        discount: 0,
      }),
    ).toMatchObject({
      line_items: [{ unit_amount: 0, amount: 0 }],
      subtotal: 0,
      shipping: 0,
      tax: 0,
      discount: 0,
    });
  });

  test("requires line_items when a displayed total is present", () => {
    expect(
      agentcardCardSpecSchema.safeParse({ ...base, shipping: 0 }).success,
    ).toBe(false);
  });
});
