/**
 * `skillforge search <query>` — ranked keyword search across installed skills.
 *
 * Natural complement to `ls`: once a user has accumulated more than a handful
 * of skills, "what was that one about refunds?" becomes a harder question
 * than the listing command can answer. `search` walks the same install tree
 * `ls` walks, indexes each skill's frontmatter and body, and ranks the
 * results with a simple TF-style weighted score.
 *
 * Behaviour rules:
 *
 *   1. **Same discovery as `ls`.** Reuses `listInstalledSkills` so anything
 *      `ls` won't show, `search` won't search — invalid frontmatter, missing
 *      SKILL.md, etc. all skipped silently. A missing `fromDir` yields zero
 *      hits, not an error. No need to re-implement the directory contract.
 *
 *   2. **Per-field weighted TF scoring.** Name=5, description=3, tags=2,
 *      body=1. Each token of the query is counted (case-insensitive
 *      `indexOf` loop), and the per-field score is `weight * (1 + log(n))`
 *      where n is the match count for that field. The log dampener keeps a
 *      single giant body from steamrolling tighter name hits. Per-skill
 *      scores are summed across fields and tokens, then normalised so the
 *      top hit gets `score: 1` — easier to read than raw weights.
 *
 *   3. **OR semantics for multi-token queries.** Whitespace-splits the query
 *      and each token contributes independently. A skill that matches *any*
 *      token gets some score; a skill matching multiple tokens scores
 *      higher. This is what GitHub CLI / vscode-extensions list / npm
 *      search all do — AND-semantics is too strict for a discovery tool.
 *
 *   4. **Highlights from the highest-scoring field.** A 60-char window
 *      (±30 chars) around the first match in that field, with `…` markers
 *      when truncated. One highlight per hit is enough for a CLI; richer
 *      highlighting belongs in a UI.
 *
 *   5. **Zero-score skills are excluded.** A skill that no token touched
 *      doesn't belong in the result set; padding the list with non-matches
 *      would be louder than helpful.
 *
 *   6. **Empty query is a hard error.** This is a search command — the
 *      caller forgot to type the argument. Surface that instead of dumping
 *      every installed skill at score 0.
 *
 * No new runtime deps. Uses `listInstalledSkills` for the directory contract
 * and `gray-matter` (already a dep) for body extraction.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { listInstalledSkills } from "./ls.js";

export type SearchField = "name" | "description" | "tags" | "body";

export interface SearchOptions {
  /** Query string. Whitespace-split into tokens for OR-semantic matching. */
  query: string;
  /** Root directory to scan. Defaults to `~/.claude/skills`. */
  fromDir?: string;
  /** Cap the number of hits returned. Default: 20. */
  limit?: number;
  /** Restrict which fields are searched. Default: all four. */
  fields?: SearchField[];
}

export interface SearchHighlight {
  /** Which field the snippet was extracted from. */
  field: SearchField;
  /** ~60-char window centred on the first match; `…` at truncated ends. */
  snippet: string;
}

export interface SearchHit {
  /** Skill name pulled from SKILL.md frontmatter. */
  name: string;
  /** Skill version pulled from SKILL.md frontmatter. */
  version: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** Normalised score in (0, 1]; higher = better. Top hit is always 1. */
  score: number;
  /** Snippets around the first match in the highest-scoring field. */
  highlights: SearchHighlight[];
}

export interface SearchResult {
  /** Absolute path of the directory that was scanned. */
  fromDir: string;
  /** Echo of the user's raw query, untouched. */
  query: string;
  /** Ranked hits, score descending. Length <= `limit`. */
  hits: SearchHit[];
  /** Number of valid skills considered (denominator for "did we find anything"). */
  totalScanned: number;
}

const DEFAULT_FIELDS: SearchField[] = ["name", "description", "tags", "body"];
const FIELD_WEIGHTS: Record<SearchField, number> = {
  name: 5,
  description: 3,
  tags: 2,
  body: 1,
};
const DEFAULT_LIMIT = 20;
const SNIPPET_RADIUS = 30;

/**
 * Search installed skills for `query`. Walks the same directory `ls` walks,
 * scores each skill's chosen fields with weighted TF, and returns hits
 * sorted by score descending.
 */
