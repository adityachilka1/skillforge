/**
 * `skillforge` CLI entry point.
 *
 * Commands:
 *   init <name>     scaffold a new SKILL.md
 *   validate <path> validate a SKILL.md file's frontmatter and body
 *   pack <dir>      bundle a skill directory into a .skill archive
 *   install <url>   download a remote .skill into ~/.claude/skills/
 */
import { cac } from "cac";
import kleur from "kleur";
import { initSkill } from "./init.js";
import { installSkill } from "./install.js";
import { packSkill } from "./pack.js";
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

cli.help();
cli.version(VERSION);
cli.parse();
