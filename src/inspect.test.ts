import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { inspectSkill } from "./inspect.js";
import { packSkill } from "./pack.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as the sibling test files.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-inspect-")));
});

const VALID_DESC = "Use this when the user asks for the demo skill described in this file.";

const HEALTHY_BODY = `# my-skill

## What this skill does

Real prose. Real prose. Real prose. Real prose.

## When to use

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
    body?: string;
  } = {},
): string {
  const name = opts.name ?? "my-skill";
  const description = opts.description ?? VALID_DESC;
  const version = opts.version ?? "0.1.0";
  const tags = opts.tags ?? "[a, b]";
  const body = opts.body ?? HEALTHY_BODY;
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `version: ${version}`,
    `tags: ${tags}`,
    "---",
    "",
    body,
  ].join("\n");
}

async function writeSkill(content: string, name = "SKILL.md"): Promise<string> {
  const file = join(workDir, name);
  await writeFile(file, content);
  return file;
}

describe("inspectSkill — happy path", () => {
  it("returns frontmatter, body stats, and a clean summary for a healthy SKILL.md", async () => {
    const file = await writeSkill(buildSkillSource());
    const r = await inspectSkill({ path: file });

    expect(r.name).toBe("my-skill");
    expect(r.frontmatter?.name).toBe("my-skill");
    expect(r.frontmatter?.version).toBe("0.1.0");
    expect(r.frontmatter?.tags).toEqual(["a", "b"]);
    expect(r.validation.ok).toBe(true);
    // Lint may flag style warnings (e.g. abandoned-default-version) — what we
    // care about is that there are no *errors* on a healthy file, since that
    // drives `summary.ok`.
    expect(r.lint.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(r.summary.ok).toBe(true);
    expect(r.summary.validationIssues).toBe(0);
    expect(r.attachedFiles).toBeUndefined(); // file input → no inventory
    expect(r.source).toBe("file");
  });
});

describe("inspectSkill — surfaces validation failures", () => {
  it("flags an invalid frontmatter (description too short) via the validation block", async () => {
    const broken = buildSkillSource({ description: "too short" });
    const file = await writeSkill(broken);
    const r = await inspectSkill({ path: file });
    expect(r.validation.ok).toBe(false);
    expect(r.validation.issues.length).toBeGreaterThan(0);
    expect(r.validation.issues.join(" ")).toMatch(/description/i);
    expect(r.summary.ok).toBe(false);
    expect(r.summary.validationIssues).toBeGreaterThan(0);
    // Frontmatter on the result is undefined when the schema parse fails —
    // that's the contract callers depend on.
    expect(r.frontmatter).toBeUndefined();
  });
});

describe("inspectSkill — surfaces lint issues", () => {
  it("flags a TODO marker (lint error) and reports summary.ok=false", async () => {
    const body = `# my-skill

## What this skill does

Real prose. Real prose. Real prose. Real prose.

## When to use

When the agent wants to demonstrate something.

## Examples

