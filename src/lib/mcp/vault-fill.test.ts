import { describe, expect, test } from "bun:test";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "@onkernel/sdk";
import { throwVaultFillError } from "@/lib/mcp/vault-fill";

describe("fill transport error classification", () => {
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
      throwVaultFillError(error);
    } catch (result) {
      caught = result;
    }
    expect(caught).toMatchObject({
      name,
      message: expect.stringContaining("may have been written"),
    });
    expect(String(caught)).not.toContain("private-cause");
  });
});
