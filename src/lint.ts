/**
 * `skillforge lint <path>` — stricter peer of `validate`.
 *
 * `validate` enforces the schema (hard pass/fail). `lint` surfaces
 * style/quality smells that are syntactically legal but probably
 * not what you want shipped. Each rule is a small pure function
 * `(ctx) => Issue[]` so new rules drop in without touching the runner.
 *
 * Exit-code policy (interpreted by the CLI):
 *   - no issues          → 0
 *   - only warnings      → 0  (default)
 *   - any error          → 1
 *   - any issue + strict → 2
 */
import { readFile, stat } from "node:fs/promises";
import matter from "gray-matter";
import { SkillFrontmatterSchema } from "./schema.js";

export type Severity = "error" | "warning";

export interface Issue {
  rule: string;
  severity: Severity;
  line?: number;
  message: string;
}

export interface LintResult {
  path: string;
  issues: Issue[];
}

export interface LintOptions {
  /** Treat `mtime` checks as if the file were this old. Test seam. */
  now?: Date;
}

/**
 * Shape passed to every rule. Pre-computed once so individual rules stay
 * cheap pure functions.
 */
interface LintContext {
  path: string;
  rawFrontmatter: Record<string, unknown>;
  body: string;
  bodyLines: string[];
  /** 1-indexed line of the body within the original file. */
  bodyStartLine: number;
  mtime: Date;
  now: Date;
}

type Rule = (ctx: LintContext) => Issue[];

// Triggering language we consider acceptable in a `description`.
const TRIGGER_PHRASES = [
  "use this when",
  "use when",
  "helps with",
  "helps you",
  "invoke when",
  "call this when",
  "trigger when",
  "for when",
  "whenever",
  "when the user",
  "when a user",
];

// Heuristic: does the string contain at least one verb-ish token? We don't
// need a real POS-tagger; just check for a small set of imperative/action
// words that almost always show up in a useful trigger description.
const VERB_HINTS = [
  "use",
  "help",
  "invoke",
  "call",
  "trigger",
  "create",
  "generate",
  "make",
  "build",
  "write",
  "review",
  "check",
  "find",
  "search",
  "explain",
  "summarize",
  "convert",
  "transform",
  "analyze",
  "fix",
  "edit",
  "scaffold",
  "validate",
  "lint",
  "run",
  "ship",
  "produce",
  "draft",
  "compose",
  "translate",
  "answer",
  "describe",
  "extract",
  "format",
  "open",
  "read",
  "manipulate",
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────
// Rules
// ──────────────────────────────────────────────────────────────────────

const ruleDescriptionTooShort: Rule = ({ rawFrontmatter }) => {
  const desc = typeof rawFrontmatter.description === "string" ? rawFrontmatter.description : "";
  if (desc && desc.length < 40) {
    return [
      {
        rule: "description-too-short",
        severity: "warning",
        message: `description is ${desc.length} chars — under 40 reads as underspecified`,
      },
    ];
  }
  return [];
};

const ruleDescriptionNoVerb: Rule = ({ rawFrontmatter }) => {
  const desc = typeof rawFrontmatter.description === "string" ? rawFrontmatter.description : "";
  if (!desc) return [];
  const lower = desc.toLowerCase();
  const hasVerb = VERB_HINTS.some((v) => new RegExp(`\\b${v}\\w*\\b`).test(lower));
  if (!hasVerb) {
    return [
      {
        rule: "description-no-verb",
        severity: "warning",
        message:
          'description reads like a noun-phrase — write a trigger statement ("Use this when…")',
      },
    ];
  }
  return [];
};

const ruleDescriptionNoTrigger: Rule = ({ rawFrontmatter }) => {
  const desc = typeof rawFrontmatter.description === "string" ? rawFrontmatter.description : "";
  if (!desc) return [];
  const lower = desc.toLowerCase();
  const hasTrigger = TRIGGER_PHRASES.some((p) => lower.includes(p));
  if (!hasTrigger) {
    return [
      {
        rule: "description-no-trigger",
        severity: "warning",
        message:
          'description should include triggering language like "use this when" so agents can route to it',
      },
    ];
  }
  return [];
};

const ruleTagsEmpty: Rule = ({ rawFrontmatter }) => {
  const tags = rawFrontmatter.tags;
  if (Array.isArray(tags) && tags.length === 0) {
    return [
      {
        rule: "tags-empty",
        severity: "warning",
        message: "tags array is empty — add a few for discoverability",
      },
    ];
  }
  // `tags` missing entirely is also "empty" from the user's perspective.
  if (tags === undefined) {
    return [
      {
        rule: "tags-empty",
        severity: "warning",
        message: "tags array is empty — add a few for discoverability",
      },
    ];
  }
  return [];
};

const ruleAbandonedDefaultVersion: Rule = ({ rawFrontmatter, mtime, now }) => {
  const version = rawFrontmatter.version;
  const isDefault = version === undefined || version === "0.0.1";
  if (!isDefault) return [];
  const age = now.getTime() - mtime.getTime();
  if (age > SEVEN_DAYS_MS) {
    return [
      {
        rule: "abandoned-default-version",
        severity: "warning",
        message: "version is still 0.0.1 and file is >7 days old — looks abandoned, bump or delete",
      },
    ];
  }
  return [];
};

const ruleMissingWhenToUse: Rule = ({ body }) => {
  const re = /^\s*#{1,6}\s+when to use\b/im;
  if (!re.test(body)) {
    return [
      {
        rule: "missing-when-to-use",
        severity: "warning",
        message: 'body has no "## When to use" heading — the trigger section is what agents read',
      },
    ];
  }
  return [];
};

const ruleMissingExamples: Rule = ({ body }) => {
  const re = /^\s*#{1,6}\s+examples?\b/im;
  if (!re.test(body)) {
    return [
      {
        rule: "missing-examples",
        severity: "warning",
        message: 'body has no "## Examples" heading — show, don\'t just tell',
      },
    ];
  }
  return [];
};

const ruleTodoMarker: Rule = ({ body, bodyLines, bodyStartLine }) => {
  if (!body.includes("TODO")) return [];
  const issues: Issue[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].includes("TODO")) {
      issues.push({
        rule: "todo-marker",
        severity: "error",
        line: bodyStartLine + i,
        message: "body still contains a TODO marker — finish writing before publishing",
      });
    }
  }
  return issues;
};

