import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSkill } from "./init.js";
import { validateSkill } from "./validate.js";

describe("initSkill", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skillforge-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a SKILL.md at <outputDir>/<name>/SKILL.md", async () => {
    const path = await initSkill({ name: "code-review", outputDir: dir });
    expect(path).toBe(join(dir, "code-review", "SKILL.md"));
    expect(existsSync(path)).toBe(true);
  });

  it("the scaffolded file parses as valid frontmatter (modulo TODO warnings)", async () => {
    const path = await initSkill({ name: "code-review", outputDir: dir });
    const result = await validateSkill(path);
    expect(result.frontmatter?.name).toBe("code-review");
    expect(result.frontmatter?.version).toBe("0.0.1");
    // The scaffold has TODO markers — that's the warning, not a hard fail of the schema.
    expect(result.issues.some((i) => i.includes("TODO"))).toBe(true);
  });

  it("refuses to overwrite an existing SKILL.md without --force", async () => {
    await initSkill({ name: "code-review", outputDir: dir });
    await expect(initSkill({ name: "code-review", outputDir: dir })).rejects.toThrow(
      /already exists/,
    );
  });

  it("overwrites when force=true", async () => {
    await initSkill({ name: "code-review", outputDir: dir });
    await expect(
      initSkill({ name: "code-review", outputDir: dir, force: true }),
    ).resolves.toBeTruthy();
  });
});
