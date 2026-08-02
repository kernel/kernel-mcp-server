import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createKernelClient } from "@/lib/mcp/kernel-client";
import { toolErrorResponse } from "@/lib/mcp/responses";

const regionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});

type Region = z.infer<typeof regionSchema>;

async function coordinateSpaceText(
  client: ReturnType<typeof createKernelClient>,
  sessionId: string,
  region: Region | undefined,
) {
  if (region) {
    // The image is cropped, so its top-left is the region origin, not the screen
    // origin. Computer actions take screen coordinates, so spell out the offset
    // rather than leaving the model to guess which space it's looking at.
    return `Cropped region ${region.width}x${region.height} at screen offset (${region.x}, ${region.y}). Image coordinates start at the crop, so add the offset to get screen coordinates: screen_x = ${region.x} + image_x, screen_y = ${region.y} + image_y.`;
  }

  const { viewport } = await client.browsers.retrieve(sessionId);
  if (!viewport) {
    return "Could not determine viewport dimensions. Use manage_browsers with action 'get' to check the browser's viewport.";
  }

  return `Full screen ${viewport.width}x${viewport.height}. Image coordinates are screen coordinates.`;
}

export function registerScreenshotTool(server: McpServer) {
  // screenshot -- Capture what a browser session currently shows
  server.tool(
    "screenshot",
    "Capture a PNG screenshot of what a browser session currently displays. Read-only: it observes the session without changing it. Use it to see page state, confirm what an automation did, or diagnose a stuck flow. To act on the page, prefer execute_playwright_code.",
    {
      session_id: z.string().describe("Browser session ID."),
      region: regionSchema
        .describe(
          "Crop to this screen region. Omit to capture the full screen.",
        )
        .optional(),
    },
    {
      title: "Screenshot browser session",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ session_id, region }, extra) => {
      if (!extra.authInfo) throw new Error("Authentication required");
      const client = createKernelClient(extra.authInfo.token);

      try {
        const [screenshotResponse, spaceText] = await Promise.all([
          client.browsers.computer.captureScreenshot(
            session_id,
            region ? { region } : undefined,
          ),
          coordinateSpaceText(client, session_id, region),
        ]);

        const blob = await screenshotResponse.blob();
        const buffer = Buffer.from(await blob.arrayBuffer());

        return {
          content: [
            { type: "text" as const, text: spaceText },
            {
              type: "image" as const,
              data: buffer.toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse("screenshot", "capture", error);
      }
    },
  );
}
