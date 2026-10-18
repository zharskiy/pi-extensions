# Workbench <EPIC-KEY>: <epic title>

This folder is an Acme workbench for epic <EPIC-KEY> (<tracker link>). pi loads this file for every session and agent started here or below.

- Departments and repos: the folders `be/`, `fe/`, `qaa/` next to this file; each has its own AGENTS.md. Repos, tickets, branches and check commands are in `WORKBENCH.md`.
- Working documents are in `docs/`. They are drafts for the tracker and are never committed to a repo.
- The developer here is a researcher: the output is requirements, a contract, specs and agent briefs posted to the tracker. Code is written by CI agents from the briefs unless the user asks for local implementation.
- To continue work, run `/skill:epic <EPIC-KEY>` or `/skill:feature <FEATURE-KEY>`; both resume from the stage log in `WORKBENCH.md`.
- Agents get absolute repo paths in their briefs, for example `<workbench>/be/order-service`, and the path of that department's AGENTS.md under Where to look.
- When you write a session handoff, put the running workflow skill, its ticket key and its current stage first under Next.
