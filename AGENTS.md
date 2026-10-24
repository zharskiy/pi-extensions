# AGENTS.md

- [ARCHITECTURE.md](ARCHITECTURE.md): how it works.
- [STRUCTURE.md](STRUCTURE.md): where things are.

Checks:

- `npm run check`: typecheck, biome and unit tests. Run before finishing.
- `npm run test`: unit tests only.
- `npm run test:live`: real agents, local only, needs pi credentials and `PI_LIVE_MODEL`. Never run in CI.

Rules:

- Only `pi-adapter` (and `core/test/adapter` tests) import pi packages; everything else imports it through `pi-adapter/index.ts`; extensions never import each other.
- No provider knowledge: no provider or model names in code or prompts. Pi handles providers; cost comes from pi's own usage figures. Only the shipped agent files (`model: provider/id:thinking`) and the subagents README sentences that list them name models.
- Every file the extensions write lives under pi's agent dir or session dir (`~/.pi/agent` by default), except handoff documents (OS temp dir, `pi-session-limits/` and `pi-subagents/`), `worktree: true` agents (checkout under `<cwd>/.pi/worktrees/`, git's branch and `.git/worktrees` metadata), and two project files written on the user's command in a trusted project: `.pi/pi-subagents.json` (`/agents setup`) and `.pi/mcp.json` (`/mcp-import … project apply`, or the interactive `/mcp-import` picker). `/agents create` writes nothing: it briefs the main session, whose write tool creates `.pi/agents/<name>.md` or the user agent file.
