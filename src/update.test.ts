import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { beforeEach, describe, expect, it } from "vitest";
import { bumpVersion, updateSkillVersion } from "./update.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as pack.test.ts.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-update-")));
});

interface SkillOverrides {
  name?: string;
  description?: string;
  version?: string;
  tags?: string;
  body?: string;
  /** Lets a test write totally custom frontmatter (e.g. unusual field order). */
  customFrontmatter?: string;
}

const DEFAULT_BODY = `# my-skill

## What this skill does

Real prose. Real prose. Real prose. Real prose.

## When to use

When the agent wants to demonstrate something.

## Examples

\`\`\`
example
\`\`\`
`;

async function writeSkill(dir: string, o: SkillOverrides = {}): Promise<string> {
  const file = join(dir, "SKILL.md");
  if (o.customFrontmatter) {
    await writeFile(file, `---\n${o.customFrontmatter}\n---\n\n${o.body ?? DEFAULT_BODY}`);
    return file;
  }
  const fm = [
    `name: ${o.name ?? "my-skill"}`,
    `description: ${o.description ?? "Use this when the user asks for the demo skill described in this file."}`,
    `version: ${o.version ?? "1.2.3"}`,
    `tags: ${o.tags ?? "[]"}`,
  ].join("\n");
  await writeFile(file, `---\n${fm}\n---\n\n${o.body ?? DEFAULT_BODY}`);
  return file;
}

describe("bumpVersion", () => {
  it("patch increments the patch component", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("minor increments minor and zeroes patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("major increments major and zeroes minor/patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("drops prerelease tag on patch bump (npm-style)", () => {
    expect(bumpVersion("1.2.3-beta", "patch")).toBe("1.2.4");
  });

  it("drops prerelease tag on minor bump", () => {
    expect(bumpVersion("1.2.3-beta.1", "minor")).toBe("1.3.0");
  });

  it("drops prerelease tag on major bump", () => {
    expect(bumpVersion("1.2.3-rc.1", "major")).toBe("2.0.0");
  });

  it("throws on unparseable input", () => {
    expect(() => bumpVersion("not-semver", "patch")).toThrow(/cannot parse/);
  });
});

describe("updateSkillVersion — bump from 1.2.3", () => {
  it("patch → 1.2.4", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    const r = await updateSkillVersion({ path: f, bump: "patch" });
    expect(r.oldVersion).toBe("1.2.3");
    expect(r.newVersion).toBe("1.2.4");
    expect(r.dryRun).toBe(false);
    const written = await readFile(f, "utf8");
    expect(matter(written).data.version).toBe("1.2.4");
  });

  it("minor → 1.3.0", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    const r = await updateSkillVersion({ path: f, bump: "minor" });
    expect(r.newVersion).toBe("1.3.0");
    const written = await readFile(f, "utf8");
    expect(matter(written).data.version).toBe("1.3.0");
  });

  it("major → 2.0.0", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    const r = await updateSkillVersion({ path: f, bump: "major" });
    expect(r.newVersion).toBe("2.0.0");
    const written = await readFile(f, "utf8");
    expect(matter(written).data.version).toBe("2.0.0");
  });
});

describe("updateSkillVersion — schema default baseline", () => {
  it("bumps from 0.0.1 when version field is absent", async () => {
    // No `version:` line in the frontmatter at all.
    const customFm = [
      "name: schema-default",
      "description: Use this when the user wants to demonstrate the schema-default baseline behaviour.",
      "tags: []",
    ].join("\n");
    const f = await writeSkill(workDir, { customFrontmatter: customFm });
    const r = await updateSkillVersion({ path: f, bump: "patch" });
    expect(r.oldVersion).toBe("0.0.1");
    expect(r.newVersion).toBe("0.0.2");
    const written = await readFile(f, "utf8");
    expect(matter(written).data.version).toBe("0.0.2");
  });
});

describe("updateSkillVersion — prerelease handling", () => {
  it("strips -beta on patch bump", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3-beta" });
    const r = await updateSkillVersion({ path: f, bump: "patch" });
    expect(r.newVersion).toBe("1.2.4");
    const written = await readFile(f, "utf8");
    expect(written).toContain("version: 1.2.4");
    expect(written).not.toContain("beta");
  });

  it("strips -rc.1 on major bump", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3-rc.1" });
    const r = await updateSkillVersion({ path: f, bump: "major" });
    expect(r.newVersion).toBe("2.0.0");
  });
});

describe("updateSkillVersion — dry-run", () => {
  it("reports the new version but writes nothing", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    const before = await readFile(f, "utf8");
    const r = await updateSkillVersion({ path: f, bump: "minor", dryRun: true });
    expect(r.newVersion).toBe("1.3.0");
    expect(r.dryRun).toBe(true);
    const after = await readFile(f, "utf8");
    expect(after).toBe(before);
  });
});

