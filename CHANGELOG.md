# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `skillforge update <path>`: bump the `version:` field of a SKILL.md in one shot — `--bump <patch|minor|major>` or `--new-version <semver>` (mutually exclusive, exactly one required). Pre-release tags (`-beta`, `-rc.1`, …) are dropped on any bump, matching `npm version`. A missing `version:` field is treated as the schema default of `0.0.1`. Validates the proposed frontmatter against the schema before touching disk and uses a line-surgical write so the body bytes and other YAML formatting are preserved byte-for-byte. `--dry-run` reports the new version without writing.
- `skillforge lint <path>`: warnings-first style/quality linter for `SKILL.md` files. A stricter peer of `validate` that surfaces nine smells `validate` deliberately ignores — short or noun-phrase `description`, descriptions missing trigger language, empty `tags`, stale `version: 0.0.1` files (older than 7 days), missing `## When to use` / `## Examples` headings, `TODO` markers (error), `you should` / `always` second-person phrasing, and trailing whitespace. Exit 0 if only warnings, 1 on errors, 2 with `--strict`. `--json` emits machine-readable issues. Each rule is a tiny pure function so adding rules is a one-liner.

## [0.0.2] — 2026-05-23

### Added
- `skillforge install <url>`: download a remote `.skill` archive and extract it into `~/.claude/skills/<skill-name>` (override with `--out <dir>`). Refuses plaintext `http://` (skills execute on your machine), refuses zip-slip entries, refuses symlinks in archives, caps downloads at 64 MB, and validates the bundle's SKILL.md before writing a single file to disk. `--force` clears the target before extracting (no stale leftovers); `--dry-run` reports what would happen without touching the filesystem. Closes the symmetric pair with `pack`.
- `skillforge pack <dir>`: bundle a skill directory into a `.skill` archive (zip) ready to drop into Claude / Cowork's "Save skill" install flow. Validates the SKILL.md before packing (skip with `--skip-validation`). Default output path is `<dirname>.skill` in the current working directory; override with `--out <file>`. Excludes `.git`, `node_modules`, hidden files, and `*.log` to keep bundles clean. Uses `jszip` (pure JS, no native deps).
- This CHANGELOG file.

[Unreleased]: https://github.com/adityachilka1/skillforge/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/adityachilka1/skillforge/compare/v0.0.1...v0.0.2
