/**
 * `skillforge diff <a> <b>` — structural comparison of two SKILL.md files.
 *
 * Ninth piece of the authoring workflow after `init`, `validate`, `lint`,
 * `pack`, `install`, `update`, `format`, `inspect`. A plain `diff` on a
 * SKILL.md file is noisy: a reordered heading, a one-word frontmatter
 * change, and a re-wrapped paragraph all look like sprawling churn. `diff`
 * pulls the *structural* signal out: which frontmatter fields changed,
 * which H2/H3 sections were added/removed/reordered, and a coarse body
 * line-count delta.
 *
 * Side-effect free: this command never writes to disk. Refuses to diff
 * either file if its frontmatter doesn't validate — the structural diff
 * assumes parseable inputs; broken files should be fixed first.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { SkillFrontmatterSchema } from "./schema.js";

export interface FrontmatterChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface FrontmatterDiff {
  /** Fields present in B but not A, keyed by field name. */
  added: Record<string, unknown>;
  /** Fields present in A but not B, keyed by field name. */
  removed: Record<string, unknown>;
  /** Fields present in both with non-equal values. */
  changed: FrontmatterChange[];
}

export interface HeadingMove {
  heading: string;
  from: number;
  to: number;
}

export interface BodyHeadingsDiff {
  /** Headings present in B but not A. */
  added: string[];
  /** Headings present in A but not B. */
  removed: string[];
  /**
   * Headings present in both whose document position shifted. `from` is the
   * 0-indexed position in A, `to` is the 0-indexed position in B, computed
   * over the set of common headings (i.e. excluding adds/removes so a
   * single insert doesn't cascade as N moves).
   */
  reordered: HeadingMove[];
}

export interface BodyLinesDelta {
  /** Lines in B that aren't in A (coarse `+` count). */
  added: number;
  /** Lines in A that aren't in B (coarse `-` count). */
  removed: number;
}

export interface DiffResult {
  pathA: string;
  pathB: string;
  frontmatter: FrontmatterDiff;
  bodyHeadings: BodyHeadingsDiff;
  bodyLinesDelta: BodyLinesDelta;
  /**
   * True iff there are zero frontmatter changes, zero heading changes, and
   * the body line counts match. A stronger "byte-identical" check would
   * also catch prose tweaks; this is the structural-equivalence signal.
   */
  identical: boolean;
}

/**
 * Extract level-2 and level-3 headings from the body, in document order,
 * skipping anything inside a fenced code block. Mirrors the parser in
 * `inspect.ts` but widened from `##` only to `##` + `###` — diff cares
 * about subsections too because authors often slice a section into named
 * subsections, and treating that as one heading would hide real change.
 */
