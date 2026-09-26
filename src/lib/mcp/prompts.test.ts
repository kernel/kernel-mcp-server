import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerKernelPrompts } from "@/lib/mcp/prompts";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";
import { instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { registerMcpCapabilities } from "@/lib/mcp/register";

const BLOCKED_LANGUAGE =
  /stealth|bot[ _-]?detect|anti-?bot|bot-protected|fingerprint|akamai|cloudflare|imperva|evad|evasion|bypass|scrap|automation detection|unblock|\bsolv/gi;

// Collects human-readable metadata while ignoring schema keys and enum values.
function describedText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(describedText);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "description" || key === "title") && typeof child === "string"
      ? [child]
      : describedText(child),
  );
}

describe("mcp browser positioning", () => {
  test("describes site compatibility with authorization language", async () => {
    const mcp = await connectTestMcp(registerBrowserCapabilities, {});
    try {
      const browser = (await mcp.client.listTools()).tools.find(
        (tool) => tool.name === "manage_browsers",
      );
      const stealth = browser?.inputSchema.properties?.stealth as {
        description?: string;
      };
      expect(stealth.description).toContain("site-compatibility");
      expect(stealth.description).toContain("authorized to access");
    } finally {
      await mcp.close();
    }
  });

  test("keeps advertised descriptions and prompts free of access-evasion language", async () => {
    const mcp = await connectTestMcp((server) => {
      registerMcpCapabilities(server, {
        mcpApps: true,
        vaults: true,
        search: true,
      });
      instrumentMcpAnalytics(server, null);
    }, {});
    try {
      const { tools } = await mcp.client.listTools();
      const { prompts } = await mcp.client.listPrompts();
      const texts = [...describedText(tools), ...describedText(prompts)];
      for (const concept of ["browsers", "apps", "overview"]) {
        texts.push(await promptText("kernel-concepts", { concept }));
      }
      texts.push(
        await promptText("debug-browser-session", {
          session_id: "session_123",
          issue_description: "page fails to load",
        }),
      );

      expect(
        texts.flatMap((text) => text.match(BLOCKED_LANGUAGE) ?? []),
      ).toEqual([]);
    } finally {
      await mcp.close();
    }

    async function promptText(name: string, args: Record<string, string>) {
      const result = await mcp.client.getPrompt({ name, arguments: args });
      const content = result.messages[0].content;
      return content.type === "text" ? content.text : "";
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