TODO finish writing this example.
`;
    const file = await writeSkill(buildSkillSource({ body }));
    const r = await inspectSkill({ path: file });
    // Validation also surfaces TODO as a body-level warning (in `issues`),
    // so we narrow to the lint side for this assertion.
    const lintErrors = r.lint.issues.filter((i) => i.severity === "error");
    expect(lintErrors.some((i) => i.rule === "todo-marker")).toBe(true);
    expect(r.summary.ok).toBe(false);
    expect(r.summary.lintIssues).toBeGreaterThan(0);
  });
});

describe("inspectSkill — directory mode", () => {
  it("lists every non-excluded attached file in a skill directory", async () => {
    const skillDir = join(workDir, "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), buildSkillSource());
    await mkdir(join(skillDir, "templates"), { recursive: true });
    await writeFile(join(skillDir, "templates", "letter.md"), "Dear ...");
    await writeFile(join(skillDir, "tool.py"), "print('hi')");
    // These three must be excluded by the same rules as `pack`:
    await writeFile(join(skillDir, ".DS_Store"), "trash");
    await writeFile(join(skillDir, "debug.log"), "noise");
    await mkdir(join(skillDir, ".git"), { recursive: true });
    await writeFile(join(skillDir, ".git", "HEAD"), "ref: refs/heads/main");

    const r = await inspectSkill({ path: skillDir });

    expect(r.attachedFiles).toBeDefined();
    expect(r.attachedFiles).toContain("SKILL.md");
    expect(r.attachedFiles).toContain("templates/letter.md");
    expect(r.attachedFiles).toContain("tool.py");
    expect(r.attachedFiles).not.toContain(".DS_Store");
    expect(r.attachedFiles).not.toContain("debug.log");
    expect(r.attachedFiles?.some((p) => p.startsWith(".git"))).toBe(false);
    expect(r.source).toBe("directory");
  });
});

describe("inspectSkill — body parsing", () => {
  it("extracts every `## heading` (level-2 only) in document order", async () => {
    const body = `# Title (h1 ignored)

## Alpha

prose

### sub (h3 ignored)

## Bravo

more prose

## Charlie
`;
    const file = await writeSkill(buildSkillSource({ body }));
    const r = await inspectSkill({ path: file });
    expect(r.body.sections).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("ignores `##` sequences that appear inside fenced code blocks", async () => {
    const body = `# Title

## Real Section

\`\`\`md
## Not A Section — this is inside a fence
\`\`\`

## Another Real Section
`;
    const file = await writeSkill(buildSkillSource({ body }));
    const r = await inspectSkill({ path: file });
    expect(r.body.sections).toEqual(["Real Section", "Another Real Section"]);
  });

  it("counts words correctly on a known-size body", async () => {
    // Exactly 12 words across two lines.
    const body = `one two three four five six

seven eight nine ten eleven twelve
`;
    const file = await writeSkill(buildSkillSource({ body }));
    const r = await inspectSkill({ path: file });
    // Word count is exact — gray-matter's leading-newline quirk doesn't add
    // extra tokens through the whitespace splitter.
    expect(r.body.words).toBe(12);
    // gray-matter prefixes a leading "\n" to its `content`, so character /
    // line counts will be exactly one greater than the raw body. We assert
    // the offset rather than equality to pin the contract.
    expect(r.body.characters).toBe(body.length + 1);
    expect(r.body.lines).toBe(body.split("\n").length + 1);
  });
});

