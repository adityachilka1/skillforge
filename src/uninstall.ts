/**
 * `skillforge uninstall <name> [--from <dir>] [--force] [--dry-run]` — remove
 * an installed skill from the local skills tree.
 *
 * The counterpart to `install`: where `install` extracts a `.skill` archive
 * into `~/.claude/skills/<name>/`, `uninstall` walks the same path and
 * deletes it. The contract is deliberately narrow:
 *
 *   1. **`name` is a single path segment.** Anything that contains a path
 *      separator, a `..` traversal segment, or resolves outside the install
 *      root is rejected before any disk read. The user names a skill, not
 *      a path — this command does not navigate the filesystem on their
 *      behalf. Same posture as `install`'s zip-slip guard.
 *
 *   2. **Targets must be directories.** If a file is sitting where a skill
 *      dir should be (`~/.claude/skills/<name>` is a regular file), the
 *      uninstall refuses and tells the user. We never `rm -f` a path the
 *      install command would not have produced.
 *
 *   3. **Dry-run reports without touching disk.** `dryRun: true` walks the
 *      directory tree to compute `bytesFreed` and `fileCount`, then
 *      returns — leaving every file in place. The library form returns the
 *      same `UninstallResult` shape either way so callers can dispatch on
 *      `result.dryRun`.
 *
 *   4. **The `force` flag is a CLI-layer concern.** This library function
 *      always proceeds; the CLI is responsible for the interactive "are
 *      you sure?" gate when `--force` is absent. Keeping the library API
 *      side-effect-only (no prompts) means tests and scripted callers
 *      get a clean, deterministic surface.
 *
 * Zero new runtime deps. Pure Node `fs` and `path`.
 */
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface UninstallOptions {
  /** Skill name — must be a single path segment (no separators or traversal). */
  name: string;
  /** Root to look under. Defaults to `~/.claude/skills`. */
  fromDir?: string;
  /**
   * Skip the "are you sure?" prompt the CLI would otherwise show. The
   * library API does not prompt; this flag is here for shape parity with
   * the CLI surface and is currently a no-op at the library layer.
   */
  force?: boolean;
  /** Walk and report, but don't touch the filesystem. */
  dryRun?: boolean;
}

export interface UninstallResult {
  /** The skill name that was requested. */
  name: string;
  /** Absolute path that was (or would be) removed. */
  path: string;
  /** Total bytes that were (or would be) freed. */
  bytesFreed: number;
  /** Total file count that was (or would be) removed. */
  fileCount: number;
  /** True iff this was a dry-run. */
  dryRun: boolean;
}

export async function uninstallSkill(opts: UninstallOptions): Promise<UninstallResult> {
  const name = opts.name;
  // Reject empty / whitespace names up front. The user named the skill,
  // there's nothing to look up if the string is blank.
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("uninstall: name is required (non-empty, non-whitespace)");
  }

  // Reject any name that isn't a single path segment. We don't navigate the
  // filesystem on the user's behalf; if they want to remove "../etc" they
  // can do that themselves. Same posture as install's zip-slip guard.
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === ".." ||
    name === "." ||
    name.startsWith("../") ||
    name.startsWith("..\\")
  ) {
    throw new Error(
      `uninstall: invalid skill name "${name}" — name must be a single path segment (no separators or traversal)`,
    );
  }

  const fromDir = resolve(opts.fromDir ?? join(homedir(), ".claude", "skills"));
  const targetPath = resolve(fromDir, name);

  // Belt-and-braces zip-slip guard: even after the segment check, confirm
  // the resolved target really sits under `fromDir`. Catches any odd
  // platform-specific normalization we missed.
  const fromDirWithSep = fromDir.endsWith(sep) ? fromDir : fromDir + sep;
  if (targetPath !== fromDir && !targetPath.startsWith(fromDirWithSep)) {
    throw new Error(
      `uninstall: refusing "${name}" — resolves outside the install root ${fromDir} (path-traversal)`,
    );
  }
  if (targetPath === fromDir) {
    throw new Error(`uninstall: refusing "${name}" — would remove the install root itself`);
  }

  if (!existsSync(targetPath)) {
    throw new Error(`uninstall: ${name} is not installed (no directory at ${targetPath})`);
  }

  const st = await stat(targetPath);
  if (!st.isDirectory()) {
    throw new Error(
      `uninstall: ${targetPath} is not a directory — refusing to delete (install would never have produced this)`,
    );
  }

  // Walk first to compute totals — needed for both dry-run and the
  // CLI-side confirmation prompt. We use a recursive readdir so nested
  // subdirectories (`scripts/`, `docs/`, etc.) are accounted for.
  const { bytes, files } = await walkSize(targetPath);

  if (opts.dryRun) {
    return {
      name,
      path: targetPath,
      bytesFreed: bytes,
      fileCount: files,
      dryRun: true,
    };
  }

  // `rm -rf` semantics scoped to the skill directory only. We deliberately
  // do not touch `fromDir` itself, even when the target is its sole child.
  await rm(targetPath, { recursive: true, force: true });

  return {
    name,
    path: targetPath,
    bytesFreed: bytes,
    fileCount: files,
    dryRun: false,
  };
}

/**
 * Walk a directory tree and sum file sizes + file count. Symlinks are
 * traversed once via `readdir({ withFileTypes: true })`; we deliberately
 * use `stat` (not `lstat`) so any sym-linked file's *target* size is
 * counted — matching what disk space the user will actually reclaim.
 */
async function walkSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walkSize(full);
      bytes += sub.bytes;
      files += sub.files;
      continue;
    }
    // Regular files (and symlink-to-file). Anything exotic — sockets,
    // FIFOs — would be unusual under ~/.claude/skills; stat them anyway
    // so the totals don't silently drift on weird trees.
    try {
      const s = await stat(full);
      if (s.isFile()) {
        bytes += s.size;
        files += 1;
      }
    } catch {
      // Broken symlinks or transient ENOENT: skip the entry rather than
      // failing the whole uninstall. The subsequent `rm -rf` will deal
      // with the on-disk artefact.
    }
  }
  return { bytes, files };
}
