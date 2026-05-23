<div align="center">

# skillforge

**CLI for authoring Claude Skills.**
Scaffold, validate, and lint `SKILL.md` files for the agent ecosystem.

[![npm](https://img.shields.io/npm/v/@adityachilka/skillforge?style=flat-square&color=000)](https://www.npmjs.com/package/@adityachilka/skillforge)
[![ci](https://img.shields.io/github/actions/workflow/status/adityachilka1/skillforge/ci.yml?style=flat-square&color=000)](https://github.com/adityachilka1/skillforge/actions)
[![license](https://img.shields.io/npm/l/@adityachilka/skillforge?style=flat-square&color=000)](./LICENSE)

</div>

---

> **Status — v0.0.2, early days.** `init`, `validate`, `lint`, `pack`, `install`, and `update` work today. Registry, publish, and eval flows land in v0.1.

## Install

```bash
npm install -g @adityachilka/skillforge
# or
pnpm add -g @adityachilka/skillforge
```

## Use

### `skillforge init <name>`

Scaffold a new skill directory containing a `SKILL.md` with sensible-default frontmatter:

```bash
skillforge init code-review
# ✓ scaffolded /path/to/code-review/SKILL.md
```

The generated file is a real template — proper frontmatter, sectioned body (What / When / Instructions / Examples), `TODO` markers wherever you need to write.

Pass `--out <dir>` to choose the parent directory. Pass `--force` to overwrite an existing `SKILL.md`.

### `skillforge validate <path>`

Validates a `SKILL.md` against the frontmatter schema and reports any issues:

```bash
skillforge validate ./code-review/SKILL.md
# ✓ ./code-review/SKILL.md — frontmatter valid, 42 body lines
```

Exits `0` on full validity, `1` on any issue. Drop into CI:

```yaml
- run: npx @adityachilka/skillforge validate ./skills/*.md
```

### `skillforge lint <path>`

A stricter peer of `validate`. Where `validate` checks the schema (hard pass/fail), `lint` surfaces style and quality smells — short or noun-phrase descriptions, missing trigger language, empty tags, stale `0.0.1` versions, missing `## When to use` / `## Examples` headings, residual `TODO`s, second-person prose, trailing whitespace:

```bash
skillforge lint ./code-review/SKILL.md
# warnings (2)
#   · ./code-review/SKILL.md: description-no-trigger: description should include triggering language…
#   · ./code-review/SKILL.md: tags-empty: tags array is empty — add a few for discoverability
```

Exits `0` on warnings-only (advisory), `1` on any error (e.g. residual `TODO`), `2` with `--strict` if there's any issue at all. Pass `--json` for machine-readable output:

```bash
skillforge lint ./code-review/SKILL.md --strict --json
```

### `skillforge pack <dir>`

Bundle a skill directory into a `.skill` archive (a plain zip), ready to drop into Claude / Cowork's "Save skill" install flow:

```bash
skillforge pack ./code-review
# ✓ packed 4 files → code-review.skill (3.2 KB)
```

Validates the `SKILL.md` before packing (skip with `--skip-validation`). Default output is `<dirname>.skill` in the current working directory — override with `--out <file>`. Excludes `.git`, `node_modules`, hidden files, and `*.log` to keep bundles clean. Pure-JS zipping via `jszip` — no native deps.

### `skillforge install <url>`

Download a remote `.skill` archive and extract it into `~/.claude/skills/<skill-name>` (override with `--out <dir>`):

```bash
skillforge install https://example.com/code-review.skill
# ✓ code-review → ~/.claude/skills/code-review (4 files, 3.2 KB)
```

Refuses plaintext `http://` (skills execute on your machine), refuses zip-slip entries, refuses symlinks in archives, caps downloads at 64 MB, and validates the bundle's `SKILL.md` before writing a single file to disk. Pass `--force` to clear an existing install directory before extracting; pass `--dry-run` to validate and report what would happen without touching the filesystem.

### `skillforge update <path>`

Bump the `version:` field of a SKILL.md without hand-editing the frontmatter. Accepts either a file path or a directory containing a `SKILL.md`:

```bash
skillforge update ./code-review --bump patch
# ✓ ./code-review/SKILL.md: 0.1.0 → 0.1.1

skillforge update ./code-review/SKILL.md --new-version 1.0.0
# ✓ ./code-review/SKILL.md: 0.1.1 → 1.0.0
```

Pass exactly one of `--bump <patch|minor|major>` or `--new-version <semver>`. Pre-release tags (`-beta`, `-rc.1`, …) are dropped on any bump, matching `npm version`. A missing `version:` field is treated as `0.0.1` (the schema default) so a `patch` on a freshly-scaffolded skill produces `0.0.2`. The proposed frontmatter is validated against the schema before anything hits disk, and the write is line-surgical — body bytes, field order, and other YAML formatting are preserved byte-for-byte. Pass `--dry-run` to print the would-be new version without writing.

## Schema

```yaml
---
name: code-review              # required, 1-80 chars
description: |                 # required, 20-500 chars
  Use this when the user asks for a code review on a diff or pull request.
  Avoid auto-merging anything; comment with specific line references.
version: 0.0.1                 # optional, semver, defaults to 0.0.1
tags: [code, review]           # optional
author: "@adityachilka1"       # optional
homepage: https://…            # optional, must be URL
---

# code-review body…
```

Unknown frontmatter fields are preserved (forward-compatible with whatever Anthropic ships next).

## Roadmap

- **v0.0.1** — `init`, `validate` ✓
- **v0.0.2** — `pack`, `install` ✓ (this release)
- **v0.1** — `publish` to the skillforge.dev registry, eval suite, `install` from registry
- **v0.2** — MCP-compatible installer so any MCP client can install skills from the registry

## Companion projects

- [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools) — Chrome DevTools for the Model Context Protocol.
- [`agentbench`](https://github.com/adityachilka1/agentbench) — snapshot tests for AI agent traces.

## License

[MIT](./LICENSE) © 2026 Aditya Chilka.
