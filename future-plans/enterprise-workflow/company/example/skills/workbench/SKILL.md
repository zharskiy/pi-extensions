---
name: workbench
description: Create, extend, open or list Acme workbenches (one folder per epic with clones of the repos it touches).
disable-model-invocation: true
---

# Workbench

A workbench is `~/work/<EPIC-KEY>/` (root from `departments.json`). It holds one clone per repo the epic touches, grouped by department, plus the working documents. Several workbenches can clone the same repo; each clone is independent. No worktrees.

```
~/work/SHOP-812/
  AGENTS.md          from templates/workbench-AGENTS.md: which epic, which departments, how to resume
  WORKBENCH.md       from templates/WORKBENCH.md: repos, tickets, branches, stage log
  docs/              working copies of requirements, contract, specs and briefs (never committed)
  be/AGENTS.md       copied from departments/be/AGENTS.md
  be/order-service/  clone
  fe/AGENTS.md
  fe/web-orders/
  qaa/AGENTS.md
  qaa/e2e-tests/
```

## Commands

The argument after `/skill:workbench` is one of these. Paths below are relative to this skill's package root (two levels up from this file).

- `new <EPIC-KEY>`: read the epic over the tracker MCP (title, child tickets, departments named on it; see the `tracker` skill). Propose the repos from `departments.json` that fit, numbered, with your recommendation, and wait for the user. Then run `scripts/workbench.sh new <EPIC-KEY> <dept>/<repo> ...`. Fill the placeholders in the new `AGENTS.md` and `WORKBENCH.md` (epic key, title, tracker link). Done when the script exits 0 and both files have no `<...>` left. Tell the user to start pi in the workbench folder.
- `add <dept>/<repo>`: run `scripts/workbench.sh add <dept>/<repo>` from the workbench root and add the repo to `WORKBENCH.md`.
- `branch <dept> <TICKET> <slug>`: run `scripts/workbench.sh branch <dept> <TICKET> <slug>`; it names the branch with the department's scheme in every repo of that department and records it. Only for local implementation; CI makes its own branches from the brief.
- `list`: list `~/work/*/WORKBENCH.md` with each epic key, title and current stage.

A feature without an epic gets a workbench keyed by its own ticket key.
