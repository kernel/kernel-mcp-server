import { describe, expect, test } from "bun:test";
import { createKernelClient } from "@/lib/mcp/kernel-client";

describe("createKernelClient", () => {
  test("uses an explicit project before the server default", () => {
    const previous = process.env.KERNEL_PROJECT;
    process.env.KERNEL_PROJECT = "proj_default";
    try {
      expect(createKernelClient("test-key", "proj_explicit").project).toBe(
        "proj_explicit",
      );
      expect(createKernelClient("test-key", "proj_explicit").projectID).toBe(
        null,
      );
      expect(createKernelClient("test-key").project).toBe("proj_default");
    } finally {
      if (previous === undefined) {
        delete process.env.KERNEL_PROJECT;
      } else {
        process.env.KERNEL_PROJECT = previous;
      }
    }
  });
});
