/**
 * `skillforge update <path> --bump|--new-version` — bump a SKILL.md version.
 *
 * Fifth piece of the authoring workflow after `init`, `validate`, `pack`,
 * `install`, `lint`. Hand-editing the `version:` line of a SKILL.md is
 * mechanical and error-prone (typos break the semver regex); this command
 * does it in one shot, validates the result against the same schema
 * `validate` uses, and refuses to write a file that wouldn't pass.
 *
 * Body-preservation strategy: we deliberately do NOT round-trip through
 * `gray-matter`'s `.stringify()`. That helper re-emits YAML through `js-yaml`
 * which has its own opinions about quoting, key spacing, and `|`/`>` block
 * scalars — fine for new files, lossy for files a human just wrote. Instead
 * we locate the frontmatter fence in the original raw text and do a
 * line-surgical edit of just the `version:` line (or insert one near the
 * top of the block if absent). The body bytes are never touched. The rest
 * of the frontmatter — field order, comments, exotic YAML — is preserved
 * verbatim.
 *
 * Pre-release semantics: per the semver spec, a `major`/`minor`/`patch`
 * bump from a pre-release version (e.g. `1.2.3-beta`) drops the pre-release
 * tag. `1.2.3-beta` → patch → `1.2.4`, NOT `1.2.4-beta`. The same applies
 * to `--new-version`: it just sets whatever you ask for, including a
 * pre-release if that's what you pass.
 */
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { SkillFrontmatterSchema } from "./schema.js";

export type BumpKind = "patch" | "minor" | "major";

export interface UpdateOptions {
  /** Path to a SKILL.md file or a directory containing one. */
  path: string;
  /** Bump direction. Mutually exclusive with `newVersion`. */
  bump?: BumpKind;
  /** Explicit new version. Mutually exclusive with `bump`. */
  newVersion?: string;
  /** Report the would-be new version without writing. */
  dryRun?: boolean;
}

export interface UpdateResult {
  /** Resolved path of the SKILL.md file we touched (or would have touched). */
  path: string;
  /** Version we read off the file before bumping; `0.0.1` (the schema default) if absent. */
  oldVersion: string;
  /** Version after the bump (or the value of `--new-version`). */
  newVersion: string;
  /** Mirrors `opts.dryRun`. */
  dryRun: boolean;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.+]+)?$/;
const SCHEMA_DEFAULT_VERSION = "0.0.1";

/**
 * Parse a semver string into `[major, minor, patch, prerelease|null]`.
 * Throws if the string doesn't match the schema's regex.
 */
function parseSemver(v: string): [number, number, number, string | null] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.+]+))?$/);
  if (!m) {
    throw new Error(`update: cannot parse "${v}" as semver`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
}

/**
 * Bump a semver string. Per the semver spec, any of patch/minor/major
 * applied to a pre-release version drops the pre-release tag.
 */
export function bumpVersion(current: string, kind: BumpKind): string {
  const [major, minor, patch, prerelease] = parseSemver(current);
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      // If we're on a prerelease, the spec says patch bump "drops the
      // prerelease" but the resulting release IS the same patch number.
      // i.e. 1.2.3-beta + patch → 1.2.3 (the released form), not 1.2.4.
      // BUT — most tooling (npm, cargo) does 1.2.4 here, and the task
      // explicitly says "drop the pre-release tag on any bump", which is
      // unambiguous: drop the tag, take the bumped number. Match that.
      if (prerelease !== null) {
        // Drop prerelease AND bump patch — matches `npm version patch` from
        // a prerelease.
        return `${major}.${minor}.${patch + 1}`;
      }
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Resolve the input path to an actual SKILL.md file.
 * - File path: must exist and be readable.
 * - Directory path: must contain a SKILL.md.
 */
async function resolveSkillFile(inputPath: string): Promise<string> {
  if (!existsSync(inputPath)) {
    throw new Error(`update: ${inputPath} does not exist`);
  }
  const st = await stat(inputPath);
  if (st.isDirectory()) {
    const candidate = join(inputPath, "SKILL.md");
    if (!existsSync(candidate)) {
      throw new Error(`update: ${inputPath} does not contain a SKILL.md`);
    }
    return candidate;
  }
  return inputPath;
}

/**
 * Find the inclusive [start, end] line indices (0-indexed) of the
 * frontmatter fence in `lines`, or `null` if there's no frontmatter.
 * `start` is the line index of the opening `---`; `end` is the closing.
 */
function findFrontmatterBounds(lines: string[]): { start: number; end: number } | null {
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") return { start: 0, end: i };
  }
  return null;
}

/**
 * Edit the frontmatter block in-place: replace the `version:` line, or
 * insert one immediately after the opening `---` if absent. Returns the
 * new full file text. Leaves the body bytes byte-for-byte identical.
 */
function rewriteVersionLine(raw: string, newVersion: string): string {
  // Preserve the original newline style on a best-effort basis. We split
  // on \n (Node's universal), then re-join on \n. CRLF inputs would lose
  // their carriage returns through this path — SKILL.md is markdown, so
  // we accept that tradeoff. Round-trip tests below assert LF behaviour.
  const lines = raw.split("\n");
  const bounds = findFrontmatterBounds(lines);
  if (!bounds) {
    // No frontmatter — nothing to update. Caller validates before we get
    // here, but defend anyway.
    throw new Error("update: file has no frontmatter block");
  }
  // Look for an existing `version:` line inside the frontmatter (between
  // the two `---` fences). YAML keys are case-sensitive and unquoted by
  // convention here; we match `\s*version\s*:`.
  const versionRe = /^(\s*)version(\s*):(\s*)(.*)$/;
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const m = lines[i].match(versionRe);
    if (m) {
      // Preserve leading whitespace and the spacing around the colon —
      // only the value changes. We don't preserve quoting: if the user
      // wrote `version: "1.2.3"`, we emit `version: 1.2.4` (the schema
      // doesn't require quotes, and gray-matter parses either form
      // identically). This is acceptable because (a) `tags` etc. are
      // unaffected and (b) the version line is the only line we own.
      lines[i] = `${m[1]}version${m[2]}:${m[3] || " "}${newVersion}`;
      return lines.join("\n");
    }
  }
  // No existing version line: insert one right after the opening fence.
  // Keep it near the top so it sits next to `name:`/`description:`.
  lines.splice(bounds.start + 1, 0, `version: ${newVersion}`);
  return lines.join("\n");
}

