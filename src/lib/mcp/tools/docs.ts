import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResponse } from "@/lib/mcp/responses";

interface MintlifySearchResult {
  content: string;
  path: string;
  metadata: Record<string, unknown>;
}

export function registerDocsTools(server: McpServer) {
  // search_docs -- Search Kernel platform documentation
  server.registerTool(
    "search_docs",
    {
      description:
        "search KERNEL platform documentation for guides, tutorials, and api references. use when you need to understand how KERNEL features work or troubleshoot issues.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'natural language search query (e.g., "how to deploy an app", "browser automation examples").',
          ),
      }),
      annotations: {
        title: "search KERNEL documentation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }, ctx) => {
      if (
        !process.env.MINTLIFY_ASSISTANT_API_TOKEN ||
        !process.env.MINTLIFY_DOMAIN
      ) {
        return errorResponse(
          "error: documentation search is not configured (missing MINTLIFY_ASSISTANT_API_TOKEN or MINTLIFY_DOMAIN).",
        );
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
            `search failed: ${searchResponse.status} ${searchResponse.statusText}`,
          );
        }

        const searchResults: MintlifySearchResult[] =
          await searchResponse.json();
        let formatted = "# documentation search results\n\n";

        if (searchResults?.length > 0) {
          searchResults.forEach((result, index) => {
            formatted += `## ${index + 1}. ${result.path}\n\n${result.content}\n\n---\n\n`;
          });
        } else {
          formatted += "no results found for your query.";
        }

        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return errorResponse(
          `error searching documentation: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    },
  );
}
