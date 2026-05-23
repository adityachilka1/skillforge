/**
 * `skillforge pack <dir> [--out <file>]` — bundle a skill directory into a
 * `.skill` archive.
 *
 * A `.skill` file is a zip whose root contains a SKILL.md plus any
 * supporting files (templates, fixtures, scripts). Cowork and other
 * Claude-skill installers recognize this extension and let the user
 * one-click install the bundle. See:
 *   https://docs.claude.com/en/docs/agents-and-skills/skills
 *
 * We validate the SKILL.md before packing — packing a broken skill is
 * almost always a mistake, and surfacing the validation error here saves
 * the user from publishing a `.skill` that the installer will reject.
 *
 * Standard exclusions (always skipped): `.git`, `node_modules`,
 * `.DS_Store`, `*.log`, the output `.skill` file itself, and any path
 * starting with a dot at the top level. These are the usual VCS / OS
 * cruft you never want shipped to end users.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { validateSkill } from "./validate.js";

export interface PackOptions {
  /** Directory containing a SKILL.md file. */
  srcDir: string;
  /** Output path. Defaults to `<dirname>.skill` in the current working directory. */
  outPath?: string;
  /**
   * Skip the SKILL.md validation step. Off by default — packing a known-broken
   * skill is almost always a mistake. Useful for tests of the packer itself.
   */
  skipValidation?: boolean;
}

export interface PackResult {
  outPath: string;
  /** Absolute paths included in the archive, in archive order. */
  files: string[];
  /** Bytes written. */
  size: number;
}

const DEFAULT_EXCLUDES = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Walks `srcDir`, zips every non-excluded file into a `.skill` archive, and
 * writes it to disk. Returns the on-disk path and an inventory.
 */
export async function packSkill(opts: PackOptions): Promise<PackResult> {
  const src = resolve(opts.srcDir);
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) {
    throw new Error(`pack: ${opts.srcDir} is not a directory`);
  }

  const skillMd = join(src, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`pack: ${src} does not contain a SKILL.md`);
  }

  if (!opts.skipValidation) {
    const result = await validateSkill(skillMd);
    if (!result.ok) {
      throw new Error(
        `pack: SKILL.md is invalid — fix these first, then re-run pack:\n  - ${result.issues.join("\n  - ")}`,
      );
    }
  }

  const dirName = basename(src);
  const outPath = opts.outPath ? resolve(opts.outPath) : resolve(process.cwd(), `${dirName}.skill`);

  const zip = new JSZip();
  const files: string[] = [];
  await walk(src, src, zip, files, outPath);

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  // Write via fs/promises to keep the call site purely async.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, bytes);
  return { outPath, files, size: bytes.byteLength };
}

async function walk(
  rootDir: string,
  currentDir: string,
  zip: JSZip,
  files: string[],
  outPath: string,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) continue;
    const abs = join(currentDir, entry.name);
    if (abs === outPath) continue; // never zip ourselves into ourselves
    const rel = relative(rootDir, abs).split(sep).join("/"); // POSIX paths inside zip
    if (entry.isDirectory()) {
      await walk(rootDir, abs, zip, files, outPath);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks, sockets, FIFOs
    const data = await readFile(abs);
    zip.file(rel, data);
    files.push(abs);
  }
}

function shouldExclude(name: string): boolean {
  if (DEFAULT_EXCLUDES.has(name)) return true;
  if (name.endsWith(".log")) return true;
  // Hidden files at any depth — keep VCS / editor cruft out of bundles.
  if (name.startsWith(".")) return true;
  return false;
}