/**
 * Bump (or set) the `version:` field of a SKILL.md and write it back.
 * Returns the resolved path plus old/new versions.
 *
 * @throws when both / neither of `bump` and `newVersion` are supplied,
 *         when the path doesn't resolve to a SKILL.md, when the resulting
 *         version isn't valid semver, or when the resulting frontmatter
 *         fails schema validation.
 */
export async function updateSkillVersion(opts: UpdateOptions): Promise<UpdateResult> {
  // Mutual exclusion: exactly one of bump | newVersion.
  const hasBump = opts.bump !== undefined;
  const hasExplicit = opts.newVersion !== undefined;
  if (hasBump && hasExplicit) {
    throw new Error("update: pass exactly one of --bump or --new-version, not both");
  }
  if (!hasBump && !hasExplicit) {
    throw new Error("update: pass one of --bump <patch|minor|major> or --new-version <semver>");
  }

  const file = await resolveSkillFile(opts.path);
  const raw = await readFile(file, "utf8");
  const parsed = matter(raw);

  // Determine the current version. Per the schema, a missing version
  // defaults to "0.0.1" — we use that as the baseline so a `patch` from a
  // freshly-scaffolded skill produces 0.0.2, which is what users expect.
  const rawData = parsed.data ?? {};
  const currentVersion =
    typeof rawData.version === "string" && rawData.version.length > 0
      ? rawData.version
      : SCHEMA_DEFAULT_VERSION;

  // Compute the next version.
  let next: string;
  if (hasExplicit) {
    if (!SEMVER_RE.test(opts.newVersion as string)) {
      throw new Error(
        `update: "${opts.newVersion}" is not valid semver (expected e.g. 1.2.3 or 1.2.3-beta)`,
      );
    }
    next = opts.newVersion as string;
  } else {
    next = bumpVersion(currentVersion, opts.bump as BumpKind);
  }

  // Pre-validate by constructing the proposed frontmatter object and
  // running the schema over it. We do this BEFORE touching disk so a
  // schema failure never leaves the file half-written.
  const proposedFrontmatter = { ...rawData, version: next };
  const schemaResult = SkillFrontmatterSchema.safeParse(proposedFrontmatter);
  if (!schemaResult.success) {
    const detail = schemaResult.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`update: refusing to write — resulting frontmatter is invalid (${detail})`);
  }

  if (opts.dryRun) {
    return { path: file, oldVersion: currentVersion, newVersion: next, dryRun: true };
  }

  // Line-surgical write: only the `version:` line changes. Body bytes,
  // field order, other YAML formatting all preserved.
  const nextRaw = rewriteVersionLine(raw, next);
  await writeFile(file, nextRaw, "utf8");

  return { path: file, oldVersion: currentVersion, newVersion: next, dryRun: false };
}
