/**
 * `skillforge install <url> [--out <dir>] [--force] [--dry-run]` — download
 * and extract a remote `.skill` archive into the user's local skills tree.
 *
 * Design choices and the security posture behind them:
 *
 *   1. **HTTPS only.** Plaintext http:// is refused before any bytes are
 *      fetched. `.skill` archives execute on the user's machine via Claude
 *      and Cowork — accepting them over an unauthenticated transport would
 *      be an obvious code-injection vector.
 *
 *   2. **Zip-slip protection.** Every entry's destination is resolved and
 *      checked to live under the install root. Any `..`-traversal, absolute
 *      path, or path that resolves outside the target rejects the install
 *      before a single file is written.
 *
 *   3. **No symlinks.** Zip entries with the symlink Unix mode bit are
 *      refused. Symlink targets aren't checked by zip-slip; better to ban
 *      them outright for a skill archive (they don't appear in legitimate
 *      `skillforge pack` output).
 *
 *   4. **Size cap.** Downloads larger than `MAX_DOWNLOAD_BYTES` are refused
 *      to bound damage from a hostile / accidentally-huge URL. Default 64 MB
 *      — plenty for any real Claude skill.
 *
 *   5. **Validation before extraction.** SKILL.md is parsed and validated
 *      against the frontmatter schema *before* any files land in the target
 *      directory. A broken bundle never pollutes the install root.
 *
 *   6. **Refuse-overwrite by default.** If the install dir already exists,
 *      bail unless `--force` is passed. Skill identities are the unit of
 *      trust; silently overwriting one is dangerous.
 *
 * The implementation has zero new runtime dependencies — it reuses the
 * `jszip` already pulled in by `pack`, and Node's built-in `fetch`.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import JSZip from "jszip";
import { SkillFrontmatterSchema } from "./schema.js";

export interface InstallOptions {
  /** Source URL — must be https:// or file:// (for tests / local mirrors). */
  url: string;
  /** Target directory. Defaults to `~/.claude/skills/<skill-name>`. */
  outDir?: string;
  /** Overwrite an existing install directory. */
  force?: boolean;
  /** Validate the bundle and report what would happen, but write nothing. */
  dryRun?: boolean;
  /** Injection seam for tests — defaults to `globalThis.fetch`. */
  fetchImpl?: (url: string) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface InstallResult {
  /** Where the skill ended up (or would have, for dry-run). */
  outDir: string;
  /** Parsed skill name from the bundle's SKILL.md frontmatter. */
  skillName: string;
  /** Files written (or that would be written). Relative paths inside outDir. */
  files: string[];
  /** Bytes written across all files. */
  bytesWritten: number;
  /** True iff this was a dry-run. */
  dryRun: boolean;
}

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MB — generous for any real skill
// Symlink mode mask per the Unix `man 7 inode` file-type bits. JSZip exposes
// the upper 16 bits of the external attributes for ZIP entries created with
// Unix metadata, so this is what we test against.
const SYMLINK_MASK = 0o120000;

