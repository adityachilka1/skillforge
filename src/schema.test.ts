import { describe, expect, it } from "vitest";
import { SkillFrontmatterSchema } from "./schema.js";

describe("SkillFrontmatterSchema", () => {
  it("accepts a minimal valid frontmatter", () => {
    const r = SkillFrontmatterSchema.parse({
      name: "code-review",
      description: "Use this when the user asks for a code review on a diff or pull request.",
    });
    expect(r.name).toBe("code-review");
    expect(r.version).toBe("0.0.1");
    expect(r.tags).toEqual([]);
  });

  it("rejects missing description", () => {
    expect(() => SkillFrontmatterSchema.parse({ name: "x", description: "" })).toThrow(
      /at least 20 chars/,
    );
  });

  it("rejects an absurdly long description", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: "x",
        description: "a".repeat(600),
      }),
    ).toThrow(/<= 500 chars/);
  });

  it("rejects a malformed semver version", () => {
    expect(() =>
      SkillFrontmatterSchema.parse({
        name: "x",
        description: "Use this when the user asks for a code review.",
        version: "not-a-version",
      }),
    ).toThrow(/valid semver/);
  });

  it("preserves unknown fields (forward-compat)", () => {
    const r = SkillFrontmatterSchema.parse({
      name: "x",
      description: "Use this when the user asks for a code review.",
      mystery_anthropic_field: "preserved",
    });
    expect((r as Record<string, unknown>).mystery_anthropic_field).toBe("preserved");
  });
});
