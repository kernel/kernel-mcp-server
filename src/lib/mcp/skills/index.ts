import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { BUNDLED_SKILLS } from "@/lib/mcp/skills/generated/skills";
import type { BundledSkill } from "@/lib/mcp/skills/types";

export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

// Bundled skills only change on deploy, so every caller may share a cached listing.
const SKILLS_CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: "public" } as const;

function skillFileUri(skill: BundledSkill, path: string) {
  return `skill://${skill.name}/${path}`;
}

function skillEntry(skill: BundledSkill) {
  return {
    uri: skillFileUri(skill, "SKILL.md"),
    frontmatter: skill.frontmatter,
    resources: skill.files.map((file) => ({
      uri: skillFileUri(skill, file.path),
      digest: file.digest,
      size: file.size,
    })),
  };
}

/**
 * Serves the bundled skills through the MCP Skills extension (SEP-2640):
 * skills/list and skills/get return each skill's manifest, and every file is a
 * skill:// resource read with resources/read.
 */
export function registerSkills(
  server: McpServer,
  skills: BundledSkill[] = BUNDLED_SKILLS,
) {
  server.server.registerCapabilities({
    resources: {},
    extensions: { [MCP_SKILLS_EXTENSION]: {} },
  });

  for (const skill of skills) {
    for (const file of skill.files) {
      const uri = skillFileUri(skill, file.path);
      const isSkillFile = file.path === "SKILL.md";
      server.registerResource(
        isSkillFile ? skill.name : `${skill.name}/${file.path}`,
        uri,
        {
          mimeType: file.mimeType,
          ...(isSkillFile && { description: skill.frontmatter.description }),
        },
        async () => ({
          contents: [
            "text" in file
              ? { uri, mimeType: file.mimeType, text: file.text }
              : { uri, mimeType: file.mimeType, blob: file.blob },
          ],
        }),
      );
    }
  }

  server.server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.string().optional() }).passthrough() },
    async () => ({ skills: skills.map(skillEntry), ...SKILLS_CACHE }),
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }).passthrough() },
    async ({ uri }) => {
      const skill = skills.find(
        (candidate) => skillFileUri(candidate, "SKILL.md") === uri,
      );
      if (!skill) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `unknown skill: ${uri}`,
        );
      }
      return { skill: skillEntry(skill), ...SKILLS_CACHE };
    },
  );
}
