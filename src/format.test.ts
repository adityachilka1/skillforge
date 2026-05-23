import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { beforeEach, describe, expect, it } from "vitest";
import { formatSkill } from "./format.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as update.test.ts / pack.test.ts.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-format-")));
});

const VALID_DESC = "Use this when the user asks for the demo skill described in this file.";
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

async function writeRaw(content: string): Promise<string> {
  const file = join(workDir, "SKILL.md");
  await writeFile(file, content);
  return file;
}

describe("formatSkill — frontmatter reordering", () => {
  it("reorders alphabetically-scrambled frontmatter into canonical order", async () => {
    // Author wrote keys in a weird order — alphabetical, which is NOT the
    // canonical schema order.
    const scrambled = [
      "---",
      "author: '@adityachilka1'",
      `description: ${VALID_DESC}`,
      "homepage: https://example.com",
      "name: my-skill",
      "tags: [a, b]",
      "version: 1.2.3",
      "---",
      "",
      DEFAULT_BODY,
    ].join("\n");
    const f = await writeRaw(scrambled);
    const r = await formatSkill({ path: f });
    expect(r.changed).toBe(true);
    const after = await readFile(f, "utf8");
    const lines = after.split("\n");
    const closeIdx = lines.indexOf("---", 1);
    const fmLines = lines.slice(1, closeIdx);
    const keysInOrder = fmLines.map((l) => l.split(":")[0].trim());
    expect(keysInOrder).toEqual(["name", "description", "version", "tags", "author", "homepage"]);
  });

  it("preserves passthrough fields alphabetized at the end", async () => {
    // `zeta` and `aardvark` are unknown to the schema — should land after
    // canonical keys, alphabetized.
    const fm = [
      "---",
      "name: passthrough-test",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "zeta: last-alphabetically-but-first-in-source",
      "aardvark: first-alphabetically",
      "tags: [a]",
      "middle: in-the-middle",
      "---",
      "",
      DEFAULT_BODY,
    ].join("\n");
    const f = await writeRaw(fm);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    const lines = after.split("\n");
    const closeIdx = lines.indexOf("---", 1);
    const fmLines = lines.slice(1, closeIdx);
    const keysInOrder = fmLines.map((l) => l.split(":")[0].trim());
    expect(keysInOrder).toEqual([
      "name",
      "description",
      "version",
      "tags",
      "aardvark",
      "middle",
      "zeta",
    ]);
  });

  it("coerces stringy tags '[]' back to an empty array", async () => {
    const fm = [
      "---",
      "name: coerce-test",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      'tags: "[]"',
      "---",
      "",
      DEFAULT_BODY,
    ].join("\n");
    const f = await writeRaw(fm);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    // gray-matter should parse the coerced form as a real array.
    expect(matter(after).data.tags).toEqual([]);
    // And the on-disk form is the YAML primitive, not the string.
    expect(after).toContain("tags: []");
    expect(after).not.toContain('tags: "[]"');
  });
});

describe("formatSkill — whitespace normalization", () => {
  it("strips trailing whitespace from frontmatter and body lines", async () => {
    const dirty = [
      "---",
      "name: dirty-ws   ",
      `description: ${VALID_DESC}\t`,
      "version: 1.0.0  ",
      "tags: []",
      "---",
      "",
      "# my-skill   ",
      "",
      "Some prose with trailing tabs.\t\t",
      "",
      "## When to use",
      "",
      "When the agent wants to demonstrate something.",
      "",
      "## Examples",
      "",
      "Example body.",
      "",
    ].join("\n");
    const f = await writeRaw(dirty);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    // No trailing whitespace anywhere.
    expect(after.split("\n").some((l) => /[ \t]+$/.test(l))).toBe(false);
  });

  it("collapses runs of 4+ blank lines down to exactly 2", async () => {
    const blanks = [
      "---",
      "name: blanks",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "tags: []",
      "---",
      "",
      "# my-skill",
      "",
      "first paragraph",
      "",
      "",
      "",
      "",
      "",
      "second paragraph after lots of blanks",
      "",
    ].join("\n");
    const f = await writeRaw(blanks);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    // Should never see 3 consecutive blank lines anywhere in the body.
    expect(after).not.toMatch(/\n\n\n\n/);
    expect(after).toContain("first paragraph\n\n\nsecond paragraph"); // exactly 2 blanks between
  });

  it("adds exactly one trailing newline if missing", async () => {
    const noTrailing = [
      "---",
      "name: no-trail",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "tags: []",
      "---",
      "",
      "# my-skill",
      "",
      "body without trailing newline",
    ].join("\n"); // ends without \n
    const f = await writeRaw(noTrailing);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(after.endsWith("\n\n")).toBe(false);
  });

  it("collapses multiple trailing newlines to exactly one", async () => {
    const fm = [
      "---",
      "name: many-trails",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "tags: []",
      "---",
      "",
      "# my-skill",
      "",
      "body",
      "",
      "",
      "",
      "",
    ].join("\n");
    const f = await writeRaw(fm);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(after.endsWith("\n\n")).toBe(false);
  });
});

