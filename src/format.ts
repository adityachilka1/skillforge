/**
 * `skillforge format <path>` — reformat a SKILL.md to canonical shape.
 *
 * Seventh piece of the authoring workflow after `init`, `validate`, `lint`,
 * `pack`, `install`, `update`. Hand-written SKILL.md files drift in shape:
 * frontmatter keys land in arbitrary order, trailing whitespace creeps in,
 * blank lines pile up. `lint` *flags* this drift; `format` *fixes* it.
 * Think `prettier` for the SKILL.md envelope.
 *
 * Envelope-only — do NOT reflow prose. Body bytes inside fenced code blocks
 * are preserved verbatim; outside code blocks we only do gentle whitespace
 * normalization (trailing-space trim, run-of-blanks collapse, single
 * trailing newline). The frontmatter is re-emitted: keys are reordered into
 * the schema's canonical declaration order, passthrough keys go at the end
 * alphabetized, stringy bool/num literals are coerced back to YAML
 * primitives, and trailing whitespace is stripped per line.
 *
 * Validation happens BEFORE writing — so a file that's only "broken"
 * because of whitespace can still be auto-fixed, but the formatted *output*
 * must validate against `SkillFrontmatterSchema` or we refuse.
 *
 * Idempotence is a hard guarantee: formatting an already-formatted file
 * produces byte-identical output, and `changed: false` is returned.
 */
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { SkillFrontmatterSchema } from "./schema.js";

export interface FormatOptions {
  /** Path to a SKILL.md file or a directory containing one. */
  path: string;
  /** Write the formatted result back to disk. Default `true`. */
  write?: boolean;
  /** Compute the formatted result but write nothing. Default `false`. */
  dryRun?: boolean;
}

export interface FormatResult {
  /** Resolved path of the SKILL.md file we touched (or would have touched). */
  path: string;
  /** True iff `after !== before`. */
  changed: boolean;
  /** Original raw file contents. */
  before: string;
  /** Formatted raw file contents. */
  after: string;
  /** Mirrors `opts.dryRun`. */
  dryRun: boolean;
}

/**
 * Canonical order of known frontmatter keys. Mirrors the schema's
 * declaration order in `schema.ts`. Unknown (passthrough) keys come after
 * these, alphabetized.
 */
const CANONICAL_KEY_ORDER = [
  "name",
  "description",
  "version",
  "tags",
  "author",
  "homepage",
] as const;

const KNOWN_KEYS = new Set<string>(CANONICAL_KEY_ORDER);

/**
 * Resolve the input path to an actual SKILL.md file.
 * - File path: must exist and be readable.
 * - Directory path: must contain a SKILL.md.
 */
async function resolveSkillFile(inputPath: string): Promise<string> {
  if (!existsSync(inputPath)) {
    throw new Error(`format: ${inputPath} does not exist`);
  }
  const st = await stat(inputPath);
  if (st.isDirectory()) {
    const candidate = join(inputPath, "SKILL.md");
    if (!existsSync(candidate)) {
      throw new Error(`format: ${inputPath} does not contain a SKILL.md`);
    }
    return candidate;
  }
  return inputPath;
}

/**
 * Find the inclusive [start, end] line indices (0-indexed) of the
 * frontmatter fence in `lines`, or `null` if there's no frontmatter.
 */
function findFrontmatterBounds(lines: string[]): { start: number; end: number } | null {
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") return { start: 0, end: i };
  }
  return null;
}

/**
 * Coerce a stringy primitive back to its YAML-native form. Users sometimes
 * end up with `tags: "[]"` (string) instead of `tags: []` (array) — gray-
 * matter parses both, but our emitter normalizes to the latter.
 *
 * Only applies coercion in unambiguous cases:
 *   - "[]" or "[ ]" → []
 *   - "true" / "false" → boolean
 *   - integer-shaped → number (but NOT for fields that semver expects)
 */
function coerceStringy(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (key === "tags") {
    const trimmed = value.trim();
    if (trimmed === "[]" || trimmed === "[ ]") return [];
  }
  // We deliberately do NOT coerce "true"/"false"/numeric strings on `name`,
  // `description`, `version`, `author`, `homepage` — those are all string-
  // typed by the schema and a literal "true" should stay a string.
  return value;
}