describe("inspectSkill — error paths", () => {
  it("throws a helpful error when the path does not exist", async () => {
    await expect(inspectSkill({ path: join(workDir, "missing.md") })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("throws when a directory input has no SKILL.md", async () => {
    const dir = join(workDir, "empty");
    await mkdir(dir, { recursive: true });
    await expect(inspectSkill({ path: dir })).rejects.toThrow(/SKILL\.md/);
  });
});

describe("inspectSkill — JSON shape stability", () => {
  it("produces a result that serializes cleanly to JSON with all top-level keys", async () => {
    const file = await writeSkill(buildSkillSource());
    const r = await inspectSkill({ path: file, json: true });
    const json = JSON.stringify(r);
    // Round-trip — no Date / Map / undefined-only landmines.
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // Top-level contract. `attachedFiles` is intentionally omitted for file
    // inputs and JSON.stringify drops `undefined` — assert via the source
    // object instead.
    expect(Object.keys(parsed).sort()).toEqual(
      ["body", "frontmatter", "lint", "name", "path", "source", "summary", "validation"].sort(),
    );
    expect(parsed.source).toBe("file");
    const summary = parsed.summary as Record<string, unknown>;
    expect(summary).toMatchObject({
      ok: expect.any(Boolean),
      validationIssues: expect.any(Number),
      lintIssues: expect.any(Number),
    });
    const body = parsed.body as Record<string, unknown>;
    expect(body).toMatchObject({
      lines: expect.any(Number),
      characters: expect.any(Number),
      words: expect.any(Number),
      sections: expect.any(Array),
    });
  });
});

/**
 * Helper: pack a skill directory into a `.skill` archive via the real
 * packer so the fixture archives match what `pack` actually emits — same
 * compression, same root layout. Lives next to the archive-mode tests
 * because that's the only block that needs it.
 */
async function packIntoArchive(skillDir: string, archiveName: string): Promise<string> {
  const outPath = join(workDir, `${archiveName}.skill`);
  await packSkill({ srcDir: skillDir, outPath });
  return outPath;
}

describe("inspectSkill — archive mode", () => {
  it("reads SKILL.md from a packed .skill archive and produces a clean report", async () => {
    const skillDir = join(workDir, "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), buildSkillSource());
    const archive = await packIntoArchive(skillDir, "my-skill");

    const r = await inspectSkill({ path: archive });
    expect(r.source).toBe("archive");
    expect(r.name).toBe("my-skill");
    expect(r.frontmatter?.version).toBe("0.1.0");
    expect(r.validation.ok).toBe(true);
    expect(r.summary.ok).toBe(true);
    // No attached-file inventory for archives — the bundle is opaque; the
    // user can use `tree`/`install --dry-run` to peek at its file list.
    expect(r.attachedFiles).toBeUndefined();
    // The reported path is the archive itself, not the temp file we
    // materialized SKILL.md to during inspection.
    expect(r.path.endsWith("my-skill.skill")).toBe(true);
  });

  it("surfaces frontmatter validation issues from inside a .skill archive without crashing", async () => {
    const skillDir = join(workDir, "broken-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), buildSkillSource({ description: "too short" }));
    // pack would normally refuse a broken skill — `--skip-validation` lets
    // us produce a malformed archive specifically so `inspect` can prove
    // it surfaces the validation failure cleanly rather than throwing.
    const outPath = join(workDir, "broken-skill.skill");
    await packSkill({ srcDir: skillDir, outPath, skipValidation: true });

    const r = await inspectSkill({ path: outPath });
    expect(r.source).toBe("archive");
    expect(r.validation.ok).toBe(false);
    expect(r.summary.ok).toBe(false);
    expect(r.summary.validationIssues).toBeGreaterThan(0);
    expect(r.frontmatter).toBeUndefined();
  });

  it("refuses an archive that has no SKILL.md at the root with a clear error", async () => {
    // Construct a zip directly — `pack` won't emit a SKILL.md-less archive,
    // so we build a hand-rolled fixture that matches what a malicious or
    // misconfigured bundle would look like.
    const zip = new JSZip();
    zip.file("README.md", "no skill here");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const archive = join(workDir, "no-skill.skill");
    await writeFile(archive, buf);

    await expect(inspectSkill({ path: archive })).rejects.toThrow(/SKILL\.md/);
  });

  it("forces archive interpretation via --from-bundle on a misnamed file", async () => {
    const skillDir = join(workDir, "renamed");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), buildSkillSource());
    // Pack to a `.skill`, then move it to a `.bundle` extension to simulate
    // a user who renamed the artifact. Without --from-bundle the loader
    // would try to read it as plain text and explode on the binary bytes;
    // with the flag it sniffs zip magic and treats it as an archive.
    const packed = await packIntoArchive(skillDir, "renamed");
    const renamed = join(workDir, "renamed.bundle");
    const { rename } = await import("node:fs/promises");
    await rename(packed, renamed);

    const r = await inspectSkill({ path: renamed, fromBundle: true });
    expect(r.source).toBe("archive");
    expect(r.name).toBe("my-skill");
    expect(r.summary.ok).toBe(true);
  });

  it("refuses --from-bundle on a plain text file with a zip-magic sniff", async () => {
    // A SKILL.md as text — `--from-bundle` should reject this before JSZip
    // ever sees the bytes, because the first 4 bytes aren't `PK\x03\x04`.
    const file = join(workDir, "plain.skill");
    await writeFile(file, buildSkillSource());
    await expect(inspectSkill({ path: file, fromBundle: true })).rejects.toThrow(
      /not a zip|zip parse failed/,
    );
  });
});
