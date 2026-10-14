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

describe("kernel vault errors", () => {
  const actionURL = "https://vault.example/approve#token=private-capability";

  test.each([
    {
      error: new APIConnectionError({ message: actionURL }),
      name: "KernelApiConnectionError",
    },
    {
      error: new APIConnectionTimeoutError({ message: actionURL }),
      name: "KernelApiTimeout",
    },
    {
      error: new APIUserAbortError({ message: actionURL }),
      name: "KernelApiAborted",
    },
  ])(
    "retains $name, redacts diagnostics, and only notes the missing response",
    ({ error, name }) => {
      let caught: unknown;
      try {
        throwKernelVaultError("manage_vault_cards", "authorize", error, true);
      } catch (result) {
        caught = result;
      }
      expect(caught).toHaveProperty("name", name);
      expect(String(caught)).toBe(
        `${name}: error in manage_vault_cards (authorize): request failed. no response was received from the api after the operation was submitted.`,
      );
      expect(String(caught)).not.toContain(actionURL);
    },
  );

  test("a request that was never submitted gets the plain no-response note", () => {
    expect(() =>
      throwKernelVaultError(
        "manage_vault_cards",
        "authorize",
        new APIConnectionTimeoutError({ message: actionURL }),
      ),
    ).toThrow(
      "error in manage_vault_cards (authorize): request failed. no response was received from the api.",
    );
  });

  test.each([400, 408, 409, 429, 500])(
    "passes HTTP %s status, code, and redacted message through unchanged",
    (status) => {
      let caught: unknown;
      try {
        throwKernelVaultError(
          "manage_vault_items",
          "invoke",
          new APIError(
            status,
            {
              message: `card changed; re-read the item. see ${actionURL}`,
              code: "fixture_error",
            },
            undefined,
            new Headers(),
          ),
          true,
        );
      } catch (result) {
        caught = result;
      }
      expect(caught).toHaveProperty("name", `KernelApiError${status}`);
      expect(String(caught)).toBe(
        `KernelApiError${status}: error in manage_vault_items (invoke): http status: ${status}. api code: fixture_error. card changed; re-read the item. see [redacted url]`,
      );
      expect(String(caught)).not.toContain(actionURL);
    },
  );

  test.each(["30", "Wed, 14 Oct 2026 12:00:00 GMT"])(
    "passes Retry-After %s through as returned",
    (retryAfter) => {
      expect(() =>
        throwKernelVaultError(
          "manage_vault_items",
          "invoke",
          new APIError(
            429,
            { code: "rate_limited", message: "provider limit" },
            undefined,
            new Headers({ "Retry-After": retryAfter }),
          ),
          true,
        ),
      ).toThrow(
        `error in manage_vault_items (invoke): http status: 429. api code: rate_limited. retry-after: ${retryAfter}. provider limit`,
      );
    },
  );

  test("omits a malformed Retry-After and an unsafe code", () => {
    expect(() =>
      throwKernelVaultError(
        "manage_vault_items",
        "invoke",
        new APIError(
          429,
          { code: actionURL, message: "provider limit" },
          undefined,
          new Headers({ "Retry-After": actionURL }),
        ),
        true,
      ),
    ).toThrow(
      "error in manage_vault_items (invoke): http status: 429. provider limit",
    );
  });

  test("adds nothing beyond the api message", () => {
    for (const status of [400, 403, 404, 409, 500]) {
      let caught: unknown;
      try {
        throwKernelVaultError(
          "manage_vault_items",
          "invoke",
          new APIError(
            status,
            { message: "fix selector", code: "invalid_selector" },
            undefined,
            new Headers(),
          ),
          true,
        );
      } catch (result) {
        caught = result;
      }
      const text = String(caught);
      expect(text).toContain("fix selector");
      expect(text).not.toContain("fields were written");
      expect(text).not.toContain("retry");
      expect(text).not.toContain("re-get");
      expect(text).not.toContain("advertised");
      expect(text).not.toContain("no response was received");
    }
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
    expect(String(caught)).toContain(
      "no response was received from the api after the operation was submitted.",
    );
    expect(String(caught)).not.toContain("retry");
    expect(String(caught)).toContain(error.message);
  });
});