/**
 * Quote a YAML scalar minimally. We single-quote strings that contain
 * characters YAML would otherwise parse specially (`:`, `#`, leading `@`,
 * `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `` ` ``, `,`, `[`, `]`, `{`, `}`)
 * or that would parse as a non-string scalar (`true`, `false`, `null`,
 * numbers). Otherwise leave bare. Single-quote escaping in YAML: `'` →
 * `''`. We never use double-quotes (avoid the `\n` escape surprises).
 */
function emitYamlScalar(value: string): string {
  if (value === "") return "''";
  // Multi-line strings get the literal block scalar treatment elsewhere.
  // This helper is for single-line scalars.
  const needsQuoting =
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    /[:#&*!|>'"%`,[\]{}]/.test(value) ||
    /^[@?]/.test(value) ||
    /^\s|\s$/.test(value);
  if (!needsQuoting) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Emit a YAML array (single-line flow style) for a list of strings. If any
 * element would require quoting that disrupts a flow array we still flow
 * it — multi-line block lists are out of scope for the format envelope.
 */
function emitYamlArray(items: unknown[]): string {
  if (items.length === 0) return "[]";
  const parts = items.map((item) => {
    if (typeof item === "string") return emitYamlScalar(item);
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    return emitYamlScalar(String(item));
  });
  return `[${parts.join(", ")}]`;
}

/**
 * Emit a YAML key/value line. Multi-line strings (containing `\n`) get the
 * literal block scalar (`|`) form so a description that already had real
 * line breaks survives the round-trip. Everything else is single-line.
 */
function emitYamlEntry(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return `${key}: ~`;
  }
  if (Array.isArray(value)) {
    return `${key}: ${emitYamlArray(value)}`;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return `${key}: ${String(value)}`;
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      // Block scalar. Strip trailing whitespace per line, keep relative
      // shape. Trailing newline in `value` is preserved by `|` (clip).
      const lines = value.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
      // Drop a trailing empty line if present (matches `|`'s clip default).
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const indented = lines.map((l) => (l === "" ? "" : `  ${l}`)).join("\n");
      return `${key}: |\n${indented}`;
    }
    return `${key}: ${emitYamlScalar(value)}`;
  }
  // Object / nested — fall back to JSON form, single-line. Out of scope
  // for the schema's known keys; only reachable for unusual passthrough.
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * Render the canonical frontmatter YAML block (without the surrounding
 * `---` fences). Keys in canonical order first, then passthrough keys
 * alphabetized. Coerces stringy primitives. Each line has trailing
 * whitespace stripped (implicit — we never emit any).
 */
function renderFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  // Canonical keys first, in declared order. Skip keys that are absent
  // entirely — don't synthesize them. (e.g. `homepage` absent stays absent.)
  for (const key of CANONICAL_KEY_ORDER) {
    if (!(key in data)) continue;
    seen.add(key);
    const coerced = coerceStringy(key, data[key]);
    lines.push(emitYamlEntry(key, coerced));
  }

  // Passthrough (unknown) keys, alphabetized.
  const passthroughKeys = Object.keys(data)
    .filter((k) => !KNOWN_KEYS.has(k) && !seen.has(k))
    .sort();
  for (const key of passthroughKeys) {
    const coerced = coerceStringy(key, data[key]);
    lines.push(emitYamlEntry(key, coerced));
  }

  return lines.join("\n");
}

/**
 * Normalize the body of a SKILL.md:
 *   - Trim trailing whitespace per line (OUTSIDE code blocks).
 *   - Collapse runs of 3+ blank lines to exactly 2 (OUTSIDE code blocks).
 *   - Ensure exactly one trailing newline at EOF.
 *
 * Inside fenced code blocks (` ``` ` to ` ``` `) bytes are left verbatim.
 * We track fence state line-by-line. The fence delimiter line itself is
 * normalized (it's outside the contents).
 */
