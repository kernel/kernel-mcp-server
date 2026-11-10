import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  textResponse,
  throwToolError,
} from "@/lib/mcp/responses";
import {
  projectForOperation,
  projectSelectionInputSchema,
} from "@/lib/mcp/project-selection";

export function registerReplayTools(server: McpServer) {
  // manage_replays -- Start, stop, and list video replay recordings for a session
  server.registerTool(
    "manage_replays",
    {
      description:
        'manage video replay recordings for a browser session. use "start" to begin recording a session (returns a replay_id and a viewable url), "stop" to end a recording and persist the video, or "list" to see all replays for a session with their view urls. recording is session-scoped: start once, run your automation, then stop -- rather than recording each action separately. requires a paid KERNEL plan; not available on the free tier.',
      inputSchema: z.object({
        ...projectSelectionInputSchema(),
        action: z
          .enum(["start", "stop", "list"])
          .describe("operation to perform."),
        session_id: z.string().describe("browser session id or name."),
        replay_id: z.string().describe("(stop) replay id to stop.").optional(),
        framerate: z
          .number()
          .int()
          .min(1)
          .describe(
            "(start) recording framerate in fps. values above 20 require gpu to be enabled on the session.",
          )
          .optional(),
        max_duration_in_seconds: z
          .number()
          .int()
          .min(1)
          .describe("(start) maximum recording duration in seconds.")
          .optional(),
        record_audio: z
          .boolean()
          .describe(
            "(start) record audio in addition to video. defaults to video-only.",
          )
          .optional(),
      }),
      annotations: {
        title: "manage browser session replays",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params, ctx) => {
      if (!ctx.http?.authInfo) throw new Error("authentication required");
      const client = createKernelClient(
        ctx.http.authInfo.token,
        projectForOperation(ctx.http.authInfo, params),
      );

      try {
        switch (params.action) {
          case "start": {
            const body = {
              ...(params.framerate !== undefined && {
                framerate: params.framerate,
              }),
              ...(params.max_duration_in_seconds !== undefined && {
                max_duration_in_seconds: params.max_duration_in_seconds,
              }),
              ...(params.record_audio !== undefined && {
                record_audio: params.record_audio,
              }),
            };
            const replay = await client.browsers.replays.start(
              params.session_id,
              Object.keys(body).length > 0 ? body : undefined,
            );
            return jsonResponse(replay);
          }
          case "stop": {
            if (!params.replay_id)
              return errorResponse("error: replay_id is required for stop.");
            await client.browsers.replays.stop(params.replay_id, {
              id_or_name: params.session_id,
            });
            return textResponse("replay stopped successfully");
          }
          case "list": {
            const replays = await client.browsers.replays.list(
              params.session_id,
            );
            return itemsJsonResponse(replays, {
              emptyText: "no replays found for this session",
            });
          }
        }
      } catch (error) {
        throwToolError("manage_replays", params.action, error);
      }
    },
  );
}