export async function installSkill(opts: InstallOptions): Promise<InstallResult> {
  assertSafeUrl(opts.url);
  const fetcher = opts.fetchImpl ?? defaultFetcher();

  const res = await fetcher(opts.url);
  if (!res.ok) {
    throw new Error(`install: HTTP ${res.status} fetching ${opts.url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `install: download is ${buf.byteLength} bytes, exceeds cap of ${MAX_DOWNLOAD_BYTES}`,
    );
  }

  const zip = await JSZip.loadAsync(buf).catch((err) => {
    throw new Error(
      `install: ${opts.url} is not a valid .skill (zip parse failed): ${err.message}`,
    );
  });

  // SKILL.md must live at the archive root.
  const skillEntry = zip.file("SKILL.md");
  if (!skillEntry) {
    throw new Error("install: archive does not contain a SKILL.md at the root");
  }
  const skillSource = await skillEntry.async("string");
  const skillName = parseAndValidateSkillName(skillSource);

  const outDir = resolve(opts.outDir ?? join(homedir(), ".claude", "skills", skillName));

  if (existsSync(outDir) && !opts.force) {
    throw new Error(
      `install: ${outDir} already exists — pass --force to overwrite, or pick a different --out`,
    );
  }

  // Walk the archive once to enforce safety before writing anything.
  const plan = await planExtraction(zip, outDir);

  if (opts.dryRun) {
    return {
      outDir,
      skillName,
      files: plan.entries.map((e) => e.relPath),
      bytesWritten: plan.totalBytes,
      dryRun: true,
    };
  }

  if (existsSync(outDir)) {
    // --force path: clear the directory so stale files from a prior install
    // don't survive. Use rm rather than rmdir so the dir-tree goes too.
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  let bytesWritten = 0;
  for (const entry of plan.entries) {
    await mkdir(dirname(entry.absPath), { recursive: true });
    await writeFile(entry.absPath, entry.data);
    bytesWritten += entry.data.byteLength;
  }
  return {
    outDir,
    skillName,
    files: plan.entries.map((e) => e.relPath),
    bytesWritten,
    dryRun: false,
  };
}

interface ExtractionEntry {
  relPath: string;
  absPath: string;
  data: Buffer;
}

async function planExtraction(
  zip: JSZip,
  outDir: string,
): Promise<{ entries: ExtractionEntry[]; totalBytes: number }> {
  const entries: ExtractionEntry[] = [];
  let totalBytes = 0;
  const outDirWithSep = outDir.endsWith(sep) ? outDir : outDir + sep;

  // JSZip's forEach iterates synchronously, but file payloads are async.
  // Collect the entry refs first, then await each payload.
  const refs: { relPath: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relPath, entry) => {
    refs.push({ relPath, entry });
  });

  for (const { relPath, entry } of refs) {
    if (entry.dir) continue; // directories are recreated implicitly via mkdir-p
    // Normalize POSIX-style paths from the archive to native separators.
    const normalized = relPath.split("/").join(sep);
    const absPath = resolve(outDir, normalized);
    if (!isInside(absPath, outDirWithSep)) {
      throw new Error(
        `install: refusing zip entry "${relPath}" — resolves outside the install root (zip-slip)`,
      );
    }
    // External attributes encode the Unix file mode in the upper 16 bits for
    // archives created with Unix metadata. Refuse symlinks outright. JSZip
    // types `unixPermissions` as `number | string | undefined`; we only act
    // on it when it's a real number.
    const rawPerms = entry.unixPermissions;
    if (typeof rawPerms === "number" && (rawPerms & 0o170000) === SYMLINK_MASK) {
      throw new Error(`install: refusing symlink entry "${relPath}"`);
    }
    const data = Buffer.from(await entry.async("nodebuffer"));
    totalBytes += data.byteLength;
    entries.push({ relPath, absPath, data });
  }
  return { entries, totalBytes };
}

function isInside(absPath: string, outDirWithSep: string): boolean {
  return absPath === outDirWithSep.slice(0, -1) || absPath.startsWith(outDirWithSep);
}

function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`install: ${url} is not a valid URL`);
  }
  if (parsed.protocol === "https:" || parsed.protocol === "file:") return;
  if (parsed.protocol === "http:") {
    throw new Error(
      "install: refusing plaintext http:// URL — .skill bundles execute on your machine, use https://",
    );
  }
  throw new Error(`install: unsupported URL scheme "${parsed.protocol}" — use https:// or file://`);
}

function parseAndValidateSkillName(skillMd: string): string {
  // We re-parse with our own minimal frontmatter extractor here instead of
  // calling gray-matter — the install path runs *before* node_modules is
  // populated for the target skill, so keeping this single function
  // dependency-free is a small but real win.
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    throw new Error("install: SKILL.md does not have a YAML frontmatter block at the top");
  }
  const yaml = m[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    fields[kv[1]] = (kv[2] ?? "").trim();
  }
  const parsed = SkillFrontmatterSchema.safeParse({
    ...fields,
    tags: fields.tags ? safeJsonArray(fields.tags) : [],
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new Error(
      `install: SKILL.md frontmatter is invalid — fix these before publishing:\n  - ${issues.join("\n  - ")}`,
    );
  }
  return parsed.data.name;
}

function safeJsonArray(raw: string): unknown {
  // tags: ["a", "b"] is the common shape we already produce; anything else
  // we leave alone for zod to reject.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function defaultFetcher() {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("install: global fetch not available (need Node 20+)");
  }
  return (url: string) => globalThis.fetch(url);
}
