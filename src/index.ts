/** Public programmatic API. */
export {
  type BodyHeadingsDiff,
  type BodyLinesDelta,
  type DiffResult,
  diffSkills,
  type FrontmatterChange,
  type FrontmatterDiff,
  type HeadingMove,
} from "./diff.js";
export { type FormatOptions, type FormatResult, formatSkill } from "./format.js";
export { initSkill, type InitOptions } from "./init.js";
export {
  type InspectBodyStats,
  type InspectOptions,
  type InspectResult,
  type InspectSummary,
  inspectSkill,
} from "./inspect.js";
export {
  computeExitCode,
  type Issue,
  lintSkill,
  type LintOptions,
  type LintResult,
  type Severity,
} from "./lint.js";
export { SkillFrontmatterSchema, type SkillFrontmatter } from "./schema.js";
export {
  type BumpKind,
  bumpVersion,
  type UpdateOptions,
  type UpdateResult,
  updateSkillVersion,
} from "./update.js";
export { validateSkill, type ValidateResult } from "./validate.js";
