import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { uninstallSkill } from "./uninstall.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as sibling test files.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-uninstall-")));
});

const VALID_DESC = "Use this when the user asks for the demo skill described in this file.";

function frontmatter(opts: { name: string; version?: string; description?: string }): string {
  return [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description ?? VALID_DESC}`,
    `version: ${opts.version ?? "0.1.0"}`,
    "tags: []",
    "---",
    "",
    "# body",
    "",
    "Some prose so the body is non-empty.",
    "",
  ].join("\n");
}

async function writeSkillDir(
  parent: string,
  name: string,
  opts: { version?: string; description?: string; extraFiles?: Record<string, string> } = {},
): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    frontmatter({ name, version: opts.version, description: opts.description }),
  );
  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

describe("uninstallSkill — happy path", () => {
  it("removes an installed skill directory and reports path + bytes + file count", async () => {
    const dir = await writeSkillDir(workDir, "demo-skill", {
      extraFiles: { "scripts/run.sh": "#!/bin/sh\necho hi\n" },
    });
    expect(existsSync(dir)).toBe(true);

    const result = await uninstallSkill({ name: "demo-skill", fromDir: workDir });

    expect(result.name).toBe("demo-skill");
    expect(result.path).toBe(dir);
    expect(result.dryRun).toBe(false);
    expect(result.fileCount).toBe(2); // SKILL.md + scripts/run.sh
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("uninstallSkill — non-existent target", () => {
  it("throws a clear error when the named skill is not installed", async () => {
    await expect(uninstallSkill({ name: "nope-not-here", fromDir: workDir })).rejects.toThrow(
      /not installed|does not exist/i,
    );
  });
});

describe("uninstallSkill — dry-run", () => {
  it("reports counts and bytes without deleting anything when dryRun is true", async () => {
    const dir = await writeSkillDir(workDir, "demo-skill");
    const before = existsSync(dir);
    expect(before).toBe(true);

    const result = await uninstallSkill({
      name: "demo-skill",
      fromDir: workDir,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.path).toBe(dir);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.bytesFreed).toBeGreaterThan(0);
    // Directory still exists after a dry-run.
    expect(existsSync(dir)).toBe(true);
    // SKILL.md content still on disk verbatim.
    const raw = await readFile(join(dir, "SKILL.md"), "utf8");
    expect(raw).toContain("name: demo-skill");
  });
});

describe("uninstallSkill — fromDir override", () => {
  it("honours an explicit fromDir argument instead of ~/.claude/skills", async () => {
    const altRoot = join(workDir, "alt-root");
    await mkdir(altRoot, { recursive: true });
    const dir = await writeSkillDir(altRoot, "demo-skill");

    const result = await uninstallSkill({ name: "demo-skill", fromDir: altRoot });

    expect(result.path).toBe(dir);
    expect(existsSync(dir)).toBe(false);
    // The alt-root parent dir itself is untouched.
    expect(existsSync(altRoot)).toBe(true);
  });
});

describe("uninstallSkill — path safety", () => {
  it("refuses a name that contains path-traversal segments (zip-slip style)", async () => {
    await expect(uninstallSkill({ name: "../escape", fromDir: workDir })).rejects.toThrow(
      /path|traversal|outside|invalid/i,
    );
  });

  it("refuses an absolute-style name that would escape fromDir", async () => {
    await expect(uninstallSkill({ name: "/etc", fromDir: workDir })).rejects.toThrow(
      /path|traversal|outside|invalid|separator/i,
    );
  });

  it("refuses a name containing a path separator", async () => {
    await expect(uninstallSkill({ name: "nested/skill", fromDir: workDir })).rejects.toThrow(
      /path|separator|invalid/i,
    );
  });
});

describe("uninstallSkill — non-directory target", () => {
  it("refuses to delete when the target path is a file, not a directory", async () => {
    // Plant a file where a skill dir is expected.
    await writeFile(join(workDir, "ghost-skill"), "i am a file");
    await expect(uninstallSkill({ name: "ghost-skill", fromDir: workDir })).rejects.toThrow(
      /not a directory/i,
    );
    // The file is untouched.
    expect(existsSync(join(workDir, "ghost-skill"))).toBe(true);
  });
});

describe("uninstallSkill — empty / whitespace name", () => {
  it("refuses an empty-string name", async () => {
    await expect(uninstallSkill({ name: "", fromDir: workDir })).rejects.toThrow(
      /name|empty|required/i,
    );
  });

  it("refuses a whitespace-only name", async () => {
    await expect(uninstallSkill({ name: "   ", fromDir: workDir })).rejects.toThrow(
      /name|empty|whitespace/i,
    );
  });
});

describe("uninstallSkill — bytes accounting", () => {
  it("bytesFreed equals the on-disk size of all files walked", async () => {
    const skillMd = frontmatter({ name: "size-skill" });
    const payload = "x".repeat(1024);
    const dir = join(workDir, "size-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skillMd);
    await writeFile(join(dir, "blob.txt"), payload);

    const skillSize = (await stat(join(dir, "SKILL.md"))).size;
    const blobSize = (await stat(join(dir, "blob.txt"))).size;
    const expected = skillSize + blobSize;

    const result = await uninstallSkill({ name: "size-skill", fromDir: workDir });
    expect(result.bytesFreed).toBe(expected);
    expect(result.fileCount).toBe(2);
  });
});

describe("uninstallSkill — nested files", () => {
  it("counts and removes files inside nested subdirectories", async () => {
    await writeSkillDir(workDir, "nested-skill", {
      extraFiles: {
        "scripts/a.sh": "a",
        "scripts/sub/b.sh": "bb",
        "docs/c.md": "ccc",
      },
    });
    const result = await uninstallSkill({ name: "nested-skill", fromDir: workDir });
    expect(result.fileCount).toBe(4); // SKILL.md + 3 extras
    expect(existsSync(join(workDir, "nested-skill"))).toBe(false);
  });
});

describe("uninstallSkill — UninstallResult shape", () => {
  it("returns an object whose keys exactly match the documented UninstallResult shape", async () => {
    await writeSkillDir(workDir, "shape-skill");
    const result = await uninstallSkill({ name: "shape-skill", fromDir: workDir });
    expect(Object.keys(result).sort()).toEqual([
      "bytesFreed",
      "dryRun",
      "fileCount",
      "name",
      "path",
    ]);
  });
});

describe("uninstallSkill — does not touch siblings", () => {
  it("removes only the target skill, leaving sibling skill dirs intact", async () => {
    const a = await writeSkillDir(workDir, "skill-a");
    const b = await writeSkillDir(workDir, "skill-b");
    const c = await writeSkillDir(workDir, "skill-c");

    await uninstallSkill({ name: "skill-b", fromDir: workDir });

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(true);
  });
});
