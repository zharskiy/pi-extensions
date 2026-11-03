# AGENTS.md

- [ARCHITECTURE.md](ARCHITECTURE.md): how it works.
- [STRUCTURE.md](STRUCTURE.md): where things are.

Checks:

- `npm run check`: typecheck, biome, knip and unit tests. Run before finishing.
- `npm run test`: unit tests only.
- `npm run test:live`: real agents, local only, needs pi credentials and `PI_LIVE_MODEL`. Never run in CI.
- `npm run evals`: prompt-quality evals in `test/evals/`, real agents, local only, needs pi credentials and `PI_LIVE_MODEL`; `PI_EVAL_RUNS` repeats each case. Never run in CI.

Rules:

- Only `platform/pi-adapter/` (including its tests in `platform/pi-adapter/tests/`) and the test helpers in `test/framework/pi/` import pi packages; everything else imports the adapter through `platform/pi-adapter/index.ts`; shipped code never imports `test/framework/`.
- Extensions import each other only through `index.ts`.
- No provider knowledge: no provider or model names in code or prompts. Pi handles providers; cost comes from pi's own usage figures. Only the shipped agent files (`model: provider/id:thinking`) name models.
- Every file the extensions write lives under pi's agent dir or session dir (`~/.pi/agent` by default; among them retention's liveness markers `<agentDir>/pi-retention/live/<session id>.<pid>.json`), except handoff documents (OS temp dir, `pi-handoff/<session id>/main-handoff.md` for the main session and `pi-handoff/<session id>/<agent id>-handoff.md` for agents), `worktree: true` agents (checkout under `<cwd>/.pi/worktrees/`, git's branch and `.git/worktrees` metadata), `<cwd>/.pi/.gitignore` (`*`, written only when one of these writers creates `.pi/`; write under `<cwd>/.pi/` only through `writeSettingsFile` or `ensureProjectSubdir` from `platform/shared`, never a hand-built `.pi` path), and two project files written on the user's command in a trusted project: `.pi/pi-subagents.json` (`/agents setup`, whose write may follow a model tool call once the user confirms the form) and `.pi/mcp.json` (`/mcp-import … project apply`, or the interactive `/mcp-import` picker). `/agents create` writes nothing: it briefs the main session, whose write tool creates `.pi/agents/<name>.md` or the user agent file. Only retention deletes, and only under `<agentDir>/sessions/` plus the orphans named here: session files untouched for `retentionDays` (nothing at all while `pi-retention.json` has an error) and, after the file is gone, their agent runs and handoff folders; orphan runs in folders without their session file and in `<agentDir>/pi-subagents/<id>/`; handoff folders older than the cutoff. Never live, fresh or parent sessions, worktree runs, worktrees, branches or anything behind a symbolic link. A session file with no readable header is never touched and neither are its agent runs; its handoff folder and `pi-subagents/<id>/` folder are judged by their own age because the id is unknown. Sessions outside `<agentDir>/sessions/` are not swept, and a handoff folder whose session lives elsewhere is judged by age.
- A change under `extensions/<name>/` comes with changes to that extension's `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` and to the root `ARCHITECTURE.md` and `STRUCTURE.md`, enforced by `test/docs-sync.test.ts`; what to write there is the author's call.
