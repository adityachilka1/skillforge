# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.2] — 2026-05-23

### Added
- `skillforge install <url>`: download a remote `.skill` archive and extract it into `~/.claude/skills/<skill-name>` (override with `--out <dir>`). Refuses plaintext `http://` (skills execute on your machine), refuses zip-slip entries, refuses symlinks in archives, caps downloads at 64 MB, and validates the bundle's SKILL.md before writing a single file to disk. `--force` clears the target before extracting (no stale leftovers); `--dry-run` reports what would happen without touching the filesystem. Closes the symmetric pair with `pack`.
- `skillforge pack <dir>`: bundle a skill directory into a `.skill` archive (zip) ready to drop into Claude / Cowork's "Save skill" install flow. Validates the SKILL.md before packing (skip with `--skip-validation`). Default output path is `<dirname>.skill` in the current working directory; override with `--out <file>`. Excludes `.git`, `node_modules`, hidden files, and `*.log` to keep bundles clean. Uses `jszip` (pure JS, no native deps).
- This CHANGELOG file.

[Unreleased]: https://github.com/adityachilka1/skillforge/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/adityachilka1/skillforge/compare/v0.0.1...v0.0.2
