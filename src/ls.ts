/**
 * `skillforge ls [--from <dir>]` — list installed skills.
 *
 * The natural complement to `install`: discover what's sitting in the
 * user's `~/.claude/skills/` directory, with name + version pulled from
 * each skill's `SKILL.md` frontmatter and an absolute path the reader
 * can `cd` into or feed to a sibling command. Like `npm ls`, but for
 * the Claude skills tree.
 *
 * Behaviour rules and the reasoning behind them:
 *
 *   1. **Discovery is a read-only directory scan.** No fetching, no
 *      network — `ls` only reports what's already on disk. The default
 *      root is `~/.claude/skills/`, matching where `install` writes by
 *      default; `--from <dir>` overrides for tests and alt-trees.
 *
 *   2. **A "skill" is a child directory containing a SKILL.md.** Loose
 *      files in the parent tree are ignored silently — they aren't
 *      skills. Child directories without a SKILL.md are also skipped
 *      silently rather than reported as broken; a half-pulled install
 *      shouldn't pollute every `ls` invocation.
 *
 *   3. **Frontmatter validation gates inclusion by default.** A skill
 *      directory whose `SKILL.md` fails the same `SkillFrontmatterSchema`
 *      that `install` enforces is excluded from the count and the
 *      results array. `--include-invalid` flips that to "include them
 *      with `valid: false` and an `issues` list" — useful when the user
 *      is debugging "why isn't my skill showing up".
 *
 *   4. **Non-existent root → empty result, exit 0.** A fresh machine
 *      with no `~/.claude/skills/` yet is not an error condition; the
 *      answer is "zero installed". This matches what `npm ls` does in
 *      an empty project.
 *
 *   5. **`fromDir` that is a file is a hard error.** The user passed
 *      `--from <something>`; if it's a file rather than a directory,
 *      that's a typo on their end, not "zero skills".
 *
 *   6. **Results are sorted by name ascending.** Stable output is the
 *      whole point of a list command — the order should not depend on
 *      filesystem readdir order, which varies between platforms.
 *
 * No new runtime deps. Reuses `gray-matter` (already on deps from
 * `validate` / `lint` / `inspect`) and `SkillFrontmatterSchema` from
 * `schema.ts`.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { SkillFrontmatterSchema } from "./schema.js";

export interface LsOptions {
  /** Root directory to scan. Defaults to `~/.claude/skills`. */
  fromDir?: string;
  /** Include directories whose SKILL.md fails frontmatter validation. */
  includeInvalid?: boolean;
}

export interface InstalledSkill {
  /** Skill name pulled from SKILL.md frontmatter (or the dir name when invalid). */
  name: string;
  /** Skill version pulled from SKILL.md frontmatter. */
  version: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** Discriminator. Future-proofs the shape for `.skill` archive listings later. */
  source: "dir";
  /** Whether the SKILL.md frontmatter validated cleanly. */
  valid: boolean;
  /** Validation issues. Only present when `!valid` (and `includeInvalid: true`). */
  issues?: string[];
}

export interface LsResult {
  /** Absolute path of the directory that was scanned (post `--from` resolution). */
  fromDir: string;
  /** Number of entries in `skills`. */
  count: number;
  /** Discovered skills, sorted by `name` ascending. */
  skills: InstalledSkill[];
}

/**
 * Scan `fromDir` (default `~/.claude/skills`) for skill directories and
 * return a sorted list of what's installed. Silently treats a missing
 * `fromDir` as "zero installed"; throws a clear error if `fromDir` exists
 * but is a file rather than a directory.
 */
export async function listInstalledSkills(opts: LsOptions = {}): Promise<LsResult> {
  const fromDir = opts.fromDir ?? join(homedir(), ".claude", "skills");
  const includeInvalid = !!opts.includeInvalid;

  // Missing root → empty result. A fresh machine with no `~/.claude/skills/`
  // yet is not an error; the honest answer is "zero installed".
  if (!existsSync(fromDir)) {
    return { fromDir, count: 0, skills: [] };
  }

  const st = await stat(fromDir);
  if (!st.isDirectory()) {
    // The user pointed `--from` at a file. That's a typo on their end, not
    // a zero-skill result — surface it so they can fix the flag.
    throw new Error(`ls: ${fromDir} is not a directory`);
  }

  const entries = await readdir(fromDir, { withFileTypes: true });
  const found: InstalledSkill[] = [];

  for (const ent of entries) {
    // A skill lives at a child *directory* with a SKILL.md at its top.
    // Loose files at the parent level get ignored silently — they aren't
    // skills, and we don't want to bark at every README or .DS_Store.
    if (!ent.isDirectory()) continue;
    const dirPath = resolve(fromDir, ent.name);
    const skillMdPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue; // not a skill dir — skip silently

    const raw = await readFile(skillMdPath, "utf8");
    const parsed = matter(raw);
    const schemaResult = SkillFrontmatterSchema.safeParse(parsed.data);

    if (schemaResult.success) {
      found.push({
        name: schemaResult.data.name,
        version: schemaResult.data.version,
        path: dirPath,
        source: "dir",
        valid: true,
      });
      continue;
    }

    // Invalid SKILL.md — included only when the caller asked for it.
    if (!includeInvalid) continue;
    const issues = schemaResult.error.issues.map(
      (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
    );
    // Reach for any name/version the broken frontmatter does carry; fall
    // back to the directory name and "0.0.0" so the row is still scannable.
    const fmData = (parsed.data ?? {}) as Record<string, unknown>;
    const nameGuess = typeof fmData.name === "string" && fmData.name ? fmData.name : ent.name;
    const versionGuess =
      typeof fmData.version === "string" && fmData.version ? fmData.version : "0.0.0";
    found.push({
      name: nameGuess,
      version: versionGuess,
      path: dirPath,
      source: "dir",
      valid: false,
      issues,
    });
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return { fromDir, count: found.length, skills: found };
}
