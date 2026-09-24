import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerKernelPrompts } from "@/lib/mcp/prompts";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";

describe("mcp browser positioning", () => {
  test("describes stealth without recommending a scraping use case or promising access", async () => {
    const mcp = await connectTestMcp(registerBrowserCapabilities, {});
    try {
      const browser = (await mcp.client.listTools()).tools.find(
        (tool) => tool.name === "manage_browsers",
      );
      const stealth = browser?.inputSchema.properties?.stealth as {
        description?: string;
      };
      expect(stealth.description).toContain("site access is not guaranteed");
      expect(stealth.description).not.toMatch(/scrap|avoid bot detection/i);
    } finally {
      await mcp.close();
    }
  });

  test.each(["browsers", "apps", "overview"])(
    "keeps the %s concept prompt focused on browser workflows",
    async (concept) => {
      const mcp = await connectTestMcp(registerKernelPrompts, {});
      try {
        const result = await mcp.client.getPrompt({
          name: "kernel-concepts",
          arguments: { concept },
        });
        const text = result.messages[0].content;
        expect(text.type).toBe("text");
        if (text.type !== "text") return;
        expect(text.text).toContain("KERNEL");
        expect(text.text).not.toMatch(
          /scrap|crazy fast|perfect for|seamless|🚀|🌐|🎯/i,
        );
      } finally {
        await mcp.close();
      }
    },
  );
});
