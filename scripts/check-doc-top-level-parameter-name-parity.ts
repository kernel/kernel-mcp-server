import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBrowserPoolCapabilities } from "@/lib/mcp/tools/browser-pools";
import { registerProfileCapabilities } from "@/lib/mcp/tools/profiles";
import { registerProxyTools } from "@/lib/mcp/tools/proxies";

// Add every newly documented durable tool here so CI includes its parameter table.
const documentedTools = {
  manage_browser_pools: "reference/mcp-server/tools/manage-browser-pools.mdx",
  manage_profiles: "reference/mcp-server/tools/manage-profiles.mdx",
  manage_proxies: "reference/mcp-server/tools/manage-proxies.mdx",
} as const;

export function parseParameterNames(markdown: string): Set<string> {
  const heading = markdown.match(/^## Parameters\s*$/m);
  if (!heading || heading.index === undefined) {
    throw new Error("missing Parameters section");
  }
  const parameters = markdown
    .slice(heading.index + heading[0].length)
    .split(/^##\s/m, 1)[0];

  const names = new Set<string>();
  for (const line of parameters.split("\n")) {
    const firstCell = line.match(/^\|\s*(.*?)\s*\|/)?.[1];
    if (!firstCell) continue;

    for (const match of firstCell.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
      names.add(match[1]);
    }
  }
  if (names.size === 0) {
    throw new Error("Parameters table contains no parameter names");
  }
  return names;
}

export function parityError(
  toolName: string,
  schemaNames: Set<string>,
  documentedNames: Set<string>,
): string | undefined {
  const missing = [...schemaNames].filter((name) => !documentedNames.has(name));
  const stale = [...documentedNames].filter((name) => !schemaNames.has(name));
  if (missing.length === 0 && stale.length === 0) return undefined;

  const details = [];
  if (missing.length > 0)
    details.push(`missing from docs: ${missing.sort().join(", ")}`);
  if (stale.length > 0)
    details.push(`not in schema: ${stale.sort().join(", ")}`);
  return `${toolName}: ${details.join("; ")}`;
}

async function listDurableToolParameters(): Promise<Map<string, Set<string>>> {
  const server = new McpServer({
    name: "top-level-parameter-name-parity",
    version: "0.0.0",
  });
  registerBrowserPoolCapabilities(server);
  registerProfileCapabilities(server);
  registerProxyTools(server);

  const client = new Client({
    name: "top-level-parameter-name-parity",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const { tools } = await client.listTools();
    return new Map(
      tools.map((tool) => [
        tool.name,
        new Set(Object.keys(tool.inputSchema.properties ?? {})),
      ]),
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

export async function checkDocTopLevelParameterNameParity(
  docsRoot: string,
): Promise<void> {
  const schemas = await listDurableToolParameters();
  const errors: string[] = [];

  for (const [toolName, relativePath] of Object.entries(documentedTools)) {
    const schemaNames = schemas.get(toolName);
    if (!schemaNames) {
      errors.push(`${toolName}: tool was not registered`);
      continue;
    }

    const markdown = await readFile(join(docsRoot, relativePath), "utf8");
    try {
      const error = parityError(
        toolName,
        schemaNames,
        parseParameterNames(markdown),
      );
      if (error) errors.push(error);
    } catch (error) {
      errors.push(
        `${toolName}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `MCP documentation top-level parameter-name drift:\n${errors.join("\n")}`,
    );
  }
}

if (import.meta.main) {
  const docsRoot = process.argv[2];
  if (!docsRoot) {
    throw new Error(
      "usage: bun scripts/check-doc-top-level-parameter-name-parity.ts <docs-root>",
    );
  }
  await checkDocTopLevelParameterNameParity(docsRoot);
  console.log(
    "MCP documentation top-level parameter names match the registered schemas.",
  );
}
