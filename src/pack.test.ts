import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packSkill } from "./pack.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while `process.cwd()`
  // after `chdir` reports the resolved `/private/tmp` — defeats string
  // equality on the default-output-path assertion.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-pack-")));
});

afterEach(async () => {
  // Tests are tiny; leave the tmpdir for postmortem. macOS cleans /tmp on reboot.
});

async function writeValidSkill(dir: string, name = "my-skill"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: This is a long-enough description so the schema validator is happy with it.
version: 0.0.1
tags: []
---

# ${name}

Real body content that is at least five lines long so the
validator doesn't complain about a placeholder body.

Line three.
Line four.
Line five.
`,
  );
}

async function listZipEntries(zipPath: string): Promise<string[]> {
  const buf = await readFile(zipPath);
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files).sort();
}

describe("packSkill", () => {
  it("produces a .skill archive containing SKILL.md and supporting files", async () => {
    const skillDir = join(workDir, "my-skill");
    await writeValidSkill(skillDir);
    await mkdir(join(skillDir, "templates"));
    await writeFile(join(skillDir, "templates", "letter.md"), "Dear ...");
    await writeFile(join(skillDir, "tool.py"), "print('hi')");

    const result = await packSkill({ srcDir: skillDir, outPath: join(workDir, "out.skill") });

    expect(result.size).toBeGreaterThan(0);
    expect(result.files.length).toBe(3);
    const entries = await listZipEntries(result.outPath);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("templates/letter.md");
    expect(entries).toContain("tool.py");
  });

  it("defaults the output path to <basename>.skill in cwd", async () => {
    const skillDir = join(workDir, "default-out-skill");
    await writeValidSkill(skillDir, "default-out-skill");
    const cwd = process.cwd();
    process.chdir(workDir);
    try {
      const result = await packSkill({ srcDir: skillDir });
      expect(result.outPath).toBe(join(workDir, "default-out-skill.skill"));
    } finally {
      process.chdir(cwd);
    }
  });

  it("excludes .git, node_modules, hidden files, and *.log", async () => {
    const skillDir = join(workDir, "noisy-skill");
    await writeValidSkill(skillDir);
    await mkdir(join(skillDir, ".git"));
    await writeFile(join(skillDir, ".git", "HEAD"), "ref: x");
    await mkdir(join(skillDir, "node_modules"));
    await writeFile(join(skillDir, "node_modules", "foo.js"), "");
    await writeFile(join(skillDir, ".DS_Store"), "");
    await writeFile(join(skillDir, "debug.log"), "junk");
    await writeFile(join(skillDir, ".env"), "SECRET=keep-out");

    const result = await packSkill({ srcDir: skillDir, outPath: join(workDir, "noisy.skill") });

    const entries = await listZipEntries(result.outPath);
    expect(entries).toEqual(["SKILL.md"]);
    expect(entries.some((e) => e.includes(".git"))).toBe(false);
    expect(entries.some((e) => e.includes("node_modules"))).toBe(false);
    expect(entries.some((e) => e.includes(".env"))).toBe(false);
    expect(entries.some((e) => e.endsWith(".log"))).toBe(false);
  });

  it("never zips the output file into itself when out is inside srcDir", async () => {
    const skillDir = join(workDir, "self-skill");
    await writeValidSkill(skillDir);
    const outInside = join(skillDir, "self-skill.skill");
    // Pre-create the output file to make sure it's present during the walk.
    await writeFile(outInside, "stale");
    const result = await packSkill({ srcDir: skillDir, outPath: outInside });
    const entries = await listZipEntries(result.outPath);
    expect(entries).toEqual(["SKILL.md"]);
  });

  it("rejects a non-directory srcDir", async () => {
    const filePath = join(workDir, "not-a-dir");
    await writeFile(filePath, "hi");
    await expect(packSkill({ srcDir: filePath })).rejects.toThrow(/not a directory/);
  });

  it("rejects a srcDir with no SKILL.md", async () => {
    const empty = join(workDir, "empty");
    await mkdir(empty);
    await expect(packSkill({ srcDir: empty })).rejects.toThrow(/does not contain a SKILL.md/);
  });

  it("refuses to pack an invalid SKILL.md and reports the issues", async () => {
    const broken = join(workDir, "broken");
    await mkdir(broken);
    await writeFile(
      join(broken, "SKILL.md"),
      `---
name: ${"x"}
description: too short
---

body
`,
    );
    await expect(packSkill({ srcDir: broken })).rejects.toThrow(/description must be at least/);
  });

  it("can skip validation when explicitly opted into (used by packer tests)", async () => {
    const broken = join(workDir, "broken-allowed");
    await mkdir(broken);
    await writeFile(join(broken, "SKILL.md"), "---\nname: x\ndescription: too short\n---\nbody\n");
    const out = join(workDir, "broken-allowed.skill");
    const result = await packSkill({ srcDir: broken, outPath: out, skipValidation: true });
    expect(result.size).toBeGreaterThan(0);
  });
});