export async function searchInstalledSkills(opts: SearchOptions): Promise<SearchResult> {
  const rawQuery = opts.query ?? "";
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("search: query must contain at least one non-whitespace character");
  }

  const fields: SearchField[] =
    opts.fields && opts.fields.length > 0 ? opts.fields : DEFAULT_FIELDS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // `ls` already encodes the "what counts as an installed skill" contract:
  // directory must contain a valid SKILL.md; missing root → empty result.
  // Reuse it so the two commands can never disagree on discovery.
  const lsResult = await listInstalledSkills({ fromDir: opts.fromDir });
  const fromDir = lsResult.fromDir;

  const lowerTokens = tokens.map((t) => t.toLowerCase());
  const rawHits: Array<{ hit: SearchHit; rawScore: number }> = [];

  for (const skill of lsResult.skills) {
    // We need the body text for the body field + a snippet source; read the
    // SKILL.md and parse it the same way `ls` did. (`ls` discards the body
    // after validation, so we re-parse here rather than widen `LsResult`.)
    const skillMdPath = join(skill.path, "SKILL.md");
    const raw = await readFile(skillMdPath, "utf8");
    const parsed = matter(raw);
    const fm = (parsed.data ?? {}) as Record<string, unknown>;

    const fieldText: Record<SearchField, string> = {
      name: typeof fm.name === "string" ? fm.name : skill.name,
      description: typeof fm.description === "string" ? fm.description : "",
      tags: Array.isArray(fm.tags) ? fm.tags.filter((t) => typeof t === "string").join(" ") : "",
      body: parsed.content,
    };

    let totalScore = 0;
    const perFieldScore: Partial<Record<SearchField, number>> = {};
    for (const field of fields) {
      const text = fieldText[field];
      if (!text) continue;
      const lower = text.toLowerCase();
      let matches = 0;
      for (const tok of lowerTokens) {
        matches += countOccurrences(lower, tok);
      }
      if (matches === 0) continue;
      // log dampener keeps a runaway body from drowning out tighter hits;
      // weight encodes "name beats description beats tags beats body".
      const fieldScore = FIELD_WEIGHTS[field] * (1 + Math.log(matches));
      perFieldScore[field] = fieldScore;
      totalScore += fieldScore;
    }

    if (totalScore <= 0) continue;

    // Pick the highest-scoring field for the snippet — most informative
    // location to point the reader at. Tie-break by `DEFAULT_FIELDS` order
    // (name > description > tags > body) so output is deterministic.
    const bestField = pickBestField(perFieldScore);
    const highlights: SearchHighlight[] = bestField
      ? [{ field: bestField, snippet: buildSnippet(fieldText[bestField], lowerTokens) }]
      : [];

    rawHits.push({
      rawScore: totalScore,
      hit: {
        name: skill.name,
        version: skill.version,
        path: skill.path,
        score: totalScore, // normalised after the loop
        highlights,
      },
    });
  }

  rawHits.sort((a, b) => b.rawScore - a.rawScore);
  // Normalise so the top hit gets `1`. Easier for humans + downstream
  // formatters than comparing raw log-weighted counts.
  const top = rawHits[0]?.rawScore ?? 0;
  const normalised = rawHits.map(({ hit, rawScore }) => ({
    ...hit,
    score: top > 0 ? rawScore / top : 0,
  }));

  return {
    fromDir,
    query: rawQuery,
    hits: normalised.slice(0, Math.max(0, limit)),
    totalScanned: lsResult.skills.length,
  };
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`. Both args
 * must already be lowercased — caller's responsibility.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const next = haystack.indexOf(needle, i);
    if (next === -1) return n;
    n += 1;
    i = next + needle.length;
  }
}

/**
 * Pick the field with the highest score; tie-break by `DEFAULT_FIELDS`
 * order so equally-weighted fields prefer name > description > tags > body.
 * Returns `undefined` only when the map is empty (shouldn't happen at the
 * call site, but keeps the type honest).
 */
function pickBestField(scores: Partial<Record<SearchField, number>>): SearchField | undefined {
  let best: SearchField | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const field of DEFAULT_FIELDS) {
    const s = scores[field];
    if (s === undefined) continue;
    if (s > bestScore) {
      best = field;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Build a ~60-char window centred on the first matching token in `text`.
 * Truncated ends get a `…` marker so the reader can tell the snippet was
 * sliced. Whitespace is collapsed for readability (newlines in a body
 * snippet wreck CLI alignment).
 */
function buildSnippet(text: string, lowerTokens: string[]): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const lower = collapsed.toLowerCase();
  let bestIdx = -1;
  for (const tok of lowerTokens) {
    const idx = lower.indexOf(tok);
    if (idx === -1) continue;
    if (bestIdx === -1 || idx < bestIdx) bestIdx = idx;
  }
  if (bestIdx === -1) {
    // No token found in this field — defensive, callers only invoke with
    // a positive-scoring field but the type system can't prove it.
    return collapsed.slice(0, SNIPPET_RADIUS * 2);
  }
  const start = Math.max(0, bestIdx - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, bestIdx + SNIPPET_RADIUS);
  let snippet = collapsed.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < collapsed.length) snippet = `${snippet}…`;
  return snippet;
}
