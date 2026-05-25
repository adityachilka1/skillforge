/**
 * `skillforge cat <skill>` — print the bundled SKILL.md of a `.skill`
 * archive (or a SKILL.md file, or a directory containing one) to stdout,
 * without extracting any other files.
 *
 * Eleventh piece of the authoring workflow after `init`, `validate`, `lint`,
 * `update`, `format`, `pack`, `install`, `inspect`, `diff`, `tree`. The
 * morally-correct analogue of `tar -xOf <archive> SKILL.md` for skill
 * bundles: open the zip in memory, locate `SKILL.md` at the root, print
 * its bytes — never spill files to disk. Mirrors what `install --dry-run`
 * does internally but with a single concern: show me the contract.
 *
 * Accepts three input shapes for ergonomics:
 *   - `.skill` archive  → unzip in memory, read `SKILL.md` from root.
 *   - directory         → read `<dir>/SKILL.md`.
 *   - SKILL.md file     → read directly.
 *
 * Always validates the frontmatter against `SkillFrontmatterSchema` before
 * emitting. A broken `.skill` is refused with a clear error rather than
 * silently printing garbage — `cat` is a contract preview, not a hex dump.
 *
 * No side effects: this command never writes to disk. Reuses `jszip` and
 * `gray-matter` already pulled in by sibling modules — no new runtime deps.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import matter from "gray-matter";
import JSZip from "jszip";
import { SkillFrontmatterSchema } from "./schema.js";

export type CatSection = "frontmatter" | "body" | "all";

export interface CatOptions {
  /** Path to a `.skill` archive, a SKILL.md file, or a directory containing one. */
  path: string;
  /**
   * Which slice of the SKILL.md to return as `content`. Defaults to `"all"`
   * — the raw bytes verbatim (frontmatter fences and body). `"frontmatter"`
   * returns just the YAML between the `---` fences (no fences). `"body"`
   * returns the markdown after the frontmatter block, leading whitespace
   * stripped.
   */
  section?: CatSection;
}

export interface CatResult {
  /** The input path, as the user passed it. */
  path: string;
  /** Skill name pulled from frontmatter (always present — validation enforces it). */
  name: string;
  /** Skill version pulled from frontmatter (always present — schema defaults to 0.0.1). */
  version: string;
  /**
   * The requested slice of SKILL.md as a string. Shape depends on
   * `section`: full file for `"all"`, YAML for `"frontmatter"`, markdown
   * for `"body"`.
   */
  content: string;
  /** The raw SKILL.md bytes, regardless of `section`. */
  raw: string;
}

/**
 * Resolve the input path to the SKILL.md bytes plus a label for error
 * messages. Three shapes are accepted; the resolver picks the right one
 * based on the path's filesystem type and extension.
 */
async function resolveSkillSource(inputPath: string): Promise<{ raw: string; label: string }> {
  if (!existsSync(inputPath)) {
    throw new Error(`cat: ${inputPath} does not exist`);
  }
  const st = await stat(inputPath);
  if (st.isDirectory()) {
    return readFromDirectory(inputPath);
  }
  if (!st.isFile()) {
    throw new Error(`cat: ${inputPath} is neither a file nor a directory`);
  }
  // Heuristic: a `.skill` archive is a zip. Anything else we treat as a
  // SKILL.md file directly. We deliberately don't sniff bytes — the
  // extension is the contract `pack` produces and `install` consumes.
  if (inputPath.endsWith(".skill") || inputPath.endsWith(".zip")) {
    return readFromArchive(inputPath);
  }
  // Plain SKILL.md (or anything claiming to be one).
  const raw = await readFile(inputPath, "utf8");
  return { raw, label: inputPath };
}

async function readFromDirectory(dirPath: string): Promise<{ raw: string; label: string }> {
  // Same convention as `inspect` and `update`: a directory must contain a
  // SKILL.md at the top level.
  const candidate = `${dirPath}/SKILL.md`;
  if (!existsSync(candidate)) {
    throw new Error(`cat: ${dirPath} does not contain a SKILL.md`);
  }
  const raw = await readFile(candidate, "utf8");
  return { raw, label: candidate };
}

async function readFromArchive(archivePath: string): Promise<{ raw: string; label: string }> {
  const buf = await readFile(archivePath);
  const zip = await JSZip.loadAsync(buf).catch((err) => {
    throw new Error(`cat: ${archivePath} is not a valid .skill (zip parse failed): ${err.message}`);
  });
  // SKILL.md must live at the archive root — same contract as `install`.
  // Any nested SKILL.md is intentionally ignored: a `pack` output always
  // has SKILL.md at the root, and matching that convention keeps `cat`
  // and `install` agreeing on which file is canonical.
  const entry = zip.file("SKILL.md");
  if (!entry) {
    throw new Error(`cat: ${archivePath} does not contain a SKILL.md at the archive root`);
  }
  const raw = await entry.async("string");
  return { raw, label: `${archivePath}::SKILL.md` };
}

/**
 * Pull the raw YAML between the leading `---` fences without going through
 * gray-matter. We extract it ourselves because gray-matter caches parse
 * results across calls and the `matter` field on a cached hit comes back
 * `undefined` — a footgun for an emitter that wants the exact bytes the
 * author wrote. The regex matches install.ts's own minimal extractor so
 * both modules agree on the frontmatter contract.
 */
function extractFrontmatterYaml(raw: string): string | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? (m[1] ?? "") : null;
}

/**
 * Strip the leading frontmatter block off `raw` and return what remains.
 * Leading blank lines after the fence are trimmed so callers get clean
 * markdown without the YAML envelope or its trailing whitespace.
 */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return raw;
  return raw.slice(m[0].length).replace(/^\n+/, "");
}

/**
 * Validate the SKILL.md frontmatter against the schema before emitting.
 * A broken bundle is refused with a list of issues — `cat` is a preview
 * of the contract, so a contract that doesn't parse is a real error,
 * not a "still print something" situation.
 */
function validateOrThrow(
  raw: string,
  label: string,
): { name: string; version: string; body: string; frontmatterYaml: string } {
  const parsed = matter(raw);
  const schemaResult = SkillFrontmatterSchema.safeParse(parsed.data);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map(
      (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
    );
    throw new Error(
      `cat: SKILL.md in ${label} has invalid frontmatter:\n  - ${issues.join("\n  - ")}`,
    );
  }
  // Preserve the author's exact YAML formatting (key order, quoting,
  // comments) by extracting the raw block ourselves rather than
  // re-stringifying via gray-matter.
  const rawYaml = extractFrontmatterYaml(raw) ?? "";
  return {
    name: schemaResult.data.name,
    version: schemaResult.data.version,
    body: stripFrontmatter(raw),
    frontmatterYaml: rawYaml,
  };
}

/**
 * Print the bundled SKILL.md of a `.skill` archive (or read a SKILL.md
 * from disk) and return the requested slice as a string. Always validates
 * frontmatter before emitting; never writes anything to disk.
 */
export async function catSkill(opts: CatOptions): Promise<CatResult> {
  const { raw, label } = await resolveSkillSource(opts.path);
  const { name, version, body, frontmatterYaml } = validateOrThrow(raw, label);

  const section = opts.section ?? "all";
  let content: string;
  switch (section) {
    case "frontmatter":
      content = frontmatterYaml;
      break;
    case "body":
      content = body;
      break;
    default:
      content = raw;
      break;
  }
  return { path: opts.path, name, version, content, raw };
}
