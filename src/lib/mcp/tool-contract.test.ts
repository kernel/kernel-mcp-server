import { describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/server";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerMcpCapabilities } from "@/lib/mcp/register";

// Every client loads every tool description, so long descriptions cost context on
// each request. Per-action detail belongs in parameter descriptions or in the
// response guidance and notes returned after a call.
const MAX_DESCRIPTION_CHARS = 3_000;

// Temporary exceptions, capped near their current size so they cannot grow. Lower
// a cap when a description shrinks; do not raise one without moving detail out.
const DESCRIPTION_CHAR_EXCEPTIONS: Record<string, number> = {
  // Credential and payment safety rules (consent, secret handling, recovery) that
  // must be read before the first call. Remaining per-provider detail should move
  // to item guidance.
  manage_vault_items: 10_000,
  manage_vault_cards: 8_000,
  manage_vault_credentials: 6_100,
  // Reference for the helper functions available inside the repl.
  browser_repl: 7_200,
};

// The whole tools/list payload, including input schemas, with every toolset enabled.
const MAX_TOOLS_LIST_CHARS = 230_000;

async function listAllTools() {
  const mcp = await connectTestMcp((server) => {
    registerMcpCapabilities(server, {
      mcpApps: true,
      vaults: true,
      search: true,
    });
  }, {});
  try {
    return await mcp.client.listTools();
  } finally {
    await mcp.close();
  }
}

function actionValues(tool: Tool): string[] {
  const action = tool.inputSchema.properties?.action as
    | { enum?: string[]; anyOf?: Array<{ enum?: string[] }> }
    | undefined;
  return [
    ...(action?.enum ?? []),
    ...(action?.anyOf ?? []).flatMap(({ enum: values }) => values ?? []),
  ];
}

describe("tool contract", () => {
  test("tool descriptions stay within their size budget", async () => {
    const { tools } = await listAllTools();
    const oversized = tools.flatMap((tool) => {
      const limit =
        DESCRIPTION_CHAR_EXCEPTIONS[tool.name] ?? MAX_DESCRIPTION_CHARS;
      const length = (tool.description ?? "").length;
      return length > limit ? [`${tool.name}: ${length} > ${limit}`] : [];
    });
    expect(oversized).toEqual([]);
    for (const name of Object.keys(DESCRIPTION_CHAR_EXCEPTIONS)) {
      expect(tools.map((tool) => tool.name)).toContain(name);
    }
  });

  test("tools/list stays within its size budget", async () => {
    const result = await listAllTools();
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MAX_TOOLS_LIST_CHARS,
    );
  });

  test("tools with delete or remove actions are marked destructive", async () => {
    const { tools } = await listAllTools();
    const destructive = tools.filter((tool) =>
      actionValues(tool).some(
        (action) => action.includes("delete") || action.includes("remove"),
      ),
    );
    expect(destructive.length).toBeGreaterThan(0);
    const unmarked = destructive
      .filter((tool) => tool.annotations?.destructiveHint !== true)
      .map((tool) => tool.name);
    expect(unmarked).toEqual([]);
  });
});
