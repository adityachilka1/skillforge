/**
 * `skillforge` CLI entry point.
 *
 * Commands:
 *   init <name>     scaffold a new SKILL.md
 *   validate <path> validate a SKILL.md file's frontmatter and body
 *   lint <path>     surface style/quality warnings on a SKILL.md
 *   pack <dir>      bundle a skill directory into a .skill archive
 *   install <url>   download a remote .skill into ~/.claude/skills/
 *   update <path>   bump the version field of a SKILL.md
 *   format <path>   reformat a SKILL.md to canonical shape
 *   inspect <path>  one-shot report: validation + lint + frontmatter + body
 *   diff <a> <b>    structural comparison of two SKILL.md files
 *   tree <dir>      preview the file inventory pack would produce
 */
import { cac } from "cac";
import kleur from "kleur";
import { type DiffResult, diffSkills } from "./diff.js";
import { formatSkill } from "./format.js";
import { initSkill } from "./init.js";
import { type InspectResult, inspectSkill } from "./inspect.js";
import { installSkill } from "./install.js";
import { computeExitCode, lintSkill } from "./lint.js";
import { packSkill } from "./pack.js";
import { type TreeResult, treeSkill } from "./tree.js";
import { type BumpKind, updateSkillVersion } from "./update.js";
import { validateSkill } from "./validate.js";

const VERSION = "0.0.2";
const cli = cac("skillforge");

