import { describe, expect, test } from "bun:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@onkernel/sdk";
import {
  throwKernelVaultError,
  throwLinkAuthorizeError,
  throwVaultError,
} from "@/lib/mcp/vault-responses";

describe("kernel authorization errors", () => {
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
    {
      error: new APIError(
        408,
        { message: actionURL, code: "timeout" },
        undefined,
        new Headers(),
      ),
      name: "KernelApiError408",
    },
  ])(
    "retains $name while redacting diagnostics and preserving uncertainty",
    ({ error, name }) => {
      let caught: unknown;
      try {
        throwKernelVaultError(
          "manage_vault_cards",
          "authorize",
          error,
          "authorize",
        );
      } catch (result) {
        caught = result;
      }
      expect(caught).toHaveProperty("name", name);
      expect(String(caught)).toContain("re-get the item");
      expect(String(caught)).toContain("inspect state/events");
      expect(String(caught)).toContain(
        "invoke authorize once more only if freshly advertised",
      );
      expect(String(caught)).not.toContain(actionURL);
      expect(String(caught)).not.toContain("nothing new was authorized");
      if (error.status === 408) {
        expect(String(caught)).toContain("http status: 408");
        expect(String(caught)).toContain("api code: timeout");
      }
    },
  );

  test("a classified fill timeout keeps redaction and allows only an inspected field-write retry", () => {
    let caught: unknown;
    try {
      throwKernelVaultError(
        "manage_vault_items",
        "invoke",
        new APIConnectionTimeoutError({ message: actionURL }),
        "fill",
      );
    } catch (result) {
      caught = result;
    }
    expect(caught).toHaveProperty("name", "KernelApiTimeout");
    expect(String(caught)).toContain("inspect the browser page and item state");
    expect(String(caught)).toContain("safe to retry the field write");
    expect(String(caught)).not.toContain("authorization outcome is uncertain");
    expect(String(caught)).not.toContain(actionURL);
  });

  test.each([400, 409, 500])(
    "retains the HTTP %s category without upstream text",
    (status) => {
      let caught: unknown;
      try {
        throwKernelVaultError(
          "manage_vault_cards",
          "authorize",
          new APIError(
            status,
            { message: actionURL, code: "fixture_error" },
            undefined,
            new Headers(),
          ),
          "authorize",
        );
      } catch (result) {
        caught = result;
      }
      expect(caught).toHaveProperty("name", `KernelApiError${status}`);
      expect(String(caught)).toContain(`http status: ${status}`);
      expect(String(caught)).toContain("api code: fixture_error");
      expect(String(caught)).not.toContain(actionURL);
    },
  );

  test("does not describe a failed preflight observation as a submitted authorization", () => {
    expect(() =>
      throwKernelVaultError(
        "manage_vault_cards",
        "authorize",
        new APIConnectionTimeoutError({ message: actionURL }),
      ),
    ).toThrow("inspect item state and events");
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

describe("link authorize errors", () => {
  const recovery =
    "no payment request was made. make sure the checkout is open in exactly one tab at page_url, then authorize again. if checkout inspection keeps failing, authorize without browser_id and page_url to issue a virtual card for the merchant_url origin.";

  function caught(error: unknown) {
    try {
      throwLinkAuthorizeError("manage_vault_items", "invoke", error, true);
    } catch (result) {
      return result;
    }
  }

  test.each([
    [404, "browser_not_found"],
    [409, "browser_unavailable"],
    [403, "destination_denied"],
    [400, "page_not_found"],
    [400, "ambiguous_page"],
    [400, "timeout"],
    [500, "browser_error"],
  ])(
    "keeps the HTTP %s %s message and adds the checkout recovery step",
    (status, code) => {
      const error = caught(
        new APIError(
          status,
          { code, message: "Checkout diagnostic" },
          undefined,
          new Headers(),
        ),
      );
      expect(error).toHaveProperty("name", `KernelApiError${status}`);
      expect(String(error)).toContain(
        `${status} Checkout diagnostic [code: ${code}] ${recovery}`,
      );
    },
  );

  test("passes other API errors through unchanged", () => {
    const error = caught(
      new APIError(
        400,
        { code: "invalid_request", message: "Amount diagnostic" },
        undefined,
        new Headers(),
      ),
    );
    expect(String(error)).toBe(
      "KernelApiError400: error in manage_vault_items (invoke): 400 Amount diagnostic [code: invalid_request]",
    );
  });

  test("reports a lost response like other vault operations", () => {
    const error = caught(
      new APIConnectionError({ message: "Connection diagnostic" }),
    );
    expect(error).toHaveProperty("name", "KernelApiConnectionError");
    expect(String(error)).toContain(
      "no response was received from the api after the operation was submitted.",
    );
    expect(String(error)).not.toContain(recovery);
  });
});
