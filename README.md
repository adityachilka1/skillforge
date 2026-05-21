<div align="center">

# skillforge

**CLI for authoring Claude Skills.**
Scaffold, validate, and lint `SKILL.md` files for the agent ecosystem.

[![npm](https://img.shields.io/npm/v/@adityachilka/skillforge?style=flat-square&color=000)](https://www.npmjs.com/package/@adityachilka/skillforge)
[![ci](https://img.shields.io/github/actions/workflow/status/adityachilka1/skillforge/ci.yml?style=flat-square&color=000)](https://github.com/adityachilka1/skillforge/actions)
[![license](https://img.shields.io/npm/l/@adityachilka/skillforge?style=flat-square&color=000)](./LICENSE)

</div>

---

> **Status — v0.0.1, early days.** `init` and `validate` work today. Registry, publish, and eval flows land in v0.1.

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

- **v0.0.1** — `init`, `validate` ✓ (this release)
- **v0.1** — `publish` to the skillforge.dev registry, eval suite, `install` from registry
- **v0.2** — MCP-compatible installer so any MCP client can install skills from the registry

## Companion projects

- [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools) — Chrome DevTools for the Model Context Protocol.
- [`agentbench`](https://github.com/adityachilka1/agentbench) — snapshot tests for AI agent traces.

## License

[MIT](./LICENSE) © 2026 Aditya Chilka.
