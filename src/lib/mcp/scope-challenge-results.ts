import type { McpServer } from "@modelcontextprotocol/server";
import { errorResponse } from "@/lib/mcp/responses";
import { oauthResourceMetadataUrl } from "@/lib/oauth-discovery";
import { mcpScopeChallenge, scopeChallengeOf } from "@/lib/scope-challenge";

const WWW_AUTHENTICATE_META = "mcp/www_authenticate";

// The API names the missing actions in the error body.
function reconnectNote(cause: unknown): string {
  const body = (cause as { error?: { missing_scopes?: unknown } }).error;
  const missing = Array.isArray(body?.missing_scopes)
    ? body.missing_scopes.filter((scope) => typeof scope === "string")
    : [];
  const what = missing.length > 0 ? missing.join(", ") : "this permission";
  return `Signing in again can grant ${what}: ask the user to reconnect the KERNEL MCP server and allow it.`;
}

type ToolCallback = (...params: unknown[]) => unknown;

// A tool call the Kernel API refuses for a permission that signing in again
// can grant has already started, so this server cannot answer it with an
// HTTP 403 challenge: a client retrying the call could repeat work it already
// did. It fails as a tool error instead, carrying the challenge in
// _meta["mcp/www_authenticate"] for clients that step up from tool results.
export function returnScopeChallenges(server: McpServer) {
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    callback: ToolCallback,
  ) => unknown;
  server.registerTool = ((
    name: string,
    config: unknown,
    callback: ToolCallback,
  ) =>
    registerTool(name, config, async (...params: unknown[]) => {
      try {
        return await callback(...params);
      } catch (error) {
        const challenge =
          error instanceof Error ? scopeChallengeOf(error.cause) : null;
        if (!challenge) throw error;
        // Name the metadata of the host the client connected to, as the
        // transport's own challenges do.
        const req = (params.at(-1) as { http?: { req?: Request } } | undefined)
          ?.http?.req;
        return {
          ...errorResponse(
            `${(error as Error).message} ${reconnectNote((error as Error).cause)}`,
          ),
          _meta: {
            [WWW_AUTHENTICATE_META]: [
              mcpScopeChallenge(
                challenge,
                req ? oauthResourceMetadataUrl(req) : undefined,
              ),
            ],
          },
        };
      }
    })) as McpServer["registerTool"];
}
