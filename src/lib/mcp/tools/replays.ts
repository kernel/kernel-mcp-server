import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import {
  errorResponse,
  itemsJsonResponse,
  jsonResponse,
  textResponse,
  toolErrorResponse,
} from "@/lib/mcp/responses";

export function registerReplayTools(server: McpServer) {
  // manage_replays -- Start, stop, and list video replay recordings for a session
  server.tool(
    "manage_replays",
    'Manage video replay recordings for a browser session. Use "start" to begin recording a session (returns a replay_id and a viewable URL), "stop" to end a recording and persist the video, or "list" to see all replays for a session with their view URLs. Recording is session-scoped: start once, run your automation, then stop -- rather than recording each action separately. Requires a paid Kernel plan; not available on the free tier.',
    {
      action: z
        .enum(["start", "stop", "list"])
        .describe("Operation to perform."),
      session_id: z.string().describe("Browser session ID."),
      replay_id: z.string().describe("(stop) Replay ID to stop.").optional(),
      framerate: z
        .number()
        .int()
        .min(1)
        .describe(
          "(start) Recording framerate in fps. Values above 20 require GPU to be enabled on the session.",
        )
        .optional(),
      max_duration_in_seconds: z
        .number()
        .int()
        .min(1)
        .describe("(start) Maximum recording duration in seconds.")
        .optional(),
      record_audio: z
        .boolean()
        .describe(
          "(start) Record audio in addition to video. Defaults to video-only.",
        )
        .optional(),
    },
    {
      title: "Manage browser session replays",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

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
              return errorResponse("Error: replay_id is required for stop.");
            await client.browsers.replays.stop(params.replay_id, {
              id: params.session_id,
            });
            return textResponse("Replay stopped successfully");
          }
          case "list": {
            const replays = await client.browsers.replays.list(
              params.session_id,
            );
            return itemsJsonResponse(replays, {
              emptyText: "No replays found for this session",
            });
          }
        }
      } catch (error) {
        return toolErrorResponse("manage_replays", params.action, error);
      }
    },
  );
}
