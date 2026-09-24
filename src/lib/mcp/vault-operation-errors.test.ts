import { describe, expect, test } from "bun:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "@onkernel/sdk";
import { throwVaultError } from "@/lib/mcp/vault-responses";

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
