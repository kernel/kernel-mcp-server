/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  connectTestMcp,
  toolResultJSON,
  toolResultText,
} from "@/lib/mcp/mcp-test-fixtures";
import { registerTaskCapabilities } from "@/lib/mcp/tools/tasks";

function page(items: unknown[] = []) {
  return {
    getPaginatedItems: () => items,
    has_more: false,
    next_offset: null,
  };
}

describe("manage_tasks", () => {
  test("covers task and report SDK methods and forwards nested inputs", async () => {
    const calls: unknown[] = [];
    const kernelClient = {
      tasks: {
        create: async (body: unknown) => {
          calls.push(["tasks.create", body]);
          return { id: "task_1", ...((body as object) ?? {}) };
        },
        list: async (query: unknown) => {
          calls.push(["tasks.list", query]);
          return page([{ id: "task_1" }]);
        },
        retrieve: async (id: string) => {
          calls.push(["tasks.retrieve", id]);
          return { id };
        },
        linkBrowsers: async (id: string, body: unknown) => {
          calls.push(["tasks.linkBrowsers", id, body]);
          return { id, ...(body as object) };
        },
      },
      reportTypes: {
        list: async (query: unknown) => {
          calls.push(["reportTypes.list", query]);
          return page([{ type: "task.result", latest_version: 2 }]);
        },
        retrieve: async (type: string) => {
          calls.push(["reportTypes.retrieve", type]);
          return { type, latest_version: 2, schema: { type: "object" } };
        },
        versions: {
          retrieve: async (version: number, params: unknown) => {
            calls.push(["reportTypes.versions.retrieve", version, params]);
            return { type: "task.result", version, schema: {} };
          },
        },
      },
      reports: {
        create: async (body: unknown) => {
          calls.push(["reports.create", body]);
          return { id: "report_1", ...(body as object) };
        },
        list: async (query: unknown) => {
          calls.push(["reports.list", query]);
          return page([{ id: "report_1" }]);
        },
        retrieve: async (id: string) => {
          calls.push(["reports.retrieve", id]);
          return { id };
        },
      },
    };
    const { client, close } = await connectTestMcp(
      registerTaskCapabilities,
      kernelClient,
    );

    try {
      const create = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "create",
          description: "Book a hotel room for two nights",
          target_website: "booking.example",
          metadata: {},
          started_at: "2026-11-17T12:00:00Z",
          session_ids: [],
        },
      });
      expect(toolResultJSON(create)).toEqual({
        id: "task_1",
        description: "Book a hotel room for two nights",
        target_website: "booking.example",
        metadata: {},
        started_at: "2026-11-17T12:00:00Z",
        session_ids: [],
      });

      const listedTasks = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "list",
          session_id: "browser_1",
          limit: 10,
          offset: 0,
        },
      });
      expect(toolResultJSON(listedTasks)).toEqual({
        items: [{ id: "task_1" }],
        has_more: false,
        next_offset: null,
      });
      await client.callTool({
        name: "manage_tasks",
        arguments: { action: "get", task_id: "task_1" },
      });
      await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "link_browsers",
          task_id: "task_1",
          session_ids: ["browser_1", "browser_deleted"],
        },
      });

      const reportTypes = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "list_report_types",
          task_id: "task_1",
          limit: 5,
          offset: 0,
        },
      });
      expect(toolResultJSON(reportTypes).note).toContain("get_report_type");
      await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "get_report_type",
          report_type: "task.result",
        },
      });
      await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "get_report_type_version",
          report_type: "task.result",
          report_type_version: 1,
        },
      });

      const reportData = {
        result: "succeeded",
        evidence: { lines: [], confidence: 0 },
        flags: [],
      };
      const submitted = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "submit_report",
          task_id: "task_1",
          report_type: "task.result",
          report_data: reportData,
          occurred_at: "2026-11-17T12:05:00Z",
          schema_version: 1,
          session_id: "browser_deleted",
        },
      });
      expect(toolResultJSON(submitted)).toMatchObject({
        id: "report_1",
        data: reportData,
        occurred_at: "2026-11-17T12:05:00Z",
        schema_version: 1,
      });
      await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "list_reports",
          task_id: "task_1",
          report_type: "task.result",
          limit: 20,
          offset: 0,
        },
      });
      await client.callTool({
        name: "manage_tasks",
        arguments: { action: "get_report", report_id: "report_1" },
      });

      expect(calls).toEqual([
        [
          "tasks.create",
          {
            description: "Book a hotel room for two nights",
            target_website: "booking.example",
            metadata: {},
            started_at: "2026-11-17T12:00:00Z",
            session_ids: [],
          },
        ],
        ["tasks.list", { session_id: "browser_1", limit: 10, offset: 0 }],
        ["tasks.retrieve", "task_1"],
        [
          "tasks.linkBrowsers",
          "task_1",
          { session_ids: ["browser_1", "browser_deleted"] },
        ],
        ["reportTypes.list", { task_id: "task_1", limit: 5, offset: 0 }],
        ["reportTypes.retrieve", "task.result"],
        ["reportTypes.versions.retrieve", 1, { type: "task.result" }],
        [
          "reports.create",
          {
            task_id: "task_1",
            type: "task.result",
            data: {
              result: "succeeded",
              evidence: { lines: [], confidence: 0 },
              flags: [],
            },
            occurred_at: "2026-11-17T12:05:00Z",
            schema_version: 1,
            session_id: "browser_deleted",
          },
        ],
        [
          "reports.list",
          {
            task_id: "task_1",
            type: "task.result",
            limit: 20,
            offset: 0,
          },
        ],
        ["reports.retrieve", "report_1"],
      ]);
    } finally {
      await close();
    }
  });

  test("advertises API limits and non-destructive annotations", async () => {
    const { client, close } = await connectTestMcp(
      registerTaskCapabilities,
      {},
    );
    try {
      const { tools } = await client.listTools();
      const tool = tools.find(({ name }) => name === "manage_tasks");
      expect(JSON.stringify(tool?.inputSchema)).not.toContain('"$ref"');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(tool?.description).toContain("list_report_types");
      expect(tool?.description).toContain("oldest first");
      expect(tool?.inputSchema.properties?.description).toMatchObject({
        minLength: 1,
        maxLength: 4096,
      });
      expect(tool?.inputSchema.properties?.metadata).toMatchObject({
        type: "object",
        maxProperties: 20,
        propertyNames: { minLength: 1, maxLength: 64 },
        additionalProperties: { type: "string", maxLength: 256 },
      });
      expect(tool?.inputSchema.properties?.session_ids).toMatchObject({
        type: "array",
        maxItems: 100,
      });
      expect(
        (
          tool?.inputSchema.properties?.report_data as
            | { description?: string }
            | undefined
        )?.description,
      ).toContain("16 kb");
      expect(
        (
          tool?.inputSchema.properties?.limit as
            | { description?: string }
            | undefined
        )?.description,
      ).toContain("default 20");
      expect(tool?.inputSchema.properties?.offset).toMatchObject({
        minimum: 0,
      });
    } finally {
      await close();
    }
  });

  test("rejects missing, irrelevant, and oversized inputs before SDK calls", async () => {
    let calls = 0;
    const { client, close } = await connectTestMcp(registerTaskCapabilities, {
      tasks: {
        create: async () => {
          calls++;
          return {};
        },
        retrieve: async () => {
          calls++;
          return {};
        },
      },
      reports: {
        create: async () => {
          calls++;
          return {};
        },
      },
    });
    try {
      const missing = await client.callTool({
        name: "manage_tasks",
        arguments: { action: "get" },
      });
      expect(missing.isError).toBe(true);
      expect(toolResultText(missing)).toContain("task_id is required");

      const irrelevant = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "get",
          task_id: "task_1",
          offset: 0,
        },
      });
      expect(irrelevant.isError).toBe(true);
      expect(toolResultText(irrelevant)).toContain(
        "offset does not apply to get",
      );

      const tooManyMetadataKeys = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "create",
          description: "Task",
          metadata: Object.fromEntries(
            Array.from({ length: 21 }, (_, index) => [`key_${index}`, "value"]),
          ),
        },
      });
      expect(tooManyMetadataKeys.isError).toBe(true);

      const oversized = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "submit_report",
          task_id: "task_1",
          report_type: "task.result",
          report_data: { value: "x".repeat(16 * 1024) },
        },
      });
      expect(oversized.isError).toBe(true);

      const longSubmitType = await client.callTool({
        name: "manage_tasks",
        arguments: {
          action: "submit_report",
          task_id: "task_1",
          report_type: "x".repeat(129),
          report_data: {},
        },
      });
      expect(longSubmitType.isError).toBe(true);
      expect(toolResultText(longSubmitType)).toContain(
        "at most 128 characters",
      );
      expect(calls).toBe(0);
    } finally {
      await close();
    }
  });
});
