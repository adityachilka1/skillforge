import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { diffSkills } from "./diff.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as the sibling test files.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-diff-")));
});

const VALID_DESC = "Use this when the user asks for the demo skill described in this file.";

const HEALTHY_BODY = `# my-skill

## What this skill does

Real prose. Real prose. Real prose. Real prose.

## When to use it

When the agent wants to demonstrate something.

## Examples

\`\`\`
example
\`\`\`
`;

function buildSkillSource(
  opts: {
    name?: string;
    description?: string;
    version?: string;
    tags?: string;
    author?: string;
    body?: string;
    extra?: Record<string, string>;
  } = {},
): string {
  const name = opts.name ?? "my-skill";
  const description = opts.description ?? VALID_DESC;
  const version = opts.version ?? "0.1.0";
  const tags = opts.tags ?? "[a, b]";
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `version: ${version}`,
    `tags: ${tags}`,
  ];
  // Quote the author value — handles values starting with `@`, which YAML
  // would otherwise read as a reserved indicator.
  if (opts.author !== undefined) lines.push(`author: "${opts.author}"`);
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "", opts.body ?? HEALTHY_BODY);
  return lines.join("\n");
}

async function writeSkill(content: string, name: string): Promise<string> {
  const file = join(workDir, name);
  await writeFile(file, content);
  return file;
}

describe("diffSkills — identical files", () => {
  it("reports identical: true when both files have the same frontmatter and body", async () => {
    const a = await writeSkill(buildSkillSource(), "a.md");
    const b = await writeSkill(buildSkillSource(), "b.md");
    const r = await diffSkills(a, b);
    expect(r.identical).toBe(true);
    expect(r.frontmatter.added).toEqual({});
    expect(r.frontmatter.removed).toEqual({});
    expect(r.frontmatter.changed).toEqual([]);
    expect(r.bodyHeadings.added).toEqual([]);
    expect(r.bodyHeadings.removed).toEqual([]);
    expect(r.bodyHeadings.reordered).toEqual([]);
    expect(r.bodyLinesDelta).toEqual({ added: 0, removed: 0 });
  });
});

