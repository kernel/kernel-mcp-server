import { describe, expect, test } from "bun:test";
import { connectTestMcp, toolResultJSON } from "@/lib/mcp/mcp-test-fixtures";
import {
  KERNEL_MISSING_CAPABILITY_TOOL_NAME,
  type MissingCapabilityReport,
  registerMissingCapabilityTool,
} from "@/lib/mcp/tools/missing-capability";

describe("get_more_tools", () => {
  test("routes external demand and rejects owner mismatches and existing-tool failures", async () => {
    const captured: MissingCapabilityReport[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerMissingCapabilityTool(server, (report) => {
          captured.push(report);
        }),
      {},
    );

    try {
      const external = await client.callTool({
        name: KERNEL_MISSING_CAPABILITY_TOOL_NAME,
        arguments: {
          context:
            "Sending a notification requires an external integration that no available KERNEL tool currently provides.",
          gap_reason: "external_integration_unavailable",
          capability_area: "external_integration",
          capability: "external notification delivery",
          requested_action: "execute",
          task_outcome: "blocked",
        },
      });
      expect(toolResultJSON(external)).toMatchObject({
        recorded: true,
        status: "recorded",
        destination: "external_integration_demand",
      });

      const ownerMismatch = await client.callTool({
        name: KERNEL_MISSING_CAPABILITY_TOOL_NAME,
        arguments: {
          context:
            "Sending a notification was incorrectly classified as KERNEL product demand instead of an external integration.",
          gap_reason: "external_integration_unavailable",
          capability_area: "browsers",
          capability: "external notification delivery",
          requested_action: "execute",
          task_outcome: "blocked",
        },
      });
      expect(toolResultJSON(ownerMismatch)).toMatchObject({
        recorded: false,
        status: "invalid_capability_owner",
      });

      const existingToolFailure = await client.callTool({
        name: KERNEL_MISSING_CAPABILITY_TOOL_NAME,
        arguments: {
          context:
            "Creating a browser failed through an existing KERNEL tool and should be routed to feedback instead.",
          gap_reason: "existing_tool_failed",
          capability_area: "browsers",
          capability: "browser creation",
          requested_action: "create",
          task_outcome: "blocked",
          tools_checked: ["manage_browsers"],
        },
      });
      expect(toolResultJSON(existingToolFailure)).toMatchObject({
        recorded: false,
        status: "not_a_capability_gap",
      });
      expect(captured).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test("accepts the previous context-only contract without recording demand", async () => {
    const captured: MissingCapabilityReport[] = [];
    const { client, close } = await connectTestMcp(
      (server) =>
        registerMissingCapabilityTool(server, (report) => {
          captured.push(report);
        }),
      {},
    );

    try {
      const legacy = await client.callTool({
        name: KERNEL_MISSING_CAPABILITY_TOOL_NAME,
        arguments: {
          context:
            "Reporting a missing capability through the previous context-only contract while the client refreshes its tools.",
        },
      });
      expect(legacy.isError).not.toBe(true);
      expect(toolResultJSON(legacy)).toMatchObject({
        recorded: false,
        status: "legacy_schema_refresh_required",
      });
      expect(captured).toHaveLength(0);

      const partial = await client.callTool({
        name: KERNEL_MISSING_CAPABILITY_TOOL_NAME,
        arguments: {
          context:
            "Reporting a partially structured capability request that must not fall back to the compatibility contract.",
          gap_reason: "kernel_capability_missing",
        },
      });
      expect(partial.isError).toBe(true);
      expect(captured).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test("reports capture failures without interrupting the task", async () => {
    const { client, close } = await connectTestMcp(
      (server) =>
        registerMissingCapabilityTool(server, () => {
          throw new Error("capture unavailable");
        }),
      {},
    );

    try {
      const result = await client.callTool({
        name: KERNEL_MISSING_CAPABILITY_TOOL_NAME,
        arguments: {
          context:
            "Uploading a local file requires a browser transfer capability that no available KERNEL tool provides.",
          gap_reason: "kernel_capability_missing",
          capability_area: "browser_files",
          capability: "browser filesystem upload",
          requested_action: "transfer",
          task_outcome: "blocked",
          tools_checked: ["manage_browsers"],
        },
      });
      expect(toolResultJSON(result)).toMatchObject({
        recorded: false,
        status: "failed",
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await close();
    }
  });
});
