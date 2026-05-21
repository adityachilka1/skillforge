/**
 * `skillforge validate [path]` — parse and validate a SKILL.md file.
 *
 * Reports frontmatter issues with line-aware error messages. Designed to be
 * used both interactively and in CI (exit 1 on validation failure).
 */
import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { type SkillFrontmatter, SkillFrontmatterSchema } from "./schema.js";

export interface ValidateResult {
  path: string;
  ok: boolean;
  frontmatter?: SkillFrontmatter;
  bodyLines: number;
  issues: string[];
}

export async function validateSkill(path: string): Promise<ValidateResult> {
  const raw = await readFile(path, "utf8");
  const parsed = matter(raw);

  const issues: string[] = [];
  let frontmatter: SkillFrontmatter | undefined;

  const result = SkillFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    for (const err of result.error.issues) {
      issues.push(`${err.path.join(".") || "<root>"}: ${err.message}`);
    }
  } else {
    frontmatter = result.data;
  }

  // Light body checks — these are warnings, not hard fails.
  const bodyLines = parsed.content.split("\n").length;
  if (bodyLines < 5) {
    issues.push("body is shorter than 5 lines — agents need real instructions, not a placeholder");
  }
  if (parsed.content.includes("TODO")) {
    issues.push("body still contains TODO markers — finish writing the skill before publishing");
  }

  return {
    path,
    ok: issues.length === 0,
    frontmatter,
    bodyLines,
    issues,
  };
}