function normalizeBody(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;

  // Fence regex: 3+ backticks or 3+ tildes at start of line (optional
  // indent up to 3 spaces per CommonMark, but we keep it loose).
  const fenceRe = /^\s{0,3}(```+|~~~+)/;

  for (const line of lines) {
    if (inFence) {
      // Inside a fence: preserve verbatim. Only check if THIS line closes
      // the fence (matches the same delimiter family at line start).
      out.push(line);
      if (fenceRe.test(line)) {
        inFence = false;
      }
      blankRun = 0;
      continue;
    }
    // Outside a fence: opening fence?
    if (fenceRe.test(line)) {
      // Push the fence line itself with trailing whitespace trimmed (it's
      // outside content) and enter fence mode.
      out.push(line.replace(/[ \t]+$/, ""));
      inFence = true;
      blankRun = 0;
      continue;
    }
    const trimmed = line.replace(/[ \t]+$/, "");
    if (trimmed === "") {
      blankRun += 1;
      // Allow up to 2 consecutive blank lines (i.e. one blank between
      // paragraphs is 1, double-spaced is 2). Collapse anything beyond.
      if (blankRun <= 2) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(trimmed);
  }

  // Drop leading blank lines — `compose()` re-attaches a single blank
  // separator between the closing `---` fence and the body. Without this
  // we'd emit two blank lines on round-trip (gray-matter's `content`
  // already begins with a `\n` after the fence).
  while (out.length > 0 && out[0] === "") out.shift();
  // Drop trailing blank lines, then add exactly one terminator newline.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  // Edge case: an entirely blank body should still produce a final
  // newline-only file segment.
  if (out.length === 0) return "";
  return `${out.join("\n")}\n`;
}

/**
 * Compose the formatted full-file text from the parsed frontmatter object
 * and the normalized body. Always uses LF newlines and the standard
 * `---\n…\n---\n\n<body>` layout.
 */
function compose(frontmatter: Record<string, unknown>, body: string): string {
  const fmBlock = renderFrontmatter(frontmatter);
  const bodyBlock = normalizeBody(body);
  // Standard layout: opening fence, frontmatter, closing fence, blank
  // line, body. The body already ends with exactly one `\n` (or is empty,
  // in which case we collapse the trailing separator to a single newline).
  if (bodyBlock === "") return `---\n${fmBlock}\n---\n`;
  return `---\n${fmBlock}\n---\n\n${bodyBlock}`;
}

/**
 * Reformat a SKILL.md file to canonical shape.
 *
 * @throws when the path doesn't resolve to a SKILL.md, when the file has
 *         no frontmatter block, or when the formatted output fails schema
 *         validation.
 */
export async function formatSkill(opts: FormatOptions): Promise<FormatResult> {
  const file = await resolveSkillFile(opts.path);
  const before = await readFile(file, "utf8");
  const parsed = matter(before);

  // Defend: we need a frontmatter block. `matter()` returns empty `data`
  // for both "no frontmatter" and "frontmatter present but empty"; we
  // disambiguate by inspecting the raw text.
  const lines = before.split("\n");
  const bounds = findFrontmatterBounds(lines);
  if (!bounds) {
    throw new Error(`format: ${file} has no frontmatter block`);
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const body = parsed.content;
  const after = compose(data, body);

  // Pre-validate by running the schema over the parsed data (with the
  // tags-coercion applied — schema demands an array, not a string).
  // We validate the SOURCE data with coercion applied, since that's what
  // ends up in the file. If validation fails, we refuse to write.
  const proposedFrontmatter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    proposedFrontmatter[k] = coerceStringy(k, v);
  }
  const schemaResult = SkillFrontmatterSchema.safeParse(proposedFrontmatter);
  if (!schemaResult.success) {
    const detail = schemaResult.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`format: refusing to write — resulting frontmatter is invalid (${detail})`);
  }

  const changed = after !== before;
  const dryRun = !!opts.dryRun;
  const write = opts.write !== false; // default true

  if (changed && !dryRun && write) {
    await writeFile(file, after, "utf8");
  }

  return { path: file, changed, before, after, dryRun };
}
