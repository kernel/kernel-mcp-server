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
      error: new APIConnectionError({ message: "private-cause" }),
      name: "KernelApiConnectionError",
    },
    {
      error: new APIConnectionTimeoutError({ message: "private-cause" }),
      name: "KernelApiTimeout",
    },
    {
      error: new APIUserAbortError({ message: "private-cause" }),
      name: "KernelApiAborted",
    },
  ])("retains $name without exposing transport details", ({ error, name }) => {
    let caught: unknown;
    try {
      throwVaultError("manage_vault_items", "invoke", error, true);
    } catch (result) {
      caught = result;
    }
    expect(caught).toMatchObject({
      name,
      message: expect.stringContaining("may have partially completed"),
    });
    expect(String(caught)).not.toContain("private-cause");
  });
});
