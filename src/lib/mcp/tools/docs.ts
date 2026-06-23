import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface MintlifySearchResult {
  content: string;
  path: string;
  metadata: Record<string, unknown>;
}

export function registerDocsTools(server: McpServer) {
  // search_docs -- Search Kernel platform documentation
  server.tool(
    "search_docs",
    "Search Kernel platform documentation for guides, tutorials, and API references. Use when you need to understand how Kernel features work or troubleshoot issues.",
    {
      query: z
        .string()
        .describe(
          'Natural language search query (e.g., "how to deploy an app", "browser automation examples").',
        ),
    },
    {
      title: "Search Kernel documentation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ query }, extra) => {
      if (
        !process.env.MINTLIFY_ASSISTANT_API_TOKEN ||
        !process.env.MINTLIFY_DOMAIN
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Documentation search is not configured (missing MINTLIFY_ASSISTANT_API_TOKEN or MINTLIFY_DOMAIN).",
            },
          ],
        };
      }

      try {
        const searchResponse = await fetch(
          `https://api-dsc.mintlify.com/v1/search/${process.env.MINTLIFY_DOMAIN}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.MINTLIFY_ASSISTANT_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, pageSize: 10 }),
          },
        );

        if (!searchResponse.ok) {
          throw new Error(
            `Search failed: ${searchResponse.status} ${searchResponse.statusText}`,
          );
        }

        const searchResults: MintlifySearchResult[] =
          await searchResponse.json();
        let formatted = "# Documentation Search Results\n\n";

        if (searchResults?.length > 0) {
          searchResults.forEach((result, index) => {
            formatted += `## ${index + 1}. ${result.path}\n\n${result.content}\n\n---\n\n`;
          });
        } else {
          formatted += "No results found for your query.";
        }

        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching documentation: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    },
  );
}
