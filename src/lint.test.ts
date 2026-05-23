import { realpathSync } from "node:fs";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { computeExitCode, lintSkill } from "./lint.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Bit prior PRs; cargo-culted forward.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-lint-")));
});

interface SkillOverrides {
  name?: string;
  description?: string;
  version?: string;
  tags?: string;
  body?: string;
  /** Set the file mtime after writing. Useful for the abandoned-version rule. */
  mtime?: Date;
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

async function writeSkill(overrides: SkillOverrides = {}): Promise<string> {
  const {
    name = "my-skill",
    description = "Use this when the user wants to test the skillforge lint command end to end.",
    version = "0.1.0",
    tags = "[example, test]",
    body = DEFAULT_BODY,
    mtime,
  } = overrides;

  const path = join(workDir, "SKILL.md");
  const content = `---
name: ${name}
description: ${description}
version: ${version}
tags: ${tags}
---

${body}`;
  await writeFile(path, content, "utf8");
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

const now = new Date("2026-05-23T00:00:00Z");
const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

// ──────────────────────────────────────────────────────────────────────
// Rule: description-too-short
// ──────────────────────────────────────────────────────────────────────

describe("rule: description-too-short", () => {
  it("warns when description is under 40 chars", async () => {
    const path = await writeSkill({ description: "Use this when you want a thing now." });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("description-too-short");
  });

  it("does not fire when description is >= 40 chars", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("description-too-short");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: description-no-verb
// ──────────────────────────────────────────────────────────────────────

describe("rule: description-no-verb", () => {
  it("warns when description has no verb token", async () => {
    const path = await writeSkill({
      description: "A long-enough noun phrase about the weather and the autumn and the leaves.",
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("description-no-verb");
  });

  it("does not fire when a recognised verb is present", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("description-no-verb");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: description-no-trigger
// ──────────────────────────────────────────────────────────────────────

describe("rule: description-no-trigger", () => {
  it("warns when description lacks triggering language", async () => {
    const path = await writeSkill({
      description: "A skill that runs code and returns numerical results to the agent for review.",
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("description-no-trigger");
  });

  it("does not fire when 'use this when' is present", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("description-no-trigger");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: tags-empty
// ──────────────────────────────────────────────────────────────────────

describe("rule: tags-empty", () => {
  it("warns when tags is empty", async () => {
    const path = await writeSkill({ tags: "[]" });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("tags-empty");
  });

  it("does not fire when tags has entries", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("tags-empty");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: abandoned-default-version
// ──────────────────────────────────────────────────────────────────────

describe("rule: abandoned-default-version", () => {
  it("warns when version is 0.0.1 and mtime is older than 7 days", async () => {
    const path = await writeSkill({ version: "0.0.1", mtime: tenDaysAgo });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("abandoned-default-version");
  });

  it("does not fire when version has been bumped", async () => {
    const path = await writeSkill({ version: "0.2.0", mtime: tenDaysAgo });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("abandoned-default-version");
  });

  it("does not fire on a fresh 0.0.1 file", async () => {
    const path = await writeSkill({ version: "0.0.1", mtime: now });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("abandoned-default-version");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: missing-when-to-use
// ──────────────────────────────────────────────────────────────────────

describe("rule: missing-when-to-use", () => {
  it("warns when no '## When to use' heading is present", async () => {
    const path = await writeSkill({
      body: `# my-skill

## Examples

example
`,
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("missing-when-to-use");
  });

  it("does not fire when the heading is present", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("missing-when-to-use");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: missing-examples
// ──────────────────────────────────────────────────────────────────────

describe("rule: missing-examples", () => {
  it("warns when no '## Examples' heading is present", async () => {
    const path = await writeSkill({
      body: `# my-skill

## When to use

When ready.
`,
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("missing-examples");
  });

  it("does not fire when the heading is present", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("missing-examples");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: todo-marker
// ──────────────────────────────────────────────────────────────────────

describe("rule: todo-marker", () => {
  it("errors when TODO is present in the body", async () => {
    const path = await writeSkill({
      body: `# my-skill

## When to use
TODO write this

## Examples
ok
`,
    });
    const { issues } = await lintSkill(path, { now });
    const todo = issues.find((i) => i.rule === "todo-marker");
    expect(todo).toBeDefined();
    expect(todo?.severity).toBe("error");
    expect(todo?.line).toBeGreaterThan(0);
  });

  it("does not fire when no TODO present", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("todo-marker");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: second-person-instructions
// ──────────────────────────────────────────────────────────────────────

describe("rule: second-person-instructions", () => {
  it("warns on 'you should' style phrasing", async () => {
    const path = await writeSkill({
      body: `# my-skill

## When to use
You should call this on every PR.

## Examples
ok
`,
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("second-person-instructions");
  });

  it("warns on bare 'always' phrasing", async () => {
    const path = await writeSkill({
      body: `# my-skill

## When to use
Always check the diff.

## Examples
ok
`,
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).toContain("second-person-instructions");
  });

  it("does not fire on neutral prose", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("second-person-instructions");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule: trailing-whitespace
// ──────────────────────────────────────────────────────────────────────

describe("rule: trailing-whitespace", () => {
  it("warns on lines with trailing spaces", async () => {
    // Explicitly construct a line with trailing whitespace — template literals
    // make this awkward, so concatenate.
    const dirty = "# my-skill\n\n## When to use\nclean line\ndirty line   \n\n## Examples\nok\n";
    const path = await writeSkill({ body: dirty });
    const { issues } = await lintSkill(path, { now });
    const tw = issues.find((i) => i.rule === "trailing-whitespace");
    expect(tw).toBeDefined();
    expect(tw?.line).toBeGreaterThan(0);
  });

  it("does not fire on clean lines", async () => {
    const path = await writeSkill();
    const { issues } = await lintSkill(path, { now });
    expect(issues.map((i) => i.rule)).not.toContain("trailing-whitespace");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Exit codes
// ──────────────────────────────────────────────────────────────────────

describe("computeExitCode", () => {
  it("returns 0 when no issues", () => {
    expect(computeExitCode({ path: "x", issues: [] }, false)).toBe(0);
    expect(computeExitCode({ path: "x", issues: [] }, true)).toBe(0);
  });

  it("returns 0 when only warnings (non-strict)", () => {
    const r = { path: "x", issues: [{ rule: "r", severity: "warning" as const, message: "m" }] };
    expect(computeExitCode(r, false)).toBe(0);
  });

  it("returns 1 when any error (non-strict)", () => {
    const r = { path: "x", issues: [{ rule: "r", severity: "error" as const, message: "m" }] };
    expect(computeExitCode(r, false)).toBe(1);
  });

  it("returns 2 when strict and any issue (including warning-only)", () => {
    const warn = {
      path: "x",
      issues: [{ rule: "r", severity: "warning" as const, message: "m" }],
    };
    const err = {
      path: "x",
      issues: [{ rule: "r", severity: "error" as const, message: "m" }],
    };
    expect(computeExitCode(warn, true)).toBe(2);
    expect(computeExitCode(err, true)).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Shape (JSON output)
// ──────────────────────────────────────────────────────────────────────

describe("lintSkill output shape", () => {
  it("returns issues with rule/severity/message and optional line", async () => {
    const path = await writeSkill({
      body: `# my-skill

## When to use
TODO finish this

## Examples
ok
`,
    });
    const { issues } = await lintSkill(path, { now });
    expect(Array.isArray(issues)).toBe(true);
    for (const issue of issues) {
      expect(typeof issue.rule).toBe("string");
      expect(["error", "warning"]).toContain(issue.severity);
      expect(typeof issue.message).toBe("string");
      if (issue.line !== undefined) expect(typeof issue.line).toBe("number");
    }
  });

  it("places errors before warnings", async () => {
    // TODO triggers an error; tags: [] triggers a warning. Together we get
    // a mixed result we can assert ordering on.
    const path = await writeSkill({
      tags: "[]",
      body: `# my-skill

## When to use
TODO

## Examples
ok
`,
    });
    const { issues } = await lintSkill(path, { now });
    expect(issues.length).toBeGreaterThan(1);
    let sawWarning = false;
    for (const issue of issues) {
      if (issue.severity === "warning") sawWarning = true;
      if (sawWarning) expect(issue.severity).toBe("warning");
    }
  });

  it("returns an invalid-frontmatter error when schema validation fails", async () => {
    const path = join(workDir, "SKILL.md");
    await writeFile(
      path,
      `---
name: ${"x".repeat(200)}
description: too short
---

body
`,
      "utf8",
    );
    const { issues } = await lintSkill(path, { now });
    expect(issues.length).toBe(1);
    expect(issues[0].rule).toBe("invalid-frontmatter");
    expect(issues[0].severity).toBe("error");
  });
});
