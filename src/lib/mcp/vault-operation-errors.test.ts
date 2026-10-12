import { describe, expect, test } from "bun:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@onkernel/sdk";
import {
  throwKernelVaultError,
  throwVaultError,
} from "@/lib/mcp/vault-responses";

describe("kernel authorization errors", () => {
  const actionURL = "https://vault.example/approve#token=private-capability";

  test.each([
    new APIConnectionError({ message: actionURL }),
    new APIConnectionTimeoutError({ message: actionURL }),
    new APIError(
      408,
      { message: actionURL, code: "timeout" },
      undefined,
      new Headers(),
    ),
  ])(
    "redacts transport and timeout diagnostics and preserves uncertainty",
    (error) => {
      let caught: unknown;
      try {
        throwKernelVaultError("manage_vault_cards", "authorize", error, true);
      } catch (result) {
        caught = result;
      }
      expect(String(caught)).toContain("authorization outcome is uncertain");
      expect(String(caught)).toContain("inspect item state and events");
      expect(String(caught)).toContain("do not retry authorize");
      expect(String(caught)).not.toContain(actionURL);
      expect(String(caught)).not.toContain("nothing new was authorized");
      if (error.status === 408) {
        expect(String(caught)).toContain("http status: 408");
        expect(String(caught)).toContain("api code: timeout");
      }
    },
  );

  test("does not describe a failed preflight observation as a submitted authorization", () => {
    expect(() =>
      throwKernelVaultError(
        "manage_vault_cards",
        "authorize",
        new APIConnectionTimeoutError({ message: actionURL }),
      ),
    ).toThrow("do not retry an uncertain operation");
  });
});

describe("vault operation transport errors", () => {
  test.each([
    {
      error: new APIConnectionError({ message: "Connection diagnostic" }),
      name: "KernelApiConnectionError",
    },
    {
      error: new APIConnectionTimeoutError({ message: "Timeout diagnostic" }),
      name: "KernelApiTimeout",
    },
    {
      error: new APIUserAbortError({ message: "Abort diagnostic" }),
      name: "KernelApiAborted",
    },
  ])("retains $name and the original message", ({ error, name }) => {
    let caught: unknown;
    try {
      throwVaultError("manage_vault_items", "invoke", error, true);
    } catch (result) {
      caught = result;
    }
    expect(caught).toHaveProperty("name", name);
    expect(String(caught)).toContain("may have partially completed");
    expect(String(caught)).toContain(error.message);
  });
});
