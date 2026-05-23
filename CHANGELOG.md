# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `skillforge pack <dir>`: bundle a skill directory into a `.skill` archive (zip) ready to drop into Claude / Cowork's "Save skill" install flow. Validates the SKILL.md before packing (skip with `--skip-validation`). Default output path is `<dirname>.skill` in the current working directory; override with `--out <file>`. Excludes `.git`, `node_modules`, hidden files, and `*.log` to keep bundles clean. Uses `jszip` (pure JS, no native deps).
- This CHANGELOG file.

[Unreleased]: https://github.com/adityachilka1
