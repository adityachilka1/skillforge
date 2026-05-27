import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listInstalledSkills } from "./ls.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as sibling test files.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-ls-")));
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
  opts: { version?: string; description?: string; skipSkillMd?: boolean } = {},
): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  if (!opts.skipSkillMd) {
    await writeFile(
      join(dir, "SKILL.md"),
      frontmatter({ name, version: opts.version, description: opts.description }),
    );
  }
  return dir;
}

describe("listInstalledSkills — empty dir", () => {
  it("returns count 0 and an empty array for a freshly-created empty directory", async () => {
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.count).toBe(0);
    expect(result.skills).toEqual([]);
    expect(result.fromDir).toBe(workDir);
  });
});

describe("listInstalledSkills — single skill", () => {
  it("returns count 1 with name + version from frontmatter", async () => {
    await writeSkillDir(workDir, "code-review", { version: "1.2.3" });
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.count).toBe(1);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("code-review");
    expect(result.skills[0].version).toBe("1.2.3");
    expect(result.skills[0].source).toBe("dir");
    expect(result.skills[0].valid).toBe(true);
    expect(result.skills[0].path).toBe(join(workDir, "code-review"));
  });
});

describe("listInstalledSkills — sorting", () => {
  it("returns three skills sorted alphabetically by name", async () => {
    await writeSkillDir(workDir, "zebra-skill");
    await writeSkillDir(workDir, "alpha-skill");
    await writeSkillDir(workDir, "middle-skill");
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.count).toBe(3);
    expect(result.skills.map((s) => s.name)).toEqual([
      "alpha-skill",
      "middle-skill",
      "zebra-skill",
    ]);
  });
});

describe("listInstalledSkills — invalid skills", () => {
  it("excludes invalid skills by default", async () => {
    await writeSkillDir(workDir, "valid-one");
    // Invalid: description is too short (zod requires >= 20 chars)
    await writeSkillDir(workDir, "broken-one", { description: "too short" });
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.count).toBe(1);
    expect(result.skills.map((s) => s.name)).toEqual(["valid-one"]);
  });

  it("includes invalid skills with valid: false when includeInvalid is true", async () => {
    await writeSkillDir(workDir, "valid-one");
    await writeSkillDir(workDir, "broken-one", { description: "too short" });
    const result = await listInstalledSkills({ fromDir: workDir, includeInvalid: true });
    expect(result.count).toBe(2);
    const broken = result.skills.find((s) => s.path.endsWith("broken-one"));
    expect(broken).toBeDefined();
    expect(broken?.valid).toBe(false);
    expect(broken?.issues).toBeDefined();
    expect(broken?.issues?.length).toBeGreaterThan(0);
    // valid skill has no `issues` field
    const good = result.skills.find((s) => s.path.endsWith("valid-one"));
    expect(good?.valid).toBe(true);
    expect(good?.issues).toBeUndefined();
  });
});

describe("listInstalledSkills — fromDir override", () => {
  it("uses the explicit fromDir argument instead of the default", async () => {
    await writeSkillDir(workDir, "one");
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.fromDir).toBe(workDir);
    expect(result.count).toBe(1);
  });
});

describe("listInstalledSkills — non-existent dir", () => {
  it("returns count 0 and an empty array when fromDir does not exist (does not throw)", async () => {
    const missing = join(workDir, "does-not-exist");
    const result = await listInstalledSkills({ fromDir: missing });
    expect(result.count).toBe(0);
    expect(result.skills).toEqual([]);
    expect(result.fromDir).toBe(missing);
  });
});

describe("listInstalledSkills — fromDir is a file", () => {
  it("throws a clear error when fromDir points to a file (not a directory)", async () => {
    const file = join(workDir, "iamafile.txt");
    await writeFile(file, "not a dir");
    await expect(listInstalledSkills({ fromDir: file })).rejects.toThrow(/not a directory/);
  });
});

describe("listInstalledSkills — child without SKILL.md", () => {
  it("silently skips child directories that contain no SKILL.md", async () => {
    await writeSkillDir(workDir, "valid-skill");
    await writeSkillDir(workDir, "junk-dir", { skipSkillMd: true });
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.count).toBe(1);
    expect(result.skills.map((s) => s.name)).toEqual(["valid-skill"]);
  });
});

describe("listInstalledSkills — LsResult shape", () => {
  it("returns an object whose keys exactly match the documented LsResult shape", async () => {
    await writeSkillDir(workDir, "demo");
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(Object.keys(result).sort()).toEqual(["count", "fromDir", "skills"]);
    const skill = result.skills[0];
    // valid skill: no `issues`
    expect(Object.keys(skill).sort()).toEqual(["name", "path", "source", "valid", "version"]);
  });
});

describe("listInstalledSkills — ignores non-directory entries", () => {
  it("skips loose files sitting next to skill directories", async () => {
    await writeSkillDir(workDir, "real-skill");
    await writeFile(join(workDir, "stray.txt"), "noise");
    const result = await listInstalledSkills({ fromDir: workDir });
    expect(result.count).toBe(1);
    expect(result.skills[0].name).toBe("real-skill");
  });
});

describe("listInstalledSkills — default fromDir", () => {
  it("uses ~/.claude/skills when no fromDir is provided (smoke-only — does not assert count)", async () => {
    // We can't assert what's in the user's real ~/.claude/skills without
    // touching their machine state, so we just confirm the function resolves
    // and reports the default path.
    const result = await listInstalledSkills();
    expect(result.fromDir).toMatch(/\.claude\/skills$/);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(result.count).toBe(result.skills.length);
  });
});