cli
  .command("init <name>", "Scaffold a new SKILL.md skill")
  .option("--out <dir>", "Parent directory (default: cwd)")
  .option("--force", "Overwrite an existing SKILL.md")
  .action(async (name: string, opts) => {
    try {
      const path = await initSkill({ name, outputDir: opts.out, force: !!opts.force });
      process.stdout.write(`${kleur.green("✓")} scaffolded ${path}\n`);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli.command("validate <path>", "Validate a SKILL.md file").action(async (path: string) => {
  try {
    const result = await validateSkill(path);
    if (result.ok) {
      process.stdout.write(
        `${kleur.green("✓")} ${result.path} — frontmatter valid, ${result.bodyLines} body lines\n`,
      );
      process.exit(0);
    }
    process.stdout.write(`${kleur.red("✗")} ${result.path}\n`);
    for (const issue of result.issues) {
      process.stdout.write(`  ${kleur.red("·")} ${issue}\n`);
    }
    process.exit(1);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  }
});

cli
  .command("lint <path>", "Surface style/quality warnings on a SKILL.md")
  .option("--strict", "Promote warnings to errors for the exit code")
  .option("--json", "Emit machine-readable JSON instead of human output")
  .action(async (path: string, opts) => {
    try {
      const result = await lintSkill(path);
      const exitCode = computeExitCode(result, !!opts.strict);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result.issues, null, 2)}\n`);
        process.exit(exitCode);
      }

      if (result.issues.length === 0) {
        process.stdout.write(`${kleur.green("✓")} ${result.path} — no lint issues\n`);
        process.exit(exitCode);
      }

      const errors = result.issues.filter((i) => i.severity === "error");
      const warnings = result.issues.filter((i) => i.severity === "warning");

      const printGroup = (label: string, color: (s: string) => string, items: typeof errors) => {
        if (items.length === 0) return;
        process.stdout.write(`${color(label)}\n`);
        for (const issue of items) {
          const loc = issue.line ? `${result.path}:${issue.line}` : result.path;
          process.stdout.write(`  ${color("·")} ${loc}: ${issue.rule}: ${issue.message}\n`);
        }
      };

      printGroup(`errors (${errors.length})`, kleur.red, errors);
      printGroup(`warnings (${warnings.length})`, kleur.yellow, warnings);

      process.exit(exitCode);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("pack <dir>", "Bundle a skill directory into a .skill archive")
  .option("--out <file>", "Output path (default: <dirname>.skill in cwd)")
  .option("--skip-validation", "Skip the SKILL.md validation step (debugging only)")
  .action(async (dir: string, opts) => {
    try {
      const result = await packSkill({
        srcDir: dir,
        outPath: opts.out,
        skipValidation: !!opts.skipValidation,
      });
      const sizeKb = (result.size / 1024).toFixed(1);
      process.stdout.write(
        `${kleur.green("✓")} packed ${result.files.length} file${
          result.files.length === 1 ? "" : "s"
        } → ${result.outPath} (${sizeKb} KB)\n`,
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("install <url>", "Download a remote .skill archive and extract it")
  .option("--out <dir>", "Install path (default: ~/.claude/skills/<skill-name>)")
  .option("--force", "Overwrite an existing install directory")
  .option("--dry-run", "Validate and report what would happen, but write nothing")
  .action(async (url: string, opts) => {
    try {
      const result = await installSkill({
        url,
        outDir: opts.out,
        force: !!opts.force,
        dryRun: !!opts.dryRun,
      });
      const prefix = result.dryRun ? kleur.yellow("dry-run") : kleur.green("✓");
      const sizeKb = (result.bytesWritten / 1024).toFixed(1);
      process.stdout.write(
        `${prefix} ${result.skillName} → ${result.outDir} (${result.files.length} file${
          result.files.length === 1 ? "" : "s"
        }, ${sizeKb} KB${result.dryRun ? "; nothing written" : ""})\n`,
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("update <path>", "Bump the version field of a SKILL.md")
  .option("--bump <kind>", "Bump direction: patch, minor, or major")
  .option("--new-version <semver>", "Set the version to an explicit semver string")
  .option("--dry-run", "Report the would-be new version without writing")
  .action(async (path: string, opts) => {
    try {
      if (opts.bump !== undefined && !["patch", "minor", "major"].includes(opts.bump)) {
        throw new Error(`--bump must be one of patch, minor, major (got "${opts.bump}")`);
      }
      const result = await updateSkillVersion({
        path,
        bump: opts.bump as BumpKind | undefined,
        newVersion: opts.newVersion,
        dryRun: !!opts.dryRun,
      });
      const prefix = result.dryRun ? kleur.yellow("dry-run") : kleur.green("✓");
      const suffix = result.dryRun ? " (nothing written)" : "";
      process.stdout.write(
        `${prefix} ${result.path}: ${result.oldVersion} → ${result.newVersion}${suffix}\n`,
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("format <path>", "Reformat a SKILL.md to canonical shape")
  .option("--write", "Write the formatted result back (default: true; pass --write=false to skip)")
  .option("--dry-run", "Compute the formatted result but write nothing")
  .option("--check", "Exit 1 if the file would change; write nothing (CI mode)")
  .action(async (path: string, opts) => {
    try {
      // `--check` is dry-run + a non-zero exit on changes. The CLI fans
      // these flags out; the library API stays simple.
      const isCheck = !!opts.check;
      const dryRun = !!opts.dryRun || isCheck;
      // cac parses `--write=false` to `false`; `--write` alone to `true`;
      // absent to `undefined` (library default of true).
      const writeOpt: boolean | undefined = opts.write;
      const result = await formatSkill({
        path,
        write: writeOpt,
        dryRun,
      });
      if (isCheck) {
        if (result.changed) {
          process.stdout.write(`${kleur.yellow("would-change")} ${result.path}\n`);
          process.exit(1);
        }
        process.stdout.write(`${kleur.green("✓")} ${result.path} — already canonical\n`);
        process.exit(0);
      }
      if (dryRun) {
        const tag = result.changed ? kleur.yellow("dry-run") : kleur.green("✓");
        const suffix = result.changed ? " (nothing written)" : " — already canonical";
        process.stdout.write(`${tag} ${result.path}${suffix}\n`);
        process.exit(0);
      }
      if (writeOpt === false) {
        // Print the formatted output to stdout instead of writing.
        process.stdout.write(result.after);
        process.exit(0);
      }
      if (result.changed) {
        process.stdout.write(`${kleur.green("✓")} formatted ${result.path}\n`);
      } else {
        process.stdout.write(`${kleur.green("✓")} ${result.path} — already canonical\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command(
    "inspect <path>",
    "One-shot report: validation + lint + frontmatter summary + body stats",
  )
  .option("--json", "Emit the full result as JSON (CI-friendly)")
  .action(async (path: string, opts) => {
    try {
      const result = await inspectSkill({ path, json: !!opts.json });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exit(result.summary.ok ? 0 : 1);
      }
      printInspectReport(result);
      process.exit(result.summary.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

/**
 * Human-readable `inspect` report. Tidy multi-section layout: a header, an
 * aligned frontmatter table, body stats with tabular numerals, then any
 * validation issues, lint issues, and the attached-file inventory. Each
 * heading is sentence-case in tracked uppercase — quiet structural signal,
 * not editorial shouting.
 */
function printInspectReport(r: InspectResult): void {
  const out = process.stdout;
  const status = r.summary.ok ? kleur.green("OK") : kleur.red("ISSUES");
  const heading = (label: string) => out.write(`\n${kleur.bold(kleur.dim(label.toUpperCase()))}\n`);

  out.write(`${kleur.bold(r.name ?? "<unparsed>")}  ${kleur.dim(r.path)}  ${status}\n`);

  heading("Frontmatter");
  if (r.frontmatter) {
    const rows: Array<[string, string]> = [
      ["name", r.frontmatter.name],
      ["description", truncate(r.frontmatter.description.replace(/\s+/g, " "), 64)],
      ["version", r.frontmatter.version],
      ["tags", r.frontmatter.tags.length ? r.frontmatter.tags.join(", ") : kleur.dim("∅")],
    ];
    if (r.frontmatter.author) rows.push(["author", r.frontmatter.author]);
    if (r.frontmatter.homepage) rows.push(["homepage", r.frontmatter.homepage]);
    const keyWidth = Math.max(...rows.map((row) => row[0].length));
    for (const [k, v] of rows) {
      out.write(`  ${kleur.dim(k.padEnd(keyWidth))}  ${v}\n`);
    }
  } else {
    out.write(`  ${kleur.dim("(unparseable — see validation issues below)")}\n`);
  }

  heading("Body");
  // tabular-nums analogue: right-align the numbers in a fixed column so the
  // eye can compare them at a glance.
  const stats: Array<[string, number]> = [
    ["lines", r.body.lines],
    ["words", r.body.words],
    ["characters", r.body.characters],
    ["sections", r.body.sections.length],
  ];
  const valWidth = Math.max(...stats.map(([, n]) => String(n).length));
  for (const [label, n] of stats) {
    out.write(`  ${String(n).padStart(valWidth)}  ${kleur.dim(label)}\n`);
  }
  if (r.body.sections.length > 0) {
    out.write(`  ${kleur.dim("headings:")}\n`);
    for (const section of r.body.sections) {
      out.write(`    ${kleur.dim("·")} ${section}\n`);
    }
  }

  heading("Validation");
  if (r.validation.ok) {
    out.write(`  ${kleur.green("✓")} no issues\n`);
  } else {
    for (const issue of r.validation.issues) {
      out.write(`  ${kleur.red("·")} ${issue}\n`);
    }
  }

  heading("Lint");
  if (r.lint.issues.length === 0) {
    out.write(`  ${kleur.green("✓")} no issues\n`);
  } else {
    for (const issue of r.lint.issues) {
      const color = issue.severity === "error" ? kleur.red : kleur.yellow;
      const loc = issue.line ? `${r.path}:${issue.line}` : r.path;
      out.write(
        `  ${color("·")} ${color(issue.severity)} ${loc}: ${issue.rule}: ${issue.message}\n`,
      );
    }
  }

  if (r.attachedFiles) {
    heading("Attached files");
    if (r.attachedFiles.length === 0) {
      out.write(`  ${kleur.dim("(none)")}\n`);
    } else {
      for (const f of r.attachedFiles) {
        out.write(`  ${kleur.dim("·")} ${f}\n`);
      }
    }
  }

  heading("Summary");
  out.write(
    `  ${r.summary.ok ? kleur.green("✓") : kleur.red("✗")} validation: ${r.summary.validationIssues}  lint: ${r.summary.lintIssues}\n`,
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

cli
  .command("diff <a> <b>", "Structural diff of two SKILL.md files")
  .option("--json", "Emit the full diff result as JSON (machine-readable)")
  .action(async (a: string, b: string, opts) => {
    try {
      const result = await diffSkills(a, b);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exit(result.identical ? 0 : 1);
      }
      printDiffReport(result);
      process.exit(result.identical ? 0 : 1);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      // Exit 2 for validation/IO failure, distinct from the "files differ"
      // exit 1 — mirrors `mcp-devtools diff` convention so CI scripts can
      // tell "noisy" from "broken".
      process.exit(2);
    }
  });

/**
 * Human-readable `diff` report. A short summary header, then one section
 * per kind of change (frontmatter, headings, body). Prose-oriented:
 * paragraphs where the comparison is best read as a sentence, lists only
 * where the items are genuinely parallel. Additions in green, removals in
 * red, changes in yellow.
 */
function printDiffReport(r: DiffResult): void {
  const out = process.stdout;
  const heading = (label: string) => out.write(`\n${kleur.bold(kleur.dim(label.toUpperCase()))}\n`);

  if (r.identical) {
    out.write(
      `${kleur.green("✓")} ${r.pathA} ${kleur.dim("≡")} ${r.pathB} ${kleur.dim("— structurally identical")}\n`,
    );
    return;
  }

  // Summary line — counts at a glance, full breakdown follows.
  const fm = r.frontmatter;
  const fmCount = Object.keys(fm.added).length + Object.keys(fm.removed).length + fm.changed.length;
  const hd = r.bodyHeadings;
  const hdCount = hd.added.length + hd.removed.length + hd.reordered.length;
  out.write(
    `${kleur.bold("diff")} ${kleur.dim(r.pathA)} ${kleur.dim("→")} ${kleur.dim(r.pathB)}\n`,
  );
  out.write(
    `${kleur.dim("  frontmatter:")} ${fmCount}  ${kleur.dim("headings:")} ${hdCount}  ${kleur.dim("body lines:")} ${kleur.green(`+${r.bodyLinesDelta.added}`)} ${kleur.red(`-${r.bodyLinesDelta.removed}`)}\n`,
  );

  if (fmCount > 0) {
    heading("Frontmatter");
    for (const [k, v] of Object.entries(fm.added)) {
      out.write(`  ${kleur.green("+")} ${k}: ${formatValue(v)}\n`);
    }
    for (const [k, v] of Object.entries(fm.removed)) {
      out.write(`  ${kleur.red("-")} ${k}: ${formatValue(v)}\n`);
    }
    for (const c of fm.changed) {
      out.write(
        `  ${kleur.yellow("~")} ${c.key}: ${kleur.red(formatValue(c.before))} ${kleur.dim("→")} ${kleur.green(formatValue(c.after))}\n`,
      );
    }
  }

  if (hdCount > 0) {
    heading("Headings");
    for (const h of hd.added) {
      out.write(`  ${kleur.green("+")} ${h}\n`);
    }
    for (const h of hd.removed) {
      out.write(`  ${kleur.red("-")} ${h}\n`);
    }
    for (const m of hd.reordered) {
      out.write(
        `  ${kleur.yellow("~")} ${m.heading} ${kleur.dim(`(position ${m.from} → ${m.to})`)}\n`,
      );
    }
  }

  if (r.bodyLinesDelta.added > 0 || r.bodyLinesDelta.removed > 0) {
    heading("Body");
    out.write(
      `  ${kleur.green(`+${r.bodyLinesDelta.added}`)}  ${kleur.red(`-${r.bodyLinesDelta.removed}`)}  ${kleur.dim("lines (coarse)")}\n`,
    );
  }
}

/**
 * Render a frontmatter value as a short inline string. Arrays show as
 * `[a, b]`; objects as JSON; long strings get truncated with an ellipsis
 * so the diff stays scannable even with multi-line `description` fields.
 */
function formatValue(v: unknown): string {
  if (v === undefined) return kleur.dim("∅");
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => formatValue(x)).join(", ")}]`;
  if (typeof v === "string") {
    const single = v.replace(/\s+/g, " ");
    return single.length > 64 ? `${single.slice(0, 63)}…` : single;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

cli
  .command("tree <dir>", "Preview the file inventory that pack would produce")
  .option("--json", "Emit the full result as JSON (machine-readable)")
  .option("--sort <mode>", "Sort entries by `path` (default) or `size`")
  .action(async (dir: string, opts) => {
    try {
      const sort = opts.sort;
      if (sort !== undefined && sort !== "path" && sort !== "size") {
        throw new Error(`--sort must be one of path, size (got "${sort}")`);
      }
      const result = await treeSkill({ srcDir: dir, sort });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exit(0);
      }
      printTreeReport(result);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

/**
 * Human-readable `tree` report. Box-drawing characters render the
 * hierarchy; sizes are right-padded in a fixed column so the eye can
 * scan them as a tabular-nums column. Sentence-case heading on the
 * directory header, lowercase totals — quiet structural signal.
 *
 * The tree drawing uses a per-level "is-last-at-this-level" stack so
 * the connector characters render correctly even for deep nesting. We
 * derive the structure from the already-walked entries rather than
 * re-walking the filesystem: path-sort returns entries in tree order
 * already.
 */
function printTreeReport(r: TreeResult): void {
  const out = process.stdout;
  out.write(`${kleur.bold(r.srcDir)}\n`);

  // Group entries by parent path so we know which is last in each group —
  // that determines whether to draw `├──` or `└──`.
  const childrenByParent = new Map<string, string[]>();
  for (const e of r.entries) {
    const parent = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(e.path);
    childrenByParent.set(parent, arr);
  }
  const entryByPath = new Map(r.entries.map((e) => [e.path, e]));

  // Compute the max size-label width so right-aligned columns line up.
  const labels = r.entries.filter((e) => !e.isDir).map((e) => formatSize(e.size));
  const sizeWidth = labels.length === 0 ? 0 : Math.max(...labels.map((l) => l.length));

  // Walk recursively from the root using path-sort children.
  const drawn = new Set<string>();
  const drawNode = (path: string, prefix: string, isLast: boolean): void => {
    const connector = isLast ? "└── " : "├── ";
    const entry = entryByPath.get(path);
    if (!entry) return;
    const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const sizeLabel = entry.isDir
      ? " ".repeat(sizeWidth)
      : formatSize(entry.size).padStart(sizeWidth, " ");
    const display = entry.isDir ? kleur.cyan(`${name}/`) : name;
    out.write(`${prefix}${connector}${kleur.dim(sizeLabel)}  ${display}\n`);
    drawn.add(path);

    if (entry.isDir) {
      const kids = childrenByParent.get(path) ?? [];
      for (let i = 0; i < kids.length; i += 1) {
        const nextPrefix = prefix + (isLast ? "    " : "│   ");
        drawNode(kids[i], nextPrefix, i === kids.length - 1);
      }
    }
  };

  const roots = childrenByParent.get("") ?? [];
  for (let i = 0; i < roots.length; i += 1) {
    drawNode(roots[i], "", i === roots.length - 1);
  }

  // Tabular-style totals — files count + total size in human units. Dot
  // separator matches the rest of the CLI's "summary" lines.
  const totalLabel = `${r.totalFiles} file${r.totalFiles === 1 ? "" : "s"} · ${formatSize(
    r.totalBytes,
  )}`;
  out.write(`\n${kleur.dim(totalLabel)}\n`);
}

/**
 * Render a byte count as either bytes (< 1 KB) or KB with one decimal.
 * Returned without a leading space so callers can right-pad to a fixed
 * width for tabular-nums alignment.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

cli.help();
cli.version(VERSION);
cli.parse();
