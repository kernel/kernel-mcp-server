export type BundledSkillFile = {
  path: string;
  mimeType: string;
  size: number;
  digest: string;
} & ({ text: string } | { blob: string });

export type BundledSkill = {
  name: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  files: BundledSkillFile[];
};
