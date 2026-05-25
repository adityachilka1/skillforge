import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { catSkill } from "./cat.js";
import { packSkill } from "./pack.js";

let workDir: string;

beforeEach(async () => {
  // realpath dodges the macOS `/tmp` vs `/private/tmp` mismatch — `tmpdir()`
  // returns `/tmp`, but resolved paths surface as `/private/tmp`, which
  // breaks string equality assertions on absolute paths.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-cat-")));
});

const HEALTHY_SKILL_MD = `---
name: my-skill
description: Use this when the user asks for the demo skill described in this file's body.
version: 0.1.0
tags: []
---

# my-skill

First body line of the cat fixture.
Line two.
Line three.
Line four.
Line five.
`;

async function writeSkill(dir: string, contents = HEALTHY_SKILL_MD): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), contents);
}

async function packToArchive(dir: string, outBase: string): Promise<string> {
  // Reuse the real packer so the fixture archive matches what `pack`
  // produces in the wild — same compression, same root layout. We pass an
  // explicit outPath so the file lands in `workDir` rather than cwd.
  const outPath = join(workDir, `${outBase}.skill`);
  await packSkill({ srcDir: dir, outPath });
  return outPath;
}

describe("catSkill — .skill archive", () => {
  it("reads SKILL.md from a packed .skill archive and returns the full file", async () => {
    const skillDir = join(workDir, "my-skill");
    await writeSkill(skillDir);
    const archive = await packToArchive(skillDir, "my-skill");

    const r = await catSkill({ path: archive });
    expect(r.name).toBe("my-skill");
    expect(r.version).toBe("0.1.0");
    expect(r.raw).toBe(HEALTHY_SKILL_MD);
    expect(r.content).toBe(HEALTHY_SKILL_MD);
  });

  it("reads SKILL.md from a packed .skill archive even with other files alongside", async () => {
    const skillDir = join(workDir, "my-skill");
    await writeSkill(skillDir);
    await writeFile(join(skillDir, "tool.py"), "print('hi')");
    await mkdir(join(skillDir, "templates"), { recursive: true });
    await writeFile(join(skillDir, "templates", "letter.md"), "Dear …");
    const archive = await packToArchive(skillDir, "my-skill-multi");

    const r = await catSkill({ path: archive });
    expect(r.name).toBe("my-skill");
    // The sibling files don't bleed into the output — `cat` is SKILL.md only.
    expect(r.raw).toBe(HEALTHY_SKILL_MD);
    expect(r.raw).not.toContain("print('hi')");
    expect(r.raw).not.toContain("Dear");
  });
});

describe("catSkill — file & directory inputs", () => {
  it("reads SKILL.md directly when the path is a file", async () => {
    const skillFile = join(workDir, "SKILL.md");
    await writeFile(skillFile, HEALTHY_SKILL_MD);

    const r = await catSkill({ path: skillFile });
    expect(r.name).toBe("my-skill");
    expect(r.raw).toBe(HEALTHY_SKILL_MD);
  });

  it("reads SKILL.md when the path is a directory containing one", async () => {
    const skillDir = join(workDir, "from-dir");
    await writeSkill(skillDir);

    const r = await catSkill({ path: skillDir });
    expect(r.name).toBe("my-skill");
    expect(r.raw).toBe(HEALTHY_SKILL_MD);
  });
});

