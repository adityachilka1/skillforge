<div align="center">

# skillforge

**CLI + open registry for Claude Skills.**
Author, version, test, and publish skills your agents can install.

[![status](https://img.shields.io/badge/status-pre--release-yellow?style=flat-square)](https://github.com/adityachilka1/skillforge)
[![license](https://img.shields.io/badge/license-MIT-000?style=flat-square)](./LICENSE)

</div>

> **Status — pre-alpha.** No working code yet. Star to follow the v0.1 milestone (target: Q3 2026). Pre-release issues + ideas welcome in Discussions.

---

## Why

Claude Skills — `SKILL.md` files that teach an agent *how* to do something — are spreading fast. As of mid-2026, several of the top-20 fastest-growing repos on GitHub have "skills" in the name, and `mattpocock/skills` cleared +1,618 stars in a single week.

The ecosystem is missing the package layer:

- **No registry.** Skills live in random repos, gists, and Notion pages.
- **No versioning.** You can't depend on `code-review@^2`.
- **No evals.** No way to know whether a skill you copied still works against today's models.
- **No installer.** Every agent runtime ships its own way to wire a skill in.

`skillforge` is that layer.

## What it gives you

```bash
skillforge init code-review        # scaffolds a skill with eval suite + README
skillforge test                    # runs evals against your preferred model
skillforge publish                 # pushes to skillforge.dev registry
skillforge install code-review     # in any Claude / MCP-compatible agent
```

Plus a hosted public registry at **skillforge.dev** (think npm for skills) where every published skill comes with: changelog, eval pass-rate badge, popularity stats, and an open-source backing repo.

## Roadmap

- [ ] Skill scaffolder (`init`)
- [ ] Eval harness with model-agnostic scoring
- [ ] Local registry + manifest format (`skill.yaml`)
- [ ] Public registry on `skillforge.dev`
- [ ] MCP server so any MCP client can `install` from the registry
- [ ] VS Code extension

## Companion projects

- [`mcp-devtools`](https://github.com/adityachilka1/mcp-devtools) — Chrome DevTools for the Model Context Protocol.
- [`agentbench`](https://github.com/adityachilka1/agentbench) — snapshot tests for AI agent traces.

## License

[MIT](./LICENSE) © 2026 Aditya Chilka.
