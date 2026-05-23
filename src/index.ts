/** Public programmatic API. */
export { initSkill, type InitOptions } from "./init.js";
export {
  computeExitCode,
  type Issue,
  lintSkill,
  type LintOptions,
  type LintResult,
  type Severity,
} from "./lint.js";
export { SkillFrontmatterSchema, type SkillFrontmatter } from "./schema.js";
export { validateSkill, type ValidateResult } from "./validate.js";
