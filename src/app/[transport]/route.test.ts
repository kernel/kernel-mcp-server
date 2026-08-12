import { describe, expect, test } from "bun:test";

const { connectionScopeFailureResponse } = await import("./route");

describe("connectionScopeFailureResponse", () => {
  test("answers a rejected credential with 401 rather than a server error", async () => {
    const response = connectionScopeFailureResponse({
      status: "rejected",
      statusCode: 401,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: "The Kernel API rejected this credential",
    });
  });

  test("answers an unresolvable scope with a retryable 503", async () => {
    const response = connectionScopeFailureResponse({ status: "unavailable" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description: "Unable to resolve Kernel connection scope",
    });
  });
});
