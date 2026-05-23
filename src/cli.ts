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
 */
import { cac } from "cac";
import kleur from "kleur";
import { formatSkill } from "./format.js";
import { initSkill } from "./init.js";
import { installSkill } from "./install.js";
import { computeExitCode, lintSkill } from "./lint.js";
import { packSkill } from "./pack.js";
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

cli.help();
cli.version(VERSION);
cli.parse();