describe("formatSkill — code block preservation", () => {
  it("preserves fenced code block contents verbatim (extra whitespace untouched)", async () => {
    // The code block has trailing whitespace and runs of blank lines that
    // would be normalized OUTSIDE a fence — they must survive.
    const codeBody = [
      "# code-preserve",
      "",
      "## Examples",
      "",
      "```python",
      "def hello():   ",
      "    # trailing spaces above must survive   ",
      "",
      "",
      "",
      "",
      "    print('hi')",
      "```",
      "",
    ].join("\n");
    const fm = [
      "---",
      "name: code-preserve",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "tags: []",
      "---",
      "",
      codeBody,
    ].join("\n");
    const f = await writeRaw(fm);
    await formatSkill({ path: f });
    const after = await readFile(f, "utf8");
    // The interior of the code block must be byte-identical to the source.
    expect(after).toContain("def hello():   \n");
    expect(after).toContain("    # trailing spaces above must survive   \n");
    expect(after).toContain("\n\n\n\n    print('hi')");
  });
});

describe("formatSkill — dry-run", () => {
  it("returns the diff but writes nothing", async () => {
    const scrambled = [
      "---",
      "tags: [x]",
      "name: dry-run-test",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "---",
      "",
      DEFAULT_BODY,
    ].join("\n");
    const f = await writeRaw(scrambled);
    const before = await readFile(f, "utf8");
    const r = await formatSkill({ path: f, dryRun: true });
    expect(r.changed).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.after).not.toBe(r.before);
    const onDisk = await readFile(f, "utf8");
    expect(onDisk).toBe(before); // file untouched
  });

  it("write: false also writes nothing", async () => {
    const fm = [
      "---",
      "tags: []",
      "name: write-false",
      `description: ${VALID_DESC}`,
      "version: 1.0.0",
      "---",
      "",
      DEFAULT_BODY,
    ].join("\n");
    const f = await writeRaw(fm);
    const before = await readFile(f, "utf8");
    const r = await formatSkill({ path: f, write: false });
    expect(r.changed).toBe(true);
    const onDisk = await readFile(f, "utf8");
    expect(onDisk).toBe(before);
  });
});

describe("formatSkill — idempotence", () => {
  it("formatting twice produces byte-identical output the second time", async () => {
    const scrambled = [
      "---",
      "homepage: https://example.com  ",
      "author: '@adityachilka1'",
      "tags: [a, b, c]",
      "version: 1.2.3",
      `description: ${VALID_DESC}`,
      "name: idem-test",
      "extra-passthrough: hello",
      "---",
      "",
      "",
      "",
      "# my-skill   ",
      "",
      "first    ",
      "",
      "",
      "",
      "",
      "second",
      "",
      "```js",
      "function f() {   ",
      "  return 1;   ",
      "}",
      "```",
      "",
    ].join("\n");
    const f = await writeRaw(scrambled);
    await formatSkill({ path: f });
    const afterFirst = await readFile(f, "utf8");
    const r2 = await formatSkill({ path: f });
    const afterSecond = await readFile(f, "utf8");
    expect(afterSecond).toBe(afterFirst);
    expect(r2.changed).toBe(false);
  });

  it("changed: false on an already-canonical file", async () => {
    // Author the file in canonical form and check that format is a no-op.
    const canonical = `---\nname: canonical\ndescription: ${VALID_DESC}\nversion: 1.0.0\ntags: []\n---\n\n# my-skill\n\nbody line\n`;
    const f = await writeRaw(canonical);
    const r = await formatSkill({ path: f });
    expect(r.changed).toBe(false);
    const after = await readFile(f, "utf8");
    expect(after).toBe(canonical);
  });
});

describe("formatSkill — validation gate", () => {
  it("refuses to write if the formatted result fails schema validation (file untouched)", async () => {
    // description is under 20 chars — schema-invalid. Format should refuse.
    const broken = [
      "---",
      "name: too-short",
      "description: tiny",
      "version: 1.0.0",
      "tags: []",
      "---",
      "",
      DEFAULT_BODY,
    ].join("\n");
    const f = await writeRaw(broken);
    const before = await readFile(f, "utf8");
    await expect(formatSkill({ path: f })).rejects.toThrow(/resulting frontmatter is invalid/);
    const after = await readFile(f, "utf8");
    expect(after).toBe(before);
  });
});

describe("formatSkill — error paths", () => {
  it("throws when the file does not exist", async () => {
    await expect(formatSkill({ path: join(workDir, "missing.md") })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("throws when given a directory without a SKILL.md", async () => {
    await expect(formatSkill({ path: workDir })).rejects.toThrow(/does not contain a SKILL\.md/);
  });

  it("resolves SKILL.md from a directory path", async () => {
    const canonical = `---\nname: canonical\ndescription: ${VALID_DESC}\nversion: 1.0.0\ntags: []\n---\n\n# my-skill\n\nbody\n`;
    await writeRaw(canonical);
    const r = await formatSkill({ path: workDir });
    expect(r.path).toBe(join(workDir, "SKILL.md"));
    expect(r.changed).toBe(false);
  });

  it("throws when the file has no frontmatter block at all", async () => {
    const f = await writeRaw("# just a markdown file\n\nNo frontmatter here.\n");
    await expect(formatSkill({ path: f })).rejects.toThrow(/no frontmatter block/);
  });
});