describe("updateSkillVersion — --new-version path", () => {
  it("accepts a valid semver string", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    const r = await updateSkillVersion({ path: f, newVersion: "9.9.9" });
    expect(r.newVersion).toBe("9.9.9");
    const written = await readFile(f, "utf8");
    expect(matter(written).data.version).toBe("9.9.9");
  });

  it("accepts a prerelease semver", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    const r = await updateSkillVersion({ path: f, newVersion: "2.0.0-beta.1" });
    expect(r.newVersion).toBe("2.0.0-beta.1");
  });

  it("rejects garbage semver", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    await expect(updateSkillVersion({ path: f, newVersion: "not-a-version" })).rejects.toThrow(
      /not valid semver/,
    );
  });

  it("rejects partial semver like '1.2'", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    await expect(updateSkillVersion({ path: f, newVersion: "1.2" })).rejects.toThrow(
      /not valid semver/,
    );
  });
});

describe("updateSkillVersion — body preservation", () => {
  it("leaves the body bytes byte-for-byte identical (prose + code blocks + lists)", async () => {
    const richBody = `# my-skill

## What this skill does

A paragraph with *italic*, **bold**, and \`inline code\`.

## When to use

- bullet one
- bullet two
  - nested bullet
- bullet three

## Instructions

1. ordered step
2. another step

## Examples

\`\`\`python
def hello():
    # comment with    trailing    spaces in the middle
    print("hi")
\`\`\`

> A blockquote with a [link](https://example.com).

Trailing line.
`;
    const f = await writeSkill(workDir, { version: "1.2.3", body: richBody });
    const before = await readFile(f, "utf8");
    const beforeBody = before.slice(before.indexOf("\n---\n") + 5);

    await updateSkillVersion({ path: f, bump: "patch" });

    const after = await readFile(f, "utf8");
    const afterBody = after.slice(after.indexOf("\n---\n") + 5);
    expect(afterBody).toBe(beforeBody);
  });
});

describe("updateSkillVersion — frontmatter field-order preservation", () => {
  it("preserves a non-trivial field order (name, version, description, tags)", async () => {
    const customFm = [
      "name: order-test",
      "version: 1.2.3",
      "description: Use this when verifying that the version bump does not reorder frontmatter fields.",
      "tags: [a, b]",
      "author: '@adityachilka1'",
    ].join("\n");
    const f = await writeSkill(workDir, { customFrontmatter: customFm });
    await updateSkillVersion({ path: f, bump: "patch" });
    const after = await readFile(f, "utf8");
    // Extract just the frontmatter block (between the two `---` fences).
    const lines = after.split("\n");
    const closeIdx = lines.indexOf("---", 1);
    const fmLines = lines.slice(1, closeIdx);
    const keysInOrder = fmLines.map((l) => l.split(":")[0].trim()).filter((k) => k.length > 0);
    expect(keysInOrder).toEqual(["name", "version", "description", "tags", "author"]);
    // And the version actually changed.
    expect(fmLines.find((l) => l.startsWith("version:"))).toBe("version: 1.2.4");
  });

  it("preserves indentation and colon spacing on the version line", async () => {
    const customFm = [
      "name: spacing-test",
      `description: ${"x".repeat(40)}`,
      "version:    1.2.3",
    ].join("\n");
    const f = await writeSkill(workDir, { customFrontmatter: customFm });
    await updateSkillVersion({ path: f, bump: "patch" });
    const after = await readFile(f, "utf8");
    // Original had four spaces after the colon; we preserve that whitespace.
    expect(after).toContain("version:    1.2.4");
  });
});

describe("updateSkillVersion — error paths", () => {
  it("throws when the file does not exist", async () => {
    await expect(
      updateSkillVersion({ path: join(workDir, "missing.md"), bump: "patch" }),
    ).rejects.toThrow(/does not exist/);
  });

  it("throws when given a directory without a SKILL.md", async () => {
    await expect(updateSkillVersion({ path: workDir, bump: "patch" })).rejects.toThrow(
      /does not contain a SKILL\.md/,
    );
  });

  it("resolves SKILL.md from a directory path", async () => {
    await writeSkill(workDir, { version: "1.2.3" });
    const r = await updateSkillVersion({ path: workDir, bump: "patch" });
    expect(r.newVersion).toBe("1.2.4");
    expect(r.path).toBe(join(workDir, "SKILL.md"));
  });

  it("throws when both bump and newVersion are supplied", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    await expect(
      updateSkillVersion({ path: f, bump: "patch", newVersion: "9.9.9" }),
    ).rejects.toThrow(/exactly one of/);
  });

  it("throws when neither bump nor newVersion is supplied", async () => {
    const f = await writeSkill(workDir, { version: "1.2.3" });
    await expect(updateSkillVersion({ path: f })).rejects.toThrow(/pass one of/);
  });

  it("refuses to write when the resulting frontmatter fails schema validation", async () => {
    // description is too short — schema demands >= 20 chars. The bump
    // itself is fine, but the file would still be invalid after writing,
    // so we refuse.
    const customFm = ["name: too-short", "description: tiny", "version: 1.2.3"].join("\n");
    const f = await writeSkill(workDir, { customFrontmatter: customFm });
    const before = await readFile(f, "utf8");
    await expect(updateSkillVersion({ path: f, bump: "patch" })).rejects.toThrow(
      /resulting frontmatter is invalid/,
    );
    // And it didn't half-write the file.
    const after = await readFile(f, "utf8");
    expect(after).toBe(before);
  });
});