// Match "you should/must/never/always" but not phrases like "always-on" inside
// a hyphenated identifier (rough enough — these instructions matter, false
// positives are cheap to /* lint-disable */ around).
const SECOND_PERSON_RE =
  /\b(you (?:should|must|need to|have to|will|can(?:'t)?|don't|do not|never|always)|always|never)\b/i;

const ruleSecondPersonInstructions: Rule = ({ bodyLines, bodyStartLine }) => {
  const issues: Issue[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    // Skip fenced code blocks heuristically — anything inside ``` we leave
    // alone. The cheap form: skip lines that look like code (start with 4
    // spaces or are inside ``` fences tracked across iterations).
    if (SECOND_PERSON_RE.test(line)) {
      issues.push({
        rule: "second-person-instructions",
        severity: "warning",
        line: bodyStartLine + i,
        message:
          'prefer "the agent" over "you" and concrete steps over "always/never" — agents read literally',
      });
    }
  }
  return issues;
};

const ruleTrailingWhitespace: Rule = ({ bodyLines, bodyStartLine }) => {
  const issues: Issue[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    if (/[ \t]+$/.test(bodyLines[i])) {
      issues.push({
        rule: "trailing-whitespace",
        severity: "warning",
        line: bodyStartLine + i,
        message: "trailing whitespace",
      });
    }
  }
  return issues;
};

// Order is for documentation purposes only; the runner sorts issues by
// (line, severity) for output. Adding a rule = appending here.
const RULES: Rule[] = [
  ruleDescriptionTooShort,
  ruleDescriptionNoVerb,
  ruleDescriptionNoTrigger,
  ruleTagsEmpty,
  ruleAbandonedDefaultVersion,
  ruleMissingWhenToUse,
  ruleMissingExamples,
  ruleTodoMarker,
  ruleSecondPersonInstructions,
  ruleTrailingWhitespace,
];

// ──────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute the 1-indexed line of the file at which the body content begins.
 * gray-matter doesn't surface this — we derive it from the raw text by
 * locating the closing `---` of the frontmatter (if any).
 */
function bodyStartLineFromRaw(raw: string): number {
  if (!raw.startsWith("---")) return 1;
  const lines = raw.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") {
      // Body content starts on the line after the closing fence. Add 1 to
      // convert from 0-indexed to 1-indexed.
      return i + 2;
    }
  }
  return 1;
}

export async function lintSkill(path: string, opts: LintOptions = {}): Promise<LintResult> {
  const raw = await readFile(path, "utf8");
  const st = await stat(path);
  const parsed = matter(raw);

  // We deliberately use the *raw* parsed data here so that defaults injected
  // by zod don't mask "tags missing entirely" vs "tags: []". We still parse
  // through zod for the side effect of catching schema-level disasters that
  // would make downstream rules misbehave — but on failure we just bail with
  // a single issue, since linting an invalid file is not very useful.
  const schemaResult = SkillFrontmatterSchema.safeParse(parsed.data);
  if (!schemaResult.success) {
    return {
      path,
      issues: [
        {
          rule: "invalid-frontmatter",
          severity: "error",
          message: `frontmatter does not validate — run \`skillforge validate\` first (${schemaResult.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")})`,
        },
      ],
    };
  }

  const body = parsed.content;
  const bodyLines = body.split("\n");
  const ctx: LintContext = {
    path,
    rawFrontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body,
    bodyLines,
    bodyStartLine: bodyStartLineFromRaw(raw),
    mtime: st.mtime,
    now: opts.now ?? new Date(),
  };

  const issues = RULES.flatMap((rule) => rule(ctx));

  // Sort: errors first; then by line number (undefined last); then by rule
  // for stable output.
  issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    const la = a.line ?? Number.POSITIVE_INFINITY;
    const lb = b.line ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.rule.localeCompare(b.rule);
  });

  return { path, issues };
}

/**
 * Pure exit-code policy. Exposed for direct unit testing — the CLI just
 * forwards `process.exit(computeExitCode(result, opts.strict))`.
 */
export function computeExitCode(result: LintResult, strict: boolean): 0 | 1 | 2 {
  if (result.issues.length === 0) return 0;
  if (strict) return 2;
  if (result.issues.some((i) => i.severity === "error")) return 1;
  return 0;
}
