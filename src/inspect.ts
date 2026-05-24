/**
 * `skillforge inspect <path>` — one-shot diagnostic report for a SKILL.md.
 *
 * Eighth piece of the authoring workflow after `init`, `validate`, `lint`,
 * `update`, `format`, `pack`, `install`. Where the others *do* one thing,
 * `inspect` *reads* — it rolls validation, linting, frontmatter parsing,
 * body stats, and (for directory inputs) the file inventory into one
 * structured report. Useful for "what is this skill, really?" inspection
 * and for CI summaries via `--json`.
 *
 * No side effects: this command never writes to disk. Composed entirely
 * out of the existing public APIs (`validateSkill`, `lintSkill`,
 * `shouldExcludeEntry`) — no duplicated logic.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { type LintResult, lintSkill } from "./lint.js";
import { shouldExcludeEntry } from "./pack.js";
import { type SkillFrontmatter, SkillFrontmatterSchema } from "./schema.js";
import { type ValidateResult, validateSkill } from "./validate.js";

export interface InspectOptions {
  /** Path to a SKILL.md file or a directory containing one. */
  path: string;
  /**
   * When true, the CLI emits the result as JSON instead of human-readable
   * text. The library returns the same `InspectResult` either way — the
   * option is on the result for stable CLI rendering.
   */
  json?: boolean;
}

export interface InspectBodyStats {
  /** Number of `\n`-separated lines in the body. */
  lines: number;
  /** Number of UTF-16 code units (matches `String.length`). */
  characters: number;
  /** Whitespace-split word count. */
  words: number;
  /** Names of every `## heading` (level-2 only) found in the body, in order. */
  sections: string[];
}

export interface InspectSummary {
  /** True iff validation passed AND lint produced no `error`-severity issues. */
  ok: boolean;
  validationIssues: number;
  lintIssues: number;
}

export interface InspectResult {
  /** Path of the SKILL.md file inspected (absolute or as the user passed it). */
  path: string;
  /**
   * Skill name pulled from frontmatter, if the file parsed at all. May be
   * `undefined` for unparseable inputs — the rest of the report will still
   * surface the validation failure.
   */
  name?: string;
  /** Validated frontmatter (zod-parsed). `undefined` if validation failed. */
  frontmatter?: SkillFrontmatter;
  /** Body stats — always present, computed even when validation fails. */
  body: InspectBodyStats;
  /** Full validation result, delegated to `validateSkill`. */
  validation: ValidateResult;
  /** Full lint result, delegated to `lintSkill`. */
  lint: LintResult;
  /**
   * If the input path resolved to a directory, every non-excluded file
   * (POSIX-relative to the directory). `undefined` when the input was a
   * single SKILL.md file. Uses the same exclusion rules as `pack`.
   */
  attachedFiles?: string[];
  summary: InspectSummary;
}

/**
 * Resolve the input path to a `{ skillFile, rootDir }` pair.
 *  - File: `rootDir` is undefined; `attachedFiles` is not produced.
 *  - Directory: must contain a SKILL.md; `rootDir` is the directory.
 */
async function resolveInput(inputPath: string): Promise<{ skillFile: string; rootDir?: string }> {
  if (!existsSync(inputPath)) {
    throw new Error(`inspect: ${inputPath} does not exist`);
  }
  const st = await stat(inputPath);
  if (st.isDirectory()) {
    const candidate = join(inputPath, "SKILL.md");
    if (!existsSync(candidate)) {
      throw new Error(`inspect: ${inputPath} does not contain a SKILL.md`);
    }
    return { skillFile: candidate, rootDir: inputPath };
  }
  return { skillFile: inputPath };
}

/**
 * Walk `rootDir` and return every non-excluded file as a POSIX-style path
 * relative to `rootDir`. Reuses the same exclusion rule as `packSkill` so
 * `inspect` and `pack` agree on which files belong to the skill.
 */
async function listAttachedFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  await walk(rootDir, rootDir, results);
  results.sort();
  return results;
}

async function walk(rootDir: string, currentDir: string, out: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExcludeEntry(entry.name)) continue;
    const abs = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(rootDir, abs, out);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks / sockets / fifos
    out.push(relative(rootDir, abs).split(sep).join("/"));
  }
}

/**
 * Pull the names of every level-2 (`## heading`) section from the body, in
 * document order. We deliberately ignore `#` (title) and `### …` (subsection)
 * because skill bodies use `##` for the major narrative sections (`## When
 * to use`, `## Examples`, …) and those are what users want to scan.
 */
function extractSections(body: string): string[] {
  const sections: string[] = [];
  const lines = body.split("\n");
  let inFence = false;
  const fenceRe = /^\s{0,3}(```+|~~~+)/;
  for (const line of lines) {
    if (fenceRe.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) sections.push(m[1]);
  }
  return sections;
}

function bodyStats(body: string): InspectBodyStats {
  return {
    lines: body.split("\n").length,
    characters: body.length,
    // Whitespace split, drop empty tokens — matches the intuitive "how many
    // words is this" count.
    words: body.split(/\s+/).filter((w) => w.length > 0).length,
    sections: extractSections(body),
  };
}

export async function inspectSkill(opts: InspectOptions): Promise<InspectResult> {
  const { skillFile, rootDir } = await resolveInput(opts.path);

  // Read once, derive everything else. We re-read inside validateSkill /
  // lintSkill — a small cost for a clean delegation. The alternative
  // (passing pre-parsed state around) would couple us to those modules'
  // internals.
  const raw = await readFile(skillFile, "utf8");
  const parsed = matter(raw);

  const [validation, lint] = await Promise.all([validateSkill(skillFile), lintSkill(skillFile)]);

  // The schema parse here is just to pull `name` and the typed frontmatter
  // for the report. Validation issues are already captured in `validation`.
  const schemaResult = SkillFrontmatterSchema.safeParse(parsed.data);
  const frontmatter = schemaResult.success ? schemaResult.data : undefined;
  const name = frontmatter?.name;

  const body = bodyStats(parsed.content);

  let attachedFiles: string[] | undefined;
  if (rootDir) {
    attachedFiles = await listAttachedFiles(rootDir);
  }

  const lintErrorCount = lint.issues.filter((i) => i.severity === "error").length;
  const summary: InspectSummary = {
    ok: validation.ok && lintErrorCount === 0,
    validationIssues: validation.issues.length,
    lintIssues: lint.issues.length,
  };

  // `path` is intentionally the resolved SKILL.md — that's what every other
  // sub-result already references, and it's the file the user actually
  // wants to know about.
  return {
    path: resolve(skillFile),
    name,
    frontmatter,
    body,
    validation,
    lint,
    attachedFiles,
    summary,
  };
}
