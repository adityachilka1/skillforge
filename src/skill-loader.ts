/**
 * Tiny shared loader: take a path that might be a `.skill` archive, a
 * directory containing a SKILL.md, or a SKILL.md file directly, and
 * return the raw SKILL.md bytes plus a `source` label callers can show
 * the user.
 *
 * Carved out as its own module so `inspect` can reuse the same archive
 * recognition that `cat` and `install` already do, without growing those
 * modules a new exported helper. The semantics deliberately match
 * `cat`'s `resolveSkillSource` — same `.skill`/`.zip` extension heuristic,
 * same zip-magic sniff for `--from-bundle`, same "SKILL.md must live at
 * the archive root" contract as `install`.
 */
import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import JSZip from "jszip";

/** Where the SKILL.md actually came from — used for human-readable headers. */
export type SkillSourceKind = "archive" | "directory" | "file";

export interface LoadedSkill {
  /** Raw SKILL.md bytes. */
  raw: string;
  /** Discriminator the caller can branch on for display. */
  kind: SkillSourceKind;
  /** Original path the user passed in (unmodified). */
  inputPath: string;
  /**
   * The on-disk SKILL.md file when `kind === "file"` or `kind === "directory"`.
   * `undefined` for archives — those have no SKILL.md file on disk. The caller
   * is responsible for materializing a temp file if it needs one.
   */
  skillFile?: string;
}

export interface LoadSkillContentOptions {
  /** Path to a `.skill` archive, a SKILL.md file, or a directory containing one. */
  path: string;
  /**
   * Force archive interpretation regardless of file extension. Useful when
   * the bundle has been renamed (`foo.zip`, `foo.bundle`, `foo`) but is still
   * a valid `.skill` zip. The loader will sniff the first 4 bytes for the
   * standard PK\x03\x04 zip magic and refuse if it's missing.
   */
  fromBundle?: boolean;
}

/** Standard local-file zip header magic — first 4 bytes of any zip. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Resolve the input path to a `LoadedSkill`. Throws a clear error if the
 * path doesn't exist, an archive lacks a `SKILL.md` at the root, or the
 * caller asked for `--from-bundle` on something that isn't a zip.
 */
export async function loadSkillContent(opts: LoadSkillContentOptions): Promise<LoadedSkill> {
  const { path: inputPath, fromBundle } = opts;
  if (!existsSync(inputPath)) {
    throw new Error(`${inputPath} does not exist`);
  }
  const st = await stat(inputPath);
  if (st.isDirectory()) {
    if (fromBundle) {
      throw new Error(`--from-bundle requires a file, but ${inputPath} is a directory`);
    }
    return readFromDirectory(inputPath);
  }
  if (!st.isFile()) {
    throw new Error(`${inputPath} is neither a file nor a directory`);
  }

  // Archive recognition: explicit `--from-bundle`, the `.skill`/`.zip` suffix,
  // or — only when forced — the on-disk zip magic. We sniff bytes only behind
  // `--from-bundle` because the extension is the standard contract `pack`
  // produces and `install` consumes; an arbitrary file shouldn't be opened
  // as a zip just because its first four bytes happen to align.
  const looksLikeArchive = inputPath.endsWith(".skill") || inputPath.endsWith(".zip");
  if (fromBundle) {
    await assertZipMagic(inputPath);
    return readFromArchive(inputPath);
  }
  if (looksLikeArchive) {
    return readFromArchive(inputPath);
  }

  // Plain SKILL.md (or anything claiming to be one).
  const raw = await readFile(inputPath, "utf8");
  return { raw, kind: "file", inputPath, skillFile: inputPath };
}

async function readFromDirectory(dirPath: string): Promise<LoadedSkill> {
  // Same convention as `inspect`, `cat`, `update`: a directory must contain
  // a SKILL.md at the top level.
  const candidate = `${dirPath}/SKILL.md`;
  if (!existsSync(candidate)) {
    throw new Error(`${dirPath} does not contain a SKILL.md`);
  }
  const raw = await readFile(candidate, "utf8");
  return { raw, kind: "directory", inputPath: dirPath, skillFile: candidate };
}

async function readFromArchive(archivePath: string): Promise<LoadedSkill> {
  const buf = await readFile(archivePath);
  const zip = await JSZip.loadAsync(buf).catch((err) => {
    throw new Error(`${archivePath} is not a valid .skill (zip parse failed): ${err.message}`);
  });
  // SKILL.md must live at the archive root — same contract as `install`
  // and `cat`. A nested SKILL.md is intentionally ignored: `pack` always
  // emits SKILL.md at the root, and keeping the three modules agreeing on
  // that single rule is what makes the bundle format trustable.
  const entry = zip.file("SKILL.md");
  if (!entry) {
    throw new Error(`${archivePath} does not contain a SKILL.md at the archive root`);
  }
  const raw = await entry.async("string");
  return { raw, kind: "archive", inputPath: archivePath };
}

/**
 * Peek at the first four bytes of `path` and refuse with a clear error if
 * they aren't the local-file zip header magic. Used only on the
 * `--from-bundle` path so callers passing a misnamed `.skill` get a fast,
 * dependency-free pre-check before JSZip even sees the bytes.
 */
async function assertZipMagic(path: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4 || !buf.equals(ZIP_MAGIC)) {
      throw new Error(`--from-bundle expects a zip-format archive, but ${path} is not a zip`);
    }
  } finally {
    await fh.close();
  }
}
