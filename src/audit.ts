/**
 * `skillforge audit <dir>` — fleet security + quality scan over every skill
 * directory at the top level of `fromDir`. Each skill directory is walked
 * once; built-in rules emit findings keyed by `<severity, skillName, ruleId,
 * filePath?>`. The report is consumed by the CLI for the human-readable
 * table and by callers that want structured findings via `--json`.
 *
 * Composition, not refactor — re-uses `lint`/`validate` only by way of file
 * conventions, never by importing their internals.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import matter from "gray-matter";

export type AuditSeverity = "error" | "warning" | "info";

export interface AuditFinding {
  skillName: string;
  ruleId: string;
  severity: AuditSeverity;
  message: string;
  filePath?: string;
}

export interface AuditOptions {
  fromDir: string;
  severityFilter?: AuditSeverity;
}

export interface AuditReport {
  fromDir: string;
  skillCount: number;
  scanned: string[];
  findings: AuditFinding[];
  summary: { error: number; warning: number; info: number };
}

const ONE_MB = 1024 * 1024;

const TEXT_EXTS = new Set([".md", ".markdown", ".yaml", ".yml", ".json", ".txt"]);

export async function auditSkills(opts: AuditOptions): Promise<AuditReport> {
  const fromDir = resolve(opts.fromDir);
  const st = await stat(fromDir).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`audit: ${opts.fromDir} is not a directory`);
  }

  const entries = await readdir(fromDir, { withFileTypes: true });
  const scanned: string[] = [];
  const findings: AuditFinding[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(fromDir, entry.name);
    const skillName = await readSkillName(skillDir);
    if (!skillName) continue; // not a skill — silently skip
    scanned.push(skillName);
    await walkAndAudit(skillDir, skillName, findings);
  }

  const filtered = opts.severityFilter
    ? findings.filter((f) => f.severity === opts.severityFilter)
    : findings;

  const summary = {
    error: filtered.filter((f) => f.severity === "error").length,
    warning: filtered.filter((f) => f.severity === "warning").length,
    info: filtered.filter((f) => f.severity === "info").length,
  };

  return {
    fromDir,
    skillCount: scanned.length,
    scanned,
    findings: filtered,
    summary,
  };
}

async function readSkillName(skillDir: string): Promise<string | null> {
  const skillMd = join(skillDir, "SKILL.md");
  const exists = await stat(skillMd).catch(() => null);
  if (!exists) return null;
  try {
    const raw = await readFile(skillMd, "utf8");
    const parsed = matter(raw);
    const name = (parsed.data as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // fall through
  }
  return basename(skillDir);
}

async function walkAndAudit(
  skillDir: string,
  skillName: string,
  findings: AuditFinding[],
): Promise<void> {
  // Pre-audit the SKILL.md frontmatter + body for quality rules
  const skillMd = join(skillDir, "SKILL.md");
  try {
    const raw = await readFile(skillMd, "utf8");
    const parsed = matter(raw);
    const desc = (parsed.data as { description?: unknown }).description;
    if (typeof desc !== "string" || desc.length < 40 || /TODO/i.test(desc)) {
      findings.push({
        skillName,
        ruleId: "quality/vague-description",
        severity: "warning",
        message: "frontmatter `description` is too short or still says TODO",
        filePath: "SKILL.md",
      });
    }
    if (!/^##\s+Examples/im.test(parsed.content)) {
      findings.push({
        skillName,
        ruleId: "quality/missing-examples",
        severity: "info",
        message: "SKILL.md has no `## Examples` section",
        filePath: "SKILL.md",
      });
    }
    if (/\b(TODO|FIXME)\b/.test(parsed.content)) {
      findings.push({
        skillName,
        ruleId: "quality/todo-marker",
        severity: "info",
        message: "SKILL.md body contains a TODO/FIXME marker",
        filePath: "SKILL.md",
      });
    }
  } catch {
    // SKILL.md unreadable — already gated by readSkillName, no-op
  }

  await walkFiles(skillDir, skillDir, skillName, findings);
}

async function walkFiles(
  rootDir: string,
  currentDir: string,
  skillName: string,
  findings: AuditFinding[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const abs = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(rootDir, abs, skillName, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(rootDir, abs);
    const st = await stat(abs);
    const lowerName = entry.name.toLowerCase();
    const ext = lowerName.includes(".") ? `.${lowerName.split(".").pop() ?? ""}` : "";

    // security/embedded-binary — > 1MB and not a known text extension
    if (st.size > ONE_MB && !TEXT_EXTS.has(ext)) {
      findings.push({
        skillName,
        ruleId: "security/embedded-binary",
        severity: "error",
        message: `embedded ${(st.size / ONE_MB).toFixed(1)} MB file at ${rel} — refuse to ship binaries`,
        filePath: rel,
      });
    }

    // security/exec-bit — file with any exec permission bit set.
    // Windows NTFS doesn't expose Unix exec bits via stat.mode, so this rule
    // is POSIX-only. On Windows process.platform === "win32" → skip.
    if (process.platform !== "win32" && (st.mode & 0o111) !== 0) {
      findings.push({
        skillName,
        ruleId: "security/exec-bit",
        severity: "warning",
        message: `file ${rel} has the exec bit set — review before shipping`,
        filePath: rel,
      });
    }

    // security/shell-shebang — content starts with #!/bin/sh or #!/bin/bash
    if (entry.name === "SKILL.md") continue;
    try {
      const head = await readFile(abs, { encoding: "utf8" }).catch(() => "");
      const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
      // matches any of: `#!/bin/sh`, `#!/usr/bin/bash`, `#!/usr/bin/env zsh`, …
      if (/^#!\s*(\/\S*\/)?(env\s+)?(sh|bash|zsh)\b/.test(firstLine)) {
        findings.push({
          skillName,
          ruleId: "security/shell-shebang",
          severity: "warning",
          message: `shell shebang at top of ${rel} — review before shipping`,
          filePath: rel,
        });
      }
    } catch {
      // unreadable, skip
    }
  }
}
