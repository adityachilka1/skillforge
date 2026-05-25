import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { treeSkill } from "./tree.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as the sibling test files.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-tree-")));
});

const HEALTHY_SKILL_MD = `---
name: my-skill
description: Use this when the user asks for the demo skill described in this file.
version: 0.1.0
tags: []
---

# my-skill

body body body body body
`;

async function writeSkill(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), HEALTHY_SKILL_MD);
}

describe("treeSkill — happy path", () => {
  it("walks a populated skill dir and matches pack's exclusion rules exactly", async () => {
    const skillDir = join(workDir, "my-skill");
    await writeSkill(skillDir);
    await mkdir(join(skillDir, "templates"), { recursive: true });
    await writeFile(join(skillDir, "templates", "letter.md"), "Dear ...");
    await writeFile(join(skillDir, "tool.py"), "print('hi')");
    // These four must be excluded by the same rules as `pack`:
    await writeFile(join(skillDir, ".DS_Store"), "trash");
    await writeFile(join(skillDir, "debug.log"), "noise");
    await mkdir(join(skillDir, ".git"), { recursive: true });
    await writeFile(join(skillDir, ".git", "HEAD"), "ref: refs/heads/main");
    await mkdir(join(skillDir, "node_modules"), { recursive: true });
    await writeFile(join(skillDir, "node_modules", "foo.js"), "module.exports = 1;");

    const r = await treeSkill({ srcDir: skillDir });

    const paths = r.entries.map((e) => e.path);
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("templates");
    expect(paths).toContain("templates/letter.md");
    expect(paths).toContain("tool.py");
    // Same exclusions as pack — assert each individually for a useful diff.
    expect(paths).not.toContain(".DS_Store");
    expect(paths).not.toContain("debug.log");
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    // File count excludes directories.
    expect(r.totalFiles).toBe(3);
  });
});

describe("treeSkill — minimal dir", () => {
  it("returns exactly one entry for a dir containing only SKILL.md", async () => {
    const skillDir = join(workDir, "tiny");
    await writeSkill(skillDir);
    const r = await treeSkill({ srcDir: skillDir });
    expect(r.entries.map((e) => e.path)).toEqual(["SKILL.md"]);
    expect(r.totalFiles).toBe(1);
    expect(r.totalBytes).toBe(HEALTHY_SKILL_MD.length);
  });
});

describe("treeSkill — sort modes", () => {
  it("default `path` sort returns entries in alphabetised tree order", async () => {
    const skillDir = join(workDir, "sorted");
    await writeSkill(skillDir);
    await writeFile(join(skillDir, "zeta.txt"), "z");
    await writeFile(join(skillDir, "alpha.txt"), "a");
    await mkdir(join(skillDir, "middle"), { recursive: true });
    await writeFile(join(skillDir, "middle", "nested.txt"), "n");

    const r = await treeSkill({ srcDir: skillDir });
    const paths = r.entries.map((e) => e.path);
    // alphabetised: SKILL.md, alpha.txt, middle, middle/nested.txt, zeta.txt
    expect(paths).toEqual(["SKILL.md", "alpha.txt", "middle", "middle/nested.txt", "zeta.txt"]);
  });

  it("`size` sort returns files-only, descending by byte size", async () => {
    const skillDir = join(workDir, "sized");
    await writeSkill(skillDir);
    await writeFile(join(skillDir, "tiny.txt"), "x"); // 1 byte
    await writeFile(join(skillDir, "huge.txt"), "x".repeat(500));
    await writeFile(join(skillDir, "mid.txt"), "x".repeat(100));
    await mkdir(join(skillDir, "subdir"), { recursive: true });
    await writeFile(join(skillDir, "subdir", "leaf.txt"), "x".repeat(50));

    const r = await treeSkill({ srcDir: skillDir, sort: "size" });

    // Directories absent under size-sort.
    expect(r.entries.every((e) => !e.isDir)).toBe(true);
    // Strictly descending by size.
    const sizes = r.entries.map((e) => e.size);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i - 1]).toBeGreaterThanOrEqual(sizes[i]);
    }
    // First entry is `huge.txt` (500 bytes).
    expect(r.entries[0].path).toBe("huge.txt");
    expect(r.entries[0].size).toBe(500);
  });
});

describe("treeSkill — totals are accurate", () => {
  it("sums byte sizes of file entries only", async () => {
    const skillDir = join(workDir, "bytes");
    await writeSkill(skillDir);
    await writeFile(join(skillDir, "a.txt"), "ab"); // 2 bytes
    await writeFile(join(skillDir, "b.txt"), "abcd"); // 4 bytes

    const r = await treeSkill({ srcDir: skillDir });
    expect(r.totalFiles).toBe(3); // SKILL.md + a.txt + b.txt
    expect(r.totalBytes).toBe(HEALTHY_SKILL_MD.length + 2 + 4);
  });
});

describe("treeSkill — error paths", () => {
  it("throws when the path does not exist", async () => {
    await expect(treeSkill({ srcDir: join(workDir, "missing") })).rejects.toThrow(/does not exist/);
  });

  it("throws when the path is a file, not a directory", async () => {
    const filePath = join(workDir, "not-a-dir");
    await writeFile(filePath, "hi");
    await expect(treeSkill({ srcDir: filePath })).rejects.toThrow(/not a directory/);
  });
});

describe("treeSkill — entry shape", () => {
  it("returns POSIX-relative paths and correct isDir flags", async () => {
    const skillDir = join(workDir, "shaped");
    await writeSkill(skillDir);
    await mkdir(join(skillDir, "sub"), { recursive: true });
    await writeFile(join(skillDir, "sub", "leaf.md"), "leaf");

    const r = await treeSkill({ srcDir: skillDir });
    const byPath = new Map(r.entries.map((e) => [e.path, e]));
    expect(byPath.get("SKILL.md")?.isDir).toBe(false);
    expect(byPath.get("sub")?.isDir).toBe(true);
    expect(byPath.get("sub/leaf.md")?.isDir).toBe(false);
    expect(byPath.get("sub/leaf.md")?.size).toBe(4); // "leaf"
    // POSIX separator — never a backslash, even on hypothetical win32 runs.
    for (const p of r.entries.map((e) => e.path)) {
      expect(p.includes("\\")).toBe(false);
    }
  });
});
