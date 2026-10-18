# cwd on run_agent

> Status: planned, not implemented. Date: 2026-10-18. Replaces the old spec 04: the workspace extension, `pi-workspace.json`, masters, worktrees per repo and the `/epic` commands are dropped; only `cwd` per agent survives.

## Goal

A `run_agent` item can name the directory its agent runs in, so one agent can work in one repository below the session's directory and pick up that repository's `AGENTS.md`. Nothing else about workspaces is built in the harness; a company arranges its folders and workflows on its own side (../enterprise-workflow/company/company-side.md).

## Rules

- New optional item field `cwd`: a path relative to the caller's working directory, or an absolute path. After resolving symlinks it must exist, be a directory, and be the session cwd or inside it. Otherwise the whole batch is refused and nothing starts.
- Trust is checked per target. A target with no trust-requiring `.pi` resources of its own, or one that pi's trust store trusts, runs trusted; otherwise the agent still runs and still gets context files, but none of the target's `.pi` settings, extensions or `mcp.json`. An untrusted session gives untrusted agents. The result can carry a one-line note when the target was not trusted.
- Nested agents without `cwd` run in their caller's cwd, not the session cwd. A handoff successor keeps its predecessor's cwd.
- `worktree: true` with `cwd` builds the worktree from the repository at the target, under `<target>/.pi/worktrees/`. The file rule in AGENTS.md then reads "the agent's cwd".
- The target's `.pi/agents` and `.pi/pi-subagents.json` are not read. Agent definitions and settings belong to the session; one registry and one settings set per session.
- The target's own skills do not reach the agent unless the main session already loaded them.
- The run_agent start block and the `/agents` view show the cwd when it differs from the session cwd.
- Main-session prompt: one line in the Brief section saying to set `cwd` when the work belongs to one directory below the caller's, such as one repository.

## Details

Contract, error texts, where it plugs in, alternatives considered, tests and size are in ../enterprise-workflow/harness/harness-side.md, section 2.2 and item 3 of section 1. Background on worktrees and cross-repo work is in research/workspace-and-epic.md and research/q2-q3-workspace.md; both describe the dropped workspace design and are kept as evidence only.

## Acceptance checks

- [ ] An agent with `cwd` reports a word that only the target's `AGENTS.md` holds (live test).
- [ ] A `cwd` outside the session directory, through a symlink or missing, refuses the batch with nothing started.
- [ ] A target with its own `.pi/extensions` and no trust entry runs untrusted.
- [ ] `npm run check` green; README, ARCHITECTURE, STRUCTURE and the AGENTS.md file rule updated.