describe("diffSkills — frontmatter changes", () => {
  it("flags an added optional field as `added`", async () => {
    const a = await writeSkill(buildSkillSource(), "a.md");
    const b = await writeSkill(buildSkillSource({ author: "@adityachilka1" }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.frontmatter.added).toEqual({ author: "@adityachilka1" });
    expect(r.frontmatter.removed).toEqual({});
    expect(r.frontmatter.changed).toEqual([]);
    expect(r.identical).toBe(false);
  });

  it("flags a removed optional field as `removed`", async () => {
    const a = await writeSkill(buildSkillSource({ author: "@adityachilka1" }), "a.md");
    const b = await writeSkill(buildSkillSource(), "b.md");
    const r = await diffSkills(a, b);
    expect(r.frontmatter.removed).toEqual({ author: "@adityachilka1" });
    expect(r.frontmatter.added).toEqual({});
    expect(r.identical).toBe(false);
  });

  it("flags a changed value (version bump) under `changed` with before/after", async () => {
    const a = await writeSkill(buildSkillSource({ version: "0.1.0" }), "a.md");
    const b = await writeSkill(buildSkillSource({ version: "0.2.0" }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.frontmatter.changed).toEqual([{ key: "version", before: "0.1.0", after: "0.2.0" }]);
    expect(r.frontmatter.added).toEqual({});
    expect(r.frontmatter.removed).toEqual({});
  });

  it("treats tags array reorder as a change (deep array comparison)", async () => {
    const a = await writeSkill(buildSkillSource({ tags: "[a, b]" }), "a.md");
    const b = await writeSkill(buildSkillSource({ tags: "[b, a]" }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.frontmatter.changed).toHaveLength(1);
    expect(r.frontmatter.changed[0].key).toBe("tags");
  });

  it("recognizes equal tag arrays as unchanged", async () => {
    const a = await writeSkill(buildSkillSource({ tags: "[a, b]" }), "a.md");
    const b = await writeSkill(buildSkillSource({ tags: "[a, b]" }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.frontmatter.changed).toEqual([]);
  });
});

describe("diffSkills — body headings", () => {
  it("flags an added H2 section", async () => {
    const body = `# t

## Alpha

prose
`;
    const bBody = `# t

## Alpha

prose

## Bravo

more prose
`;
    const a = await writeSkill(buildSkillSource({ body }), "a.md");
    const b = await writeSkill(buildSkillSource({ body: bBody }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.bodyHeadings.added).toEqual(["Bravo"]);
    expect(r.bodyHeadings.removed).toEqual([]);
    expect(r.bodyHeadings.reordered).toEqual([]);
  });

  it("flags a removed H3 section", async () => {
    const aBody = `# t

## Alpha

### deep-dive

prose
`;
    const bBody = `# t

## Alpha

prose
`;
    const a = await writeSkill(buildSkillSource({ body: aBody }), "a.md");
    const b = await writeSkill(buildSkillSource({ body: bBody }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.bodyHeadings.removed).toEqual(["deep-dive"]);
    expect(r.bodyHeadings.added).toEqual([]);
  });

  it("flags a reorder when Examples moves above When to use it", async () => {
    // Common pattern: an author promotes Examples ahead of When-to-use after
    // realising the example is the trigger for the agent.
    const aBody = `# t

## What this skill does

x

## When to use it

y

## Examples

z
`;
    const bBody = `# t

## What this skill does

x

## Examples

z

## When to use it

y
`;
    const a = await writeSkill(buildSkillSource({ body: aBody }), "a.md");
    const b = await writeSkill(buildSkillSource({ body: bBody }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.bodyHeadings.added).toEqual([]);
    expect(r.bodyHeadings.removed).toEqual([]);
    // Two headings swap positions — both report as moved.
    const headings = r.bodyHeadings.reordered.map((m) => m.heading).sort();
    expect(headings).toEqual(["Examples", "When to use it"]);
    const examples = r.bodyHeadings.reordered.find((m) => m.heading === "Examples");
    expect(examples?.from).toBe(2);
    expect(examples?.to).toBe(1);
  });

  it("ignores `## headings` inside fenced code blocks", async () => {
    const body = `# t

## Real

\`\`\`md
## Not A Heading
\`\`\`

## Also Real
`;
    const a = await writeSkill(buildSkillSource({ body }), "a.md");
    const b = await writeSkill(buildSkillSource({ body }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.bodyHeadings.added).toEqual([]);
    expect(r.bodyHeadings.removed).toEqual([]);
    expect(r.identical).toBe(true);
  });
});

describe("diffSkills — body line delta", () => {
  it("counts coarse adds/removes on prose-only changes", async () => {
    const aBody = `# t

## Section

one
two
three
`;
    const bBody = `# t

## Section

one
two
three
four
five
`;
    const a = await writeSkill(buildSkillSource({ body: aBody }), "a.md");
    const b = await writeSkill(buildSkillSource({ body: bBody }), "b.md");
    const r = await diffSkills(a, b);
    // Two new lines, none removed.
    expect(r.bodyLinesDelta.added).toBe(2);
    expect(r.bodyLinesDelta.removed).toBe(0);
    expect(r.identical).toBe(false);
  });

  it("does not count trailing-newline differences as a delta", async () => {
    // Same body, one with and one without a trailing blank line — the
    // multiset normaliser strips the trailing empty so the diff is zero.
    const body = `# t

## Section

prose
`;
    const a = await writeSkill(buildSkillSource({ body }), "a.md");
    const b = await writeSkill(buildSkillSource({ body: `${body}\n` }), "b.md");
    const r = await diffSkills(a, b);
    expect(r.bodyLinesDelta).toEqual({ added: 0, removed: 0 });
  });
});

describe("diffSkills — refusal on invalid frontmatter", () => {
  it("throws when file A has invalid frontmatter (description too short)", async () => {
    const a = await writeSkill(buildSkillSource({ description: "too short" }), "a.md");
    const b = await writeSkill(buildSkillSource(), "b.md");
    await expect(diffSkills(a, b)).rejects.toThrow(/invalid frontmatter/);
  });

  it("throws when file B has invalid frontmatter (bad version)", async () => {
    const a = await writeSkill(buildSkillSource(), "a.md");
    const b = await writeSkill(buildSkillSource({ version: "not-a-version" }), "b.md");
    await expect(diffSkills(a, b)).rejects.toThrow(/invalid frontmatter/);
  });
});

describe("diffSkills — error paths", () => {
  it("throws when file A does not exist", async () => {
    const b = await writeSkill(buildSkillSource(), "b.md");
    await expect(diffSkills(join(workDir, "missing.md"), b)).rejects.toThrow(/does not exist/);
  });

  it("throws when file B does not exist", async () => {
    const a = await writeSkill(buildSkillSource(), "a.md");
    await expect(diffSkills(a, join(workDir, "missing.md"))).rejects.toThrow(/does not exist/);
  });
});

describe("diffSkills — combined changes", () => {
  it("produces a coherent report across frontmatter + headings + body lines", async () => {
    const aBody = `# t

## Old Heading

content
line two
`;
    const bBody = `# t

## New Heading

content
line two
extra line
`;
    const a = await writeSkill(buildSkillSource({ version: "0.1.0", body: aBody }), "a.md");
    const b = await writeSkill(
      buildSkillSource({ version: "0.2.0", body: bBody, author: "@x" }),
      "b.md",
    );
    const r = await diffSkills(a, b);
    expect(r.frontmatter.added).toEqual({ author: "@x" });
    expect(r.frontmatter.changed).toEqual([{ key: "version", before: "0.1.0", after: "0.2.0" }]);
    expect(r.bodyHeadings.added).toEqual(["New Heading"]);
    expect(r.bodyHeadings.removed).toEqual(["Old Heading"]);
    expect(r.bodyLinesDelta.added).toBeGreaterThan(0);
    expect(r.identical).toBe(false);
  });
});
