/**
 * `skillforge tree <dir>` — preview the file inventory a `pack` would
 * produce, without actually building the archive.
 *
 * Tenth piece of the authoring workflow after `init`, `validate`, `lint`,
 * `update`, `format`, `pack`, `install`, `inspect`, `diff`. Where `pack`
 * *builds* and `inspect` *reads* a single skill end-to-end, `tree` is a
 * one-shot pre-flight: walk the directory using the same exclusion logic
 * `pack` uses, return a tidy file listing with sizes.
 *
 * Reuses `shouldExcludeEntry` from `pack.ts` so the two stay byte-for-byte
 * in agreement on which files belong in a skill — no duplicated walker.
 *
 * No side effects: this command never writes to disk.
 */
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { shouldExcludeEntry } from "./pack.js";

export interface TreeOptions {
  /** Directory to walk. Must exist and be a directory. */
  srcDir: string;
  /**
   * Sort order for the returned `entries`. `"path"` (default) walks the
   * tree in directory-then-file order, alphabetised within each level —
   * matches what a user would see if they ran `ls -R`. `"size"` sorts by
   * descending byte size, useful for "what's making this skill heavy?"
   * spot checks. Directory entries are excluded under `"size"` because
   * their size is filesystem-defined and not a meaningful "weight".
   */
  sort?: "path" | "size";
}

export interface TreeEntry {
  /** POSIX-relative path from `srcDir`. Directories appear without a trailing slash. */
  path: string;
  /** File size in bytes. Directories report the filesystem-reported size (informational only). */
  size: number;
  /** True for directory entries, false for files. */
  isDir: boolean;
}

export interface TreeResult {
  /** Absolute, resolved srcDir. */
  srcDir: string;
  /** Every non-excluded entry, in the requested sort order. */
  entries: TreeEntry[];
  /** Count of file entries (directories excluded). */
  totalFiles: number;
  /** Sum of file sizes in bytes. */
  totalBytes: number;
}

/**
 * Walk `srcDir` and return every non-excluded entry. Uses the same
 * exclusion rule as `packSkill` so authors can trust that what `tree`
 * shows is what `pack` would bundle.
 */
export async function treeSkill(opts: TreeOptions): Promise<TreeResult> {
  const src = resolve(opts.srcDir);
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat) {
    throw new Error(`tree: ${opts.srcDir} does not exist`);
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`tree: ${opts.srcDir} is not a directory`);
  }

  const entries: TreeEntry[] = [];
  await walk(src, src, entries);

  const sort = opts.sort ?? "path";
  let sorted: TreeEntry[];
  if (sort === "size") {
    // Directories drop out under size-sort — their "size" is filesystem
    // bookkeeping, not skill content. Files only, descending.
    sorted = entries.filter((e) => !e.isDir).sort((a, b) => b.size - a.size);
  } else {
    // Path-sort is the natural walk order — entries are already in tree
    // order from the walk, and `walk` alphabetises each directory's
    // children by raw byte order. Use the same byte-order comparator here
    // so siblings stay grouped under their parent directory. (A locale
    // comparator would intermix top-level entries with deep ones, e.g.
    // `SKILL.md` after `middle/nested.txt`.)
    sorted = entries.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  let totalFiles = 0;
  let totalBytes = 0;
  for (const e of entries) {
    if (!e.isDir) {
      totalFiles += 1;
      totalBytes += e.size;
    }
  }

  return { srcDir: src, entries: sorted, totalFiles, totalBytes };
}

async function walk(rootDir: string, currentDir: string, out: TreeEntry[]): Promise<void> {
  const dirEntries = await readdir(currentDir, { withFileTypes: true });
  // Alphabetise so two runs on the same tree produce the same output, and
  // so the human-readable rendering reads naturally top-to-bottom. Raw
  // byte order, not locale-aware — matches the path-sort comparator and
  // keeps the result stable across machines with different locales.
  dirEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of dirEntries) {
    if (shouldExcludeEntry(entry.name)) continue;
    const abs = join(currentDir, entry.name);
    const rel = relative(rootDir, abs).split(sep).join("/");
    if (entry.isDirectory()) {
      const st = await stat(abs);
      out.push({ path: rel, size: st.size, isDir: true });
      await walk(rootDir, abs, out);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks, sockets, FIFOs — same as pack
    const st = await stat(abs);
    out.push({ path: rel, size: st.size, isDir: false });
  }
}