describe("catSkill — section slicing", () => {
  it("section=frontmatter returns just the YAML block, no --- fences", async () => {
    const skillFile = join(workDir, "SKILL.md");
    await writeFile(skillFile, HEALTHY_SKILL_MD);

    const r = await catSkill({ path: skillFile, section: "frontmatter" });
    expect(r.content).toContain("name: my-skill");
    expect(r.content).toContain("version: 0.1.0");
    // No fences in the slice.
    expect(r.content.startsWith("---")).toBe(false);
    expect(r.content.endsWith("---")).toBe(false);
    // Body lines not present in the frontmatter slice.
    expect(r.content).not.toContain("First body line");
    // The full raw file is still available on the result.
    expect(r.raw).toBe(HEALTHY_SKILL_MD);
  });

  it("section=body returns the markdown body without any --- fences", async () => {
    const skillFile = join(workDir, "SKILL.md");
    await writeFile(skillFile, HEALTHY_SKILL_MD);

    const r = await catSkill({ path: skillFile, section: "body" });
    expect(r.content).not.toContain("---");
    expect(r.content).not.toContain("name: my-skill");
    expect(r.content.startsWith("# my-skill")).toBe(true);
    expect(r.content).toContain("First body line of the cat fixture.");
  });

  it("section=all (default) returns the raw bytes verbatim", async () => {
    const skillFile = join(workDir, "SKILL.md");
    await writeFile(skillFile, HEALTHY_SKILL_MD);

    const r = await catSkill({ path: skillFile, section: "all" });
    expect(r.content).toBe(HEALTHY_SKILL_MD);
  });
});

describe("catSkill — frontmatter validation", () => {
  it("refuses a .skill with broken frontmatter (description too short)", async () => {
    // Pack with --skip-validation so we can produce a deliberately-broken
    // archive — `cat` is the one being tested here, not `pack`.
    const skillDir = join(workDir, "broken");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: broken-skill
description: too short
version: 0.0.1
tags: []
---

body
`,
    );
    const outPath = join(workDir, "broken.skill");
    await packSkill({ srcDir: skillDir, outPath, skipValidation: true });

    await expect(catSkill({ path: outPath })).rejects.toThrow(/invalid frontmatter/);
  });

  it("refuses a SKILL.md file with no frontmatter block at all", async () => {
    const skillFile = join(workDir, "no-frontmatter.md");
    await writeFile(skillFile, "# just a heading, no YAML frontmatter at all\n");
    // Without frontmatter, gray-matter returns `data: {}` and the schema
    // rejects on `name`/`description`. The error surfaces as "invalid
    // frontmatter" — same code path as a malformed-YAML archive.
    await expect(catSkill({ path: skillFile })).rejects.toThrow(/invalid frontmatter/);
  });
});

describe("catSkill — error paths", () => {
  it("throws when the path does not exist", async () => {
    await expect(catSkill({ path: join(workDir, "missing.skill") })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("throws when a directory has no SKILL.md", async () => {
    const emptyDir = join(workDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    await expect(catSkill({ path: emptyDir })).rejects.toThrow(/does not contain a SKILL\.md/);
  });

  it("throws when the .skill archive has no SKILL.md at the root", async () => {
    // Build a zip whose SKILL.md lives in a nested directory — same shape
    // as `install` rejects. We hand-roll it via JSZip rather than `pack`
    // because `pack` always puts SKILL.md at the root.
    const JSZipMod = (await import("jszip")).default;
    const zip = new JSZipMod();
    zip.file("nested/SKILL.md", HEALTHY_SKILL_MD);
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const archive = join(workDir, "nested.skill");
    await writeFile(archive, buf);

    await expect(catSkill({ path: archive })).rejects.toThrow(/SKILL\.md at the archive root/);
  });

  it("throws when a .skill file is not a valid zip", async () => {
    const archive = join(workDir, "not-really.skill");
    await writeFile(archive, "this is not zip data, just plain text");
    await expect(catSkill({ path: archive })).rejects.toThrow(/is not a valid \.skill/);
  });
});

describe("catSkill — result shape", () => {
  it("returns name + version + content + raw on the happy path", async () => {
    const skillFile = join(workDir, "SKILL.md");
    await writeFile(skillFile, HEALTHY_SKILL_MD);

    const r = await catSkill({ path: skillFile });
    expect(r.path).toBe(skillFile);
    expect(typeof r.name).toBe("string");
    expect(typeof r.version).toBe("string");
    expect(typeof r.content).toBe("string");
    expect(typeof r.raw).toBe("string");
    // Schema's semver pattern — version is always a non-empty parsed string.
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
