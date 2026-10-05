import { describe, expect, test } from "bun:test";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { registerKernelPrompts } from "@/lib/mcp/prompts";
import { registerBrowserCapabilities } from "@/lib/mcp/tools/browsers";
import { instrumentMcpAnalytics } from "@/lib/mcp/analytics";
import { registerMcpCapabilities } from "@/lib/mcp/register";

const BLOCKED_LANGUAGE =
  /stealth|bot[ _-]?detect|anti-?bot|bot-protected|fingerprint|akamai|cloudflare|imperva|evad|evasion|bypass|scrap|automation detection|unblock|\bsolv/gi;

// Parameter names and enum values are held to the same standard, except these
// names, which map directly to KERNEL API fields.
const BLOCKED_NAMES = new RegExp(`${BLOCKED_LANGUAGE.source}|captcha`, "i");
const API_FIELD_NAMES = new Set([
  "manage_browsers:stealth",
  "manage_browsers:captcha",
  "manage_browser_pools:stealth",
  "manage_auth_connections:browser_stealth",
  "manage_auth_connections:stealth",
  "open_auth_login:stealth",
  "begin_auth_login:stealth",
  "manage_proxies:bypass_hosts",
  "manage_auth_connections:captcha",
  "open_auth_login:captcha",
  "begin_auth_login:captcha",
  "submit_feedback:stealth",
]);

function describedText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(describedText);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "description" || key === "title") && typeof child === "string"
      ? [child]
      : describedText(child),
  );
}

function schemaNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaNames);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === "properties" && child && typeof child === "object"
      ? Object.keys(child)
      : []),
    ...(key === "enum" && Array.isArray(child)
      ? child.filter((item): item is string => typeof item === "string")
      : []),
    ...schemaNames(child),
  ]);
}

function connectAdvertisedMcp() {
  return connectTestMcp((server) => {
    registerMcpCapabilities(server, {
      mcpApps: true,
      vaults: true,
      search: true,
    });
    instrumentMcpAnalytics(server, null);
  }, {});
}

async function advertisedTexts(
  mcp: Awaited<ReturnType<typeof connectAdvertisedMcp>>,
) {
  const promptText = async (name: string, args: Record<string, string>) => {
    const result = await mcp.client.getPrompt({ name, arguments: args });
    const content = result.messages[0].content;
    return content.type === "text" ? content.text : "";
  };
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
  return texts;
}

// Removes the machine-readable parts of advertised prose: code, quoted literal
// values, URLs, paths, and constant-style identifiers such as env vars and
// error codes.
function stripLiterals(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(?<![\w.])\/[\w\-.{}:/*]+/g, "")
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, "")
    .replace(/\bKERNEL\b/g, "");
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

  test("keeps advertised metadata and prompts free of access-evasion language", async () => {
    const mcp = await connectAdvertisedMcp();
    try {
      const { tools } = await mcp.client.listTools();
      const texts = await advertisedTexts(mcp);

      expect(
        texts.flatMap((text) => text.match(BLOCKED_LANGUAGE) ?? []),
      ).toEqual([]);
      expect(
        tools.flatMap((tool) =>
          schemaNames([tool.inputSchema, tool.outputSchema])
            .map((name) => `${tool.name}:${name}`)
            .filter(
              (entry) =>
                BLOCKED_NAMES.test(entry.split(":")[1]) &&
                !API_FIELD_NAMES.has(entry),
            ),
        ),
      ).toEqual([]);
    } finally {
      await mcp.close();
    }
  });

  test("keeps advertised metadata and prompts in brand casing", async () => {
    const mcp = await connectAdvertisedMcp();
    try {
      const prose = (await advertisedTexts(mcp)).map(stripLiterals);

      expect(prose.flatMap((text) => text.match(/\S*[A-Z]\S*/g) ?? [])).toEqual(
        [],
      );
      expect(prose.flatMap((text) => text.match(/\bkernel\b/g) ?? [])).toEqual(
        [],
      );
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