function extractHeadings(body: string): string[] {
  const headings: string[] = [];
  const lines = body.split("\n");
  let inFence = false;
  const fenceRe = /^\s{0,3}(```+|~~~+)/;
  for (const line of lines) {
    if (fenceRe.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) headings.push(m[2]);
  }
  return headings;
}

/**
 * Structural equality for frontmatter values. Arrays and plain objects are
 * compared by deep value, scalars by `Object.is`. We deliberately avoid
 * `JSON.stringify` round-trip — `undefined` inside arrays would silently
 * coerce to `null` and falsely report equality.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.hasOwn(bo, k)) return false;
      if (!valuesEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

function diffFrontmatter(a: Record<string, unknown>, b: Record<string, unknown>): FrontmatterDiff {
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: FrontmatterChange[] = [];

  // Stable key order: union of (A keys, then B-only keys), each set sorted.
  // Deterministic output matters for snapshot tests and human scanning.
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  const bSet = new Set(bKeys);
  const aSet = new Set(aKeys);

  for (const k of aKeys) {
    if (!bSet.has(k)) {
      removed[k] = a[k];
      continue;
    }
    if (!valuesEqual(a[k], b[k])) {
      changed.push({ key: k, before: a[k], after: b[k] });
    }
  }
  for (const k of bKeys) {
    if (!aSet.has(k)) {
      added[k] = b[k];
    }
  }
  return { added, removed, changed };
}

/**
 * Compute heading-level diff: split into pure adds/removes plus a
 * "reordered" list for the headings present in both. The reorder
 * comparison is done over the *intersection* of heading sets after
 * removing duplicates by name — that way one insertion doesn't cascade
 * as N moves. If a heading appears multiple times in either file we only
 * consider the first occurrence (rare in practice and the alternatives
 * all add complexity for marginal gain).
 */
function diffHeadings(a: string[], b: string[]): BodyHeadingsDiff {
  const aFirstIdx = new Map<string, number>();
  const bFirstIdx = new Map<string, number>();
  a.forEach((h, i) => {
    if (!aFirstIdx.has(h)) aFirstIdx.set(h, i);
  });
  b.forEach((h, i) => {
    if (!bFirstIdx.has(h)) bFirstIdx.set(h, i);
  });

  const added: string[] = [];
  const removed: string[] = [];
  for (const h of bFirstIdx.keys()) {
    if (!aFirstIdx.has(h)) added.push(h);
  }
  for (const h of aFirstIdx.keys()) {
    if (!bFirstIdx.has(h)) removed.push(h);
  }

  // Common headings in their A-order vs B-order. We rank each common
  // heading by its position within the common-only sequence to avoid the
  // cascade-from-insertion problem.
  const common = [...aFirstIdx.keys()].filter((h) => bFirstIdx.has(h));
  const aOrder = a.filter((h) => bFirstIdx.has(h));
  const bOrder = b.filter((h) => aFirstIdx.has(h));
  // De-dup while preserving order — the rank is by *first occurrence*.
  const aSeq: string[] = [];
  const aSeen = new Set<string>();
  for (const h of aOrder) {
    if (!aSeen.has(h)) {
      aSeen.add(h);
      aSeq.push(h);
    }
  }
  const bSeq: string[] = [];
  const bSeen = new Set<string>();
  for (const h of bOrder) {
    if (!bSeen.has(h)) {
      bSeen.add(h);
      bSeq.push(h);
    }
  }
  const aRank = new Map(aSeq.map((h, i) => [h, i]));
  const bRank = new Map(bSeq.map((h, i) => [h, i]));

  const reordered: HeadingMove[] = [];
  for (const h of common) {
    const from = aRank.get(h);
    const to = bRank.get(h);
    if (from !== undefined && to !== undefined && from !== to) {
      reordered.push({ heading: h, from, to });
    }
  }

  added.sort();
  removed.sort();
  reordered.sort((x, y) => x.heading.localeCompare(y.heading));
  return { added, removed, reordered };
}

/**
 * Coarse line delta: count of B-only lines vs A-only lines after
 * collapsing each side into a multiset. Not a real Myers diff — that's
 * what `git diff` is for; this is a one-glance "how much body churn?"
 * signal. Whitespace-only lines collapse together; the multiset uses the
 * raw line text (trailing whitespace stripped to dodge format-only churn).
 */
function diffBodyLines(a: string, b: string): BodyLinesDelta {
  const norm = (s: string) => {
    const lines = s.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
    // Drop ALL trailing empty lines so files that differ only in their
    // trailing newline count don't show a phantom delta.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  const aLines = norm(a);
  const bLines = norm(b);

  // Multiset diff: count occurrences, subtract.
  const aCounts = new Map<string, number>();
  for (const l of aLines) aCounts.set(l, (aCounts.get(l) ?? 0) + 1);
  const bCounts = new Map<string, number>();
  for (const l of bLines) bCounts.set(l, (bCounts.get(l) ?? 0) + 1);

  let added = 0;
  let removed = 0;
  const keys = new Set([...aCounts.keys(), ...bCounts.keys()]);
  for (const k of keys) {
    const av = aCounts.get(k) ?? 0;
    const bv = bCounts.get(k) ?? 0;
    if (bv > av) added += bv - av;
    else if (av > bv) removed += av - bv;
  }
  return { added, removed };
}

async function readAndValidate(
  path: string,
): Promise<{ data: Record<string, unknown>; body: string }> {
  if (!existsSync(path)) {
    throw new Error(`diff: ${path} does not exist`);
  }
  const raw = await readFile(path, "utf8");
  const parsed = matter(raw);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const result = SkillFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`diff: ${path} has invalid frontmatter — fix it first (${detail})`);
  }
  return { data, body: parsed.content };
}

/**
 * Structural diff of two SKILL.md files.
 *
 * @throws when either path doesn't exist or either file's frontmatter
 *         fails schema validation.
 */
export async function diffSkills(pathA: string, pathB: string): Promise<DiffResult> {
  const [a, b] = await Promise.all([readAndValidate(pathA), readAndValidate(pathB)]);

  const frontmatter = diffFrontmatter(a.data, b.data);
  const aHeadings = extractHeadings(a.body);
  const bHeadings = extractHeadings(b.body);
  const bodyHeadings = diffHeadings(aHeadings, bHeadings);
  const bodyLinesDelta = diffBodyLines(a.body, b.body);

  const identical =
    Object.keys(frontmatter.added).length === 0 &&
    Object.keys(frontmatter.removed).length === 0 &&
    frontmatter.changed.length === 0 &&
    bodyHeadings.added.length === 0 &&
    bodyHeadings.removed.length === 0 &&
    bodyHeadings.reordered.length === 0 &&
    bodyLinesDelta.added === 0 &&
    bodyLinesDelta.removed === 0;

  return {
    pathA,
    pathB,
    frontmatter,
    bodyHeadings,
    bodyLinesDelta,
    identical,
  };
}
