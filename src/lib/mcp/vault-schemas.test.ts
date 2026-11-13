import { describe, expect, test } from "bun:test";
import {
  agentcardCardSpecSchema,
  kernelCardSpecSchema,
  kernelPaymentRequestSpecSchema,
} from "./vault-schemas";

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

describe("KERNEL payment_method_id", () => {
  const spec = {
    wallet: "wallet-1",
    amount: 1999,
    currency: "usd",
    merchant_name: "Shop",
    merchant_url: "https://shop.example/pay",
  };

  test("is optional on a card and required on a payment_request", () => {
    expect(kernelCardSpecSchema.safeParse(spec).success).toBe(true);
    expect(kernelPaymentRequestSpecSchema.safeParse(spec).success).toBe(false);
    for (const schema of [kernelCardSpecSchema, kernelPaymentRequestSpecSchema])
      expect(
        schema.safeParse({ ...spec, payment_method_id: "pm_1" }).success,
      ).toBe(true);
  });

  test.each(["", "x".repeat(129)])("rejects %p", (payment_method_id) => {
    expect(
      kernelCardSpecSchema.safeParse({ ...spec, payment_method_id }).success,
    ).toBe(false);
  });
});
