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
 * Accepts three input shapes, mirroring `cat`:
 *   - `.skill` archive  → unzip in memory, materialize SKILL.md to a temp
 *                         file, run validate + lint against it, report.
 *   - directory         → existing behavior: read `<dir>/SKILL.md`, walk
 *                         the directory for the attached-file inventory.
 *   - SKILL.md file     → existing behavior: read directly, no inventory.
 *
 * The archive path reuses `loadSkillContent` from `skill-loader.ts` — same
 * recognition rule (`.skill`/`.zip` extension, or explicit `--from-bundle`
 * with a zip-magic sniff) `cat` already uses, so the three modules agree
 * on what counts as a bundle.
 *
 * No side effects: this command never writes to a user-visible location.
 * Temp files used to drive `validate`/`lint` against archive contents are
 * created in the OS tempdir and cleaned up before the function returns.
 * Composed entirely out of the existing public APIs — no duplicated logic.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { type LintResult, lintSkill } from "./lint.js";
import { shouldExcludeEntry } from "./pack.js";
import { type SkillFrontmatter, SkillFrontmatterSchema } from "./schema.js";
import { type SkillSourceKind, loadSkillContent } from "./skill-loader.js";
import { type ValidateResult, validateSkill } from "./validate.js";

export interface InspectOptions {
  /** Path to a `.skill` archive, a SKILL.md file, or a directory containing one. */
  path: string;
  /**
   * When true, the CLI emits the result as JSON instead of human-readable
   * text. The library returns the same `InspectResult` either way — the
   * option is on the result for stable CLI rendering.
   */
  json?: boolean;
  /**
   * Force archive interpretation regardless of file extension. Useful when
   * a `.skill` bundle has been renamed (`foo.zip`, `foo.bundle`, `foo`).
   * The loader sniffs the first four bytes for the standard zip magic and
   * refuses anything that isn't a real zip.
   */
  fromBundle?: boolean;
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
   * Where the SKILL.md actually came from. `"archive"` for a `.skill`
   * bundle, `"directory"` for a skill folder, `"file"` for a bare
   * SKILL.md. The CLI uses this to print a `Archive: …` / `Directory: …`
   * header so the user can tell which mode they're in.
   */
  source: SkillSourceKind;
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
   * single SKILL.md file or a `.skill` archive. Uses the same exclusion
   * rules as `pack`.
   */
  attachedFiles?: string[];
  summary: InspectSummary;
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
  // Step 1: figure out where the SKILL.md lives. The loader handles all
  // three input shapes and returns a discriminator we can carry into the
  // report and the CLI header.
  const loaded = await loadSkillContent({ path: opts.path, fromBundle: opts.fromBundle });

  // Step 2: drive validate + lint. Both helpers read from a file path, so
  // for archive sources we materialize SKILL.md to a one-off temp file and
  // tear it down before returning. This keeps `validate` / `lint` free of
  // an in-memory branch and means the archive path inherits any future
  // file-mtime checks the lint rules add.
  const fileSource = await resolveFileSource(loaded);
  try {
    const skillFile = fileSource.skillFile;
    const parsed = matter(loaded.raw);

    const [validation, lint] = await Promise.all([validateSkill(skillFile), lintSkill(skillFile)]);

    // The schema parse here is just to pull `name` and the typed frontmatter
    // for the report. Validation issues are already captured in `validation`.
    const schemaResult = SkillFrontmatterSchema.safeParse(parsed.data);
    const frontmatter = schemaResult.success ? schemaResult.data : undefined;
    const name = frontmatter?.name;

    const body = bodyStats(parsed.content);

    let attachedFiles: string[] | undefined;
    if (loaded.kind === "directory") {
      attachedFiles = await listAttachedFiles(loaded.inputPath);
    }

    const lintErrorCount = lint.issues.filter((i) => i.severity === "error").length;
    const summary: InspectSummary = {
      ok: validation.ok && lintErrorCount === 0,
      validationIssues: validation.issues.length,
      lintIssues: lint.issues.length,
    };

    // For archive inputs, report the user's path (foo.skill) rather than
    // the temp-file path — the temp file is an implementation detail. For
    // directory and file inputs, the SKILL.md path is what every other
    // sub-result already references, so we keep that.
    const reportedPath = loaded.kind === "archive" ? resolve(loaded.inputPath) : resolve(skillFile);

    return {
      path: reportedPath,
      source: loaded.kind,
      name,
      frontmatter,
      body,
      validation,
      lint,
      attachedFiles,
      summary,
    };
  } finally {
    if (fileSource.cleanup) {
      await fileSource.cleanup();
    }
  }
}

/**
 * Materialize the loaded SKILL.md to an on-disk path that `validate` and
 * `lint` can consume. For directory and file sources we already have a
 * file; for archives we write a one-off temp file and return a cleanup
 * thunk the caller must invoke.
 */
async function resolveFileSource(loaded: {
  raw: string;
  kind: SkillSourceKind;
  inputPath: string;
  skillFile?: string;
}): Promise<{ skillFile: string; cleanup?: () => Promise<void> }> {
  if (loaded.skillFile && existsSync(loaded.skillFile)) {
    // Sanity-check the path resolves to a file (not a dir we somehow got).
    // stat() throws on race conditions where the file vanished between
    // loader and here — let it propagate as a clear IO error.
    const st = await stat(loaded.skillFile);
    if (st.isFile()) return { skillFile: loaded.skillFile };
  }
  // Archive source: write SKILL.md to a tempdir, hand back a cleanup that
  // removes the whole dir so we don't leak inodes if the lint pass crashes.
  const dir = await mkdtemp(join(tmpdir(), "skillforge-inspect-archive-"));
  const skillFile = join(dir, "SKILL.md");
  await writeFile(skillFile, loaded.raw);
  return {
    skillFile,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
