import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { connectTestMcp } from "@/lib/mcp/mcp-test-fixtures";
import { MCP_SKILLS_EXTENSION, registerSkills } from "@/lib/mcp/skills";
import { BUNDLED_SKILLS } from "@/lib/mcp/skills/generated/skills";
import type { BundledSkill } from "@/lib/mcp/skills/types";

const SkillEntry = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.array(
    z.object({ uri: z.string(), digest: z.string(), size: z.number() }),
  ),
});
const ListSkillsResult = z.object({
  skills: z.array(SkillEntry),
  ttlMs: z.number(),
  cacheScope: z.string(),
});
const GetSkillResult = z.object({ skill: SkillEntry });

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
const fixtureSkill: BundledSkill = {
  name: "example",
  frontmatter: { name: "example", description: "an example", license: "MIT" },
  files: [
    {
      path: "SKILL.md",
      mimeType: "text/markdown",
      size: 9,
      digest: `sha256:${createHash("sha256").update("# example").digest("hex")}`,
      text: "# example",
    },
    {
      path: "assets/logo.png",
      mimeType: "image/png",
      size: pngBytes.byteLength,
      digest: `sha256:${createHash("sha256").update(pngBytes).digest("hex")}`,
      blob: Buffer.from(pngBytes).toString("base64"),
    },
  ],
};

function frontmatterOf(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match ? Bun.YAML.parse(match[1]) : null;
}

describe("skills extension", () => {
  test("advertises the extension and lists bundled skills with complete manifests", async () => {
    const mcp = await connectTestMcp((server) => registerSkills(server), {});
    try {
      expect(
        mcp.client.getServerCapabilities()?.extensions?.[MCP_SKILLS_EXTENSION],
      ).toEqual({});

      const { skills, ttlMs, cacheScope } = await mcp.client.request(
        { method: "skills/list", params: {} },
        ListSkillsResult,
      );
      expect(skills.map((skill) => skill.uri)).toEqual(
        BUNDLED_SKILLS.map((skill) => `skill://${skill.name}/SKILL.md`),
      );
      expect(ttlMs).toBeGreaterThan(0);
      expect(cacheScope).toBe("public");

      for (const skill of skills) {
        expect(skill.uri.split("/").at(-2)).toBe(
          skill.frontmatter.name as string,
        );
        for (const resource of skill.resources) {
          const { contents } = await mcp.client.readResource({
            uri: resource.uri,
          });
          const content = contents[0];
          const bytes =
            "text" in content
              ? new TextEncoder().encode(content.text)
              : Buffer.from(content.blob, "base64");
          expect(bytes.byteLength).toBe(resource.size);
          expect(resource.digest).toBe(
            `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          );
          if (resource.uri === skill.uri && "text" in content) {
            expect(frontmatterOf(content.text)).toEqual(skill.frontmatter);
          }
        }
      }
    } finally {
      await mcp.close();
    }
  });

  test("serves supporting files, including binary ones, and gets skills by uri", async () => {
    const mcp = await connectTestMcp(
      (server) => registerSkills(server, [fixtureSkill]),
      {},
    );
    try {
      const { skill } = await mcp.client.request(
        {
          method: "skills/get",
          params: { uri: "skill://example/SKILL.md" },
        },
        GetSkillResult,
      );
      expect(skill.frontmatter).toEqual(fixtureSkill.frontmatter);
      expect(skill.resources.map((resource) => resource.uri)).toEqual([
        "skill://example/SKILL.md",
        "skill://example/assets/logo.png",
      ]);

      const { contents } = await mcp.client.readResource({
        uri: "skill://example/assets/logo.png",
      });
      expect(contents[0]).toMatchObject({
        mimeType: "image/png",
        blob: Buffer.from(pngBytes).toString("base64"),
      });

      const { resources } = await mcp.client.listResources();
      expect(resources).toContainEqual(
        expect.objectContaining({
          uri: "skill://example/SKILL.md",
          name: "example",
          description: "an example",
          mimeType: "text/markdown",
        }),
      );

      await expect(
        mcp.client.request(
          {
            method: "skills/get",
            params: { uri: "skill://missing/SKILL.md" },
          },
          GetSkillResult,
        ),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await mcp.close();
    }
  });

  test("advertises the extension through server/discover", async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerSkills(server);
      return server;
    });
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init), {}),
      }),
    );
    try {
      expect(
        client.getServerCapabilities()?.extensions?.[MCP_SKILLS_EXTENSION],
      ).toEqual({});
      const { skills } = await client.request(
        { method: "skills/list", params: {} },
        ListSkillsResult,
      );
      expect(skills.map((skill) => skill.frontmatter.name)).toContain(
        "kernel-mcp",
      );
    } finally {
      await client.close();
    }
  });
});
