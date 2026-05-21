import { existsSync } from "node:fs";
/**
 * `skillforge init <name>` — scaffold a new Claude Skill.
 *
 * Creates `<name>/SKILL.md` with sensible-default frontmatter and a stub
 * body. Refuses to overwrite if the file already exists, unless `--force`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import kleur from "kleur";

export interface InitOptions {
  name: string;
  outputDir?: string;
  force?: boolean;
}

const SKILL_MD_TEMPLATE = (name: string) => `---
name: ${name}
description: |
  TODO — write 1–2 sentences explaining when the agent should use this skill.
  Write it from the agent's perspective: "Use this when the user asks about X."
  Avoid marketing copy. Be specific.
version: 0.0.1
tags: []
---

# ${name}

## What this skill does

TODO — explain the skill's purpose in 1 paragraph.

## When to use it

TODO — concrete trigger phrases or topics. The agent reads this to decide
whether to invoke the skill.

## Instructions

TODO — step-by-step instructions for the agent. Be precise. The agent
executes literally; don't write "be friendly" — write "open with a single
sentence acknowledgement, then ask one clarifying question if needed."

## Examples

\`\`\`
User: <example input>
Agent: <expected behaviour>
\`\`\`
`;

export async function initSkill(opts: InitOptions): Promise<string> {
  const dir = resolve(opts.outputDir ?? process.cwd(), opts.name);
  const file = join(dir, "SKILL.md");

  if (existsSync(file) && !opts.force) {
    throw new Error(`${kleur.red("error:")} ${file} already exists. Pass --force to overwrite.`);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(file, SKILL_MD_TEMPLATE(opts.name), "utf8");
  return file;
}
