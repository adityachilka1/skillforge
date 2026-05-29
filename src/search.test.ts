import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { searchInstalledSkills } from "./search.js";

let workDir: string;

beforeEach(async () => {
  // realpath because macOS `tmpdir()` returns `/tmp` while resolved paths
  // come back as `/private/tmp`. Same trick as the rest of the test suite.
  workDir = realpathSync(await mkdtemp(join(tmpdir(), "skillforge-search-")));
});

const VALID_DESC = "Use this when the user asks for the demo skill described in this file.";

function frontmatter(opts: {
  name: string;
  version?: string;
  description?: string;
  tags?: string[];
}): string {
  const tagsLine = opts.tags?.length ? `[${opts.tags.join(", ")}]` : "[]";
  return [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description ?? VALID_DESC}`,
    `version: ${opts.version ?? "0.1.0"}`,
    `tags: ${tagsLine}`,
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
  opts: {
    version?: string;
    description?: string;
    tags?: string[];
    body?: string;
    skipSkillMd?: boolean;
  } = {},
): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  if (!opts.skipSkillMd) {
    const fm = [
      "---",
      `name: ${name}`,
      `description: ${opts.description ?? VALID_DESC}`,
      `version: ${opts.version ?? "0.1.0"}`,
      `tags: ${opts.tags?.length ? `[${opts.tags.join(", ")}]` : "[]"}`,
      "---",
      "",
      opts.body ?? "# body\n\nSome prose so the body is non-empty.\n",
    ].join("\n");
    await writeFile(join(dir, "SKILL.md"), fm);
  }
  return dir;
}

describe("searchInstalledSkills — basic name match", () => {
  it("returns one hit when the query matches a skill name", async () => {
    await writeSkillDir(workDir, "refund-helper");

    const result = await searchInstalledSkills({ query: "refund", fromDir: workDir });

    expect(result.fromDir).toBe(workDir);
    expect(result.query).toBe("refund");
    expect(result.totalScanned).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("refund-helper");
    expect(result.hits[0].score).toBeGreaterThan(0);
  });
});

describe("searchInstalledSkills — ranking", () => {
  it("ranks the description match highest when only one skill mentions the query", async () => {
    await writeSkillDir(workDir, "alpha", {
      description: "Use this when the user asks about cats.",
    });
    await writeSkillDir(workDir, "beta", {
      description: "Use this for tax filings and quarterly tax summaries.",
    });
    await writeSkillDir(workDir, "gamma", {
      description: "Use this when the user asks about dogs.",
    });

    const result = await searchInstalledSkills({ query: "tax", fromDir: workDir });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("beta");
  });

  it("name match outranks description match for the same query", async () => {
    // Both skills' descriptions mention 'inventory' once. Only one has it in the name.
    await writeSkillDir(workDir, "inventory-tool", {
      description: "Use this to track inventory across warehouses for the demo.",
    });
    await writeSkillDir(workDir, "other", {
      description: "Use this to track inventory across warehouses for the demo.",
    });

    const result = await searchInstalledSkills({ query: "inventory", fromDir: workDir });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].name).toBe("inventory-tool");
    expect(result.hits[0].score).toBeGreaterThan(result.hits[1].score);
  });
});

describe("searchInstalledSkills — multi-token OR", () => {
  it("matches any of the whitespace-split tokens (OR semantics)", async () => {
    await writeSkillDir(workDir, "refund-helper");
    await writeSkillDir(workDir, "shipping-helper", {
      description: "Use this when the user asks about shipping rates and carriers.",
    });
    await writeSkillDir(workDir, "irrelevant", {
      description: "Use this when the user asks about something else entirely.",
    });

    const result = await searchInstalledSkills({ query: "refund shipping", fromDir: workDir });

    const names = result.hits.map((h) => h.name).sort();
    expect(names).toEqual(["refund-helper", "shipping-helper"]);
  });
});

describe("searchInstalledSkills — case insensitive", () => {
  it("matches regardless of case in either query or source", async () => {
    await writeSkillDir(workDir, "Refund-Helper", {
      description: "Use this when the user wants a REFUND processed quickly.",
    });

    const result = await searchInstalledSkills({ query: "REFUND", fromDir: workDir });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("Refund-Helper");

    const result2 = await searchInstalledSkills({ query: "refund", fromDir: workDir });
    expect(result2.hits).toHaveLength(1);
    expect(result2.hits[0].name).toBe("Refund-Helper");
  });
});

describe("searchInstalledSkills — fields filter", () => {
  it("--fields tags only searches the tags field", async () => {
    await writeSkillDir(workDir, "name-has-finance", {
      description: "Use this when the user asks for the demo skill described in this file.",
      tags: ["other"],
    });
    await writeSkillDir(workDir, "tagged", {
      description: "Use this when the user asks for the demo skill described in this file.",
      tags: ["finance", "accounting"],
    });

    const result = await searchInstalledSkills({
      query: "finance",
      fromDir: workDir,
      fields: ["tags"],
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("tagged");
  });
});

describe("searchInstalledSkills — limit", () => {
  it("--limit 2 caps the number of returned hits", async () => {
    await writeSkillDir(workDir, "demo-1");
    await writeSkillDir(workDir, "demo-2");
    await writeSkillDir(workDir, "demo-3");
    await writeSkillDir(workDir, "demo-4");

    const result = await searchInstalledSkills({ query: "demo", fromDir: workDir, limit: 2 });

    expect(result.hits).toHaveLength(2);
    expect(result.totalScanned).toBe(4);
  });
});

describe("searchInstalledSkills — input validation", () => {
  it("throws on an empty query", async () => {
    await expect(searchInstalledSkills({ query: "", fromDir: workDir })).rejects.toThrow(/query/i);
  });

  it("throws on a whitespace-only query", async () => {
    await expect(searchInstalledSkills({ query: "   ", fromDir: workDir })).rejects.toThrow(
      /query/i,
    );
  });
});

describe("searchInstalledSkills — no matches", () => {
  it("returns empty hits but accurate totalScanned when nothing matches", async () => {
    await writeSkillDir(workDir, "alpha");
    await writeSkillDir(workDir, "beta");

    const result = await searchInstalledSkills({ query: "zzznotpresent", fromDir: workDir });
    expect(result.hits).toEqual([]);
    expect(result.totalScanned).toBe(2);
  });
});

describe("searchInstalledSkills — missing directory", () => {
  it("returns an empty result when the fromDir doesn't exist (matches `ls`)", async () => {
    const result = await searchInstalledSkills({
      query: "anything",
      fromDir: join(workDir, "does-not-exist"),
    });
    expect(result.hits).toEqual([]);
    expect(result.totalScanned).toBe(0);
  });
});

describe("searchInstalledSkills — invalid skill is skipped", () => {
  it("silently skips skill dirs with invalid frontmatter (matches `ls` default behavior)", async () => {
    await writeSkillDir(workDir, "valid-skill", {
      description: "Use this when the user asks for the demo skill described in this file.",
    });
    // A "skill" dir whose SKILL.md has missing required fields.
    const broken = join(workDir, "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "SKILL.md"), "---\nname: broken\n---\nno description\n");

    const result = await searchInstalledSkills({ query: "demo", fromDir: workDir });
    expect(result.totalScanned).toBe(1); // only valid skill counted
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].name).toBe("valid-skill");
  });
});

describe("searchInstalledSkills — body match and highlights", () => {
  it("matches body text and includes a highlight snippet around the first match", async () => {
    await writeSkillDir(workDir, "deep-body", {
      body: "# body\n\nThis paragraph mentions encryption protocols in passing.\n",
    });

    const result = await searchInstalledSkills({ query: "encryption", fromDir: workDir });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].highlights.length).toBeGreaterThan(0);
    const snippet = result.hits[0].highlights[0].snippet.toLowerCase();
    expect(snippet).toContain("encryption");
  });

  it("excludes the body when --fields name,description is set", async () => {
    await writeSkillDir(workDir, "alpha", {
      body: "# body\n\nThis paragraph mentions encryption protocols in passing.\n",
    });

    const result = await searchInstalledSkills({
      query: "encryption",
      fromDir: workDir,
      fields: ["name", "description"],
    });
    expect(result.hits).toEqual([]);
  });
});
