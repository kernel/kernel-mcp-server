import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  hostedAuthConnectionForMCP,
  hostedAuthLoginForMCP,
  hostedAuthParams,
} from "./hosted-auth";

const schema = z.object(hostedAuthParams).strict();

describe("hostedAuthParams", () => {
  test("accepts hosted login operations", () => {
    expect(schema.parse({ action: "login", id: "auth_123" })).toEqual({
      action: "login",
      id: "auth_123",
    });
  });

  test("projects login responses without internal handoff codes", () => {
    expect(
      hostedAuthLoginForMCP({
        id: "auth_123",
        hosted_url: "https://auth.onkernel.com/flow_123",
        live_view_url: "https://app.onkernel.com/auth/flow_123",
        flow_expires_at: "2026-07-31T13:00:00Z",
        flow_type: "LOGIN",
        handoff_code: "internal-secret",
      }),
    ).toEqual({
      id: "auth_123",
      hosted_url: "https://auth.onkernel.com/flow_123",
      live_view_url: "https://app.onkernel.com/auth/flow_123",
      flow_expires_at: "2026-07-31T13:00:00Z",
      flow_type: "LOGIN",
    });
  });

  test("projects connection state without credential references", () => {
    expect(
      hostedAuthConnectionForMCP({
        id: "auth_123",
        domain: "example.com",
        profile_name: "profile_123",
        status: "NEEDS_AUTH",
        flow_status: "IN_PROGRESS",
        credential: { name: "private-login" },
      }),
    ).toEqual({
      id: "auth_123",
      domain: "example.com",
      profile_name: "profile_123",
      status: "NEEDS_AUTH",
      flow_status: "IN_PROGRESS",
      flow_step: null,
      flow_expires_at: null,
      hosted_url: null,
      live_view_url: null,
      error_code: null,
      error_message: null,
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
