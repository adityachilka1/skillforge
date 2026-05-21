/**
 * Frontmatter schema for SKILL.md files.
 *
 * Mirrors the public Claude Skills format. We don't pretend to know every
 * field Anthropic might add later — we validate what we know and pass
 * everything else through untouched.
 */
import { z } from "zod";

export const SkillFrontmatterSchema = z
  .object({
    /** Human-readable display name. Required. */
    name: z.string().min(1, "name is required").max(80, "name must be <= 80 chars"),
    /**
     * One- or two-sentence description that the agent uses to decide when to
     * invoke this skill. The single most important field — write it from the
     * agent's perspective, not yours.
     */
    description: z
      .string()
      .min(20, "description must be at least 20 chars — agents need context to route correctly")
      .max(500, "description must be <= 500 chars; longer ones train poorly"),
    /** Optional semver string. Defaults to "0.0.1" if omitted. */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(-[\w.+]+)?$/, "version must be valid semver, e.g. 1.0.0 or 1.0.0-beta")
      .default("0.0.1"),
    /** Optional list of tags for discovery. */
    tags: z.array(z.string()).default([]),
    /** Optional author handle (e.g. "@adityachilka1"). */
    author: z.string().optional(),
    /** Optional URL to a project home, repo, or docs page. */
    homepage: z.string().url().optional(),
  })
  .passthrough(); // unknown fields preserved, not stripped

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
