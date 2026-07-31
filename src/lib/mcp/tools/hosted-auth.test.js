import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { hostedAuthParams } from "./hosted-auth";

const schema = z.object(hostedAuthParams).strict();

describe("hostedAuthParams", () => {
  test("accepts hosted login operations", () => {
    expect(schema.parse({ action: "login", id: "auth_123" })).toEqual({
      action: "login",
      id: "auth_123",
    });
  });

  test("rejects credential and raw field submission inputs", () => {
    expect(() =>
      schema.parse({
        action: "create",
        domain: "example.com",
        profile_name: "profile_123",
        credential_name: "saved-login",
      }),
    ).toThrow();
    expect(() =>
      schema.parse({
        action: "submit",
        id: "auth_123",
        fields: { password: "do-not-expose" },
      }),
    ).toThrow();
  });
});
