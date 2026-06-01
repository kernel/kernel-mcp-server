import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { errorMessage, textResponse } from "@/lib/mcp/responses";

export function registerExtensionTools(server: McpServer) {
  // manage_extensions -- List and delete browser extensions
  server.tool(
    "manage_extensions",
    'Manage browser extensions uploaded to Kernel. Use "list" to see all extensions available to the current project or "delete" to remove one by ID or name.',
    {
      action: z.enum(["list", "delete"]).describe("Operation to perform."),
      id_or_name: z
        .string()
        .describe("(delete) Extension ID or name to delete.")
        .optional(),
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        switch (params.action) {
          case "list": {
            const extensions = await client.extensions.list();
            return textResponse(
              extensions?.length > 0
                ? JSON.stringify(extensions, null, 2)
                : "No extensions found",
            );
          }
          case "delete": {
            if (!params.id_or_name)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: id_or_name is required for delete.",
                  },
                ],
              };
            await client.extensions.delete(params.id_or_name);
            return textResponse("Extension deleted successfully");
          }
        }
      } catch (error) {
        return textResponse(
          `Error in manage_extensions (${params.action}): ${errorMessage(error)}`,
        );
      }
    },
  );
}
