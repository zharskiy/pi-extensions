# AGENTS.md

- [ARCHITECTURE.md](ARCHITECTURE.md): how it works.
- [STRUCTURE.md](STRUCTURE.md): where things are.

Checks:

- `npm run check`: typecheck, biome and unit tests. Run before finishing.
- `npm run test`: unit tests only.
- `npm run test:live`: real agents, local only, needs pi credentials and `PI_LIVE_MODEL`. Never run in CI.

Rules:

- Only `core/adapter` (and `core/test/adapter` tests) import pi packages; extensions never import each other.
- No provider knowledge: no provider or model names in code or prompts. Pi handles providers; cost comes from pi's own usage figures. Only the shipped agent files (`model: provider/id:thinking`) and the subagents README sentences that list them name models.
- Every file the extensions write lives under pi's agent dir or session dir (`~/.pi/agent` by default), never in the project; the only exception is git's branch and `.git/worktrees` metadata for `worktree: true` agents.
