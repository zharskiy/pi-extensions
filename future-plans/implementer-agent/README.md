# Implementer agent

Status: planned. Concerns how this repository is developed with Claude Code, not a pi feature.

## Problem

Implementation on this repository is delegated to ad hoc sonnet agents spawned from the orchestrating session. Each brief restates the same things: the personal code style, the commit format, the worktree setup, which git binary to call, which checks to run before reporting, and the shape of the report. The restatement is lossy. The style rules in particular arrive as a one-line summary ("no for-loops, blank lines around if-blocks") instead of the full skill with its example and its pre-finish checklist, and an ad hoc agent has no reason to invoke `personal-code-style` on its own.

## Design

A named agent definition at `~/.claude/agents/implementer.md`. User level, not project level: `.claude/` is gitignored here, and the skills the agent depends on live in `~/.claude/skills/`, so the agent is only meaningful on a machine that has them.

```yaml
---
name: implementer
description: Applies a described code change in its own worktree, runs the project checks, commits.
model: sonnet
skills:
  - personal-code-style
---
```

`skills` preloads the full SKILL.md of the listed skill into the agent's context at startup (https://code.claude.com/docs/en/sub-agents, preloading section). That gives the effect of embedding the style rules in the agent body without a second copy that drifts. The skill stays the single source of truth; editing it updates the main session, the implementer and any later agent at once.

### What the body holds

Only what the skills do not:

- Work only inside the worktree path given. Reset it to the branch named in the brief before starting; link the main checkout's `node_modules` when the project needs it.
- Call `/usr/bin/git`, not `git` (the rtk hook rewrites bare `git`).
- Read the project's `AGENTS.md` and follow it; the repository rules (import boundaries, docs-sync test, no provider names) live there and are not repeated in the agent.
- Run the project's check command before reporting. A step is not done while it fails.
- Do what the brief says and nothing beside it. Unrelated problems are reported, not touched.
- Do not weaken a test to make it pass; say the code or the brief is wrong instead.
- Commit in coherent pieces, with the message format and trailers the brief gives.
- Report: what changed (files and commits), the check command's result verbatim, what was left undone and why.

### What the brief holds

Only the task: the goal, the branch to reset to, the findings or plan to apply, the commit trailers for the session, and anything the orchestrator already ruled out.

### Reviewer counterpart

The same mechanism serves the opus reviewer. A `reviewer` agent with `skills: [personal-code-style]` can check style compliance alongside the owner's review criteria (architecture, simplicity, what can be removed or shortened, tests covering behaviour rather than implementation, performance). Read-only tools. Not required for the implementer to be useful; listed so the two are designed together.

## Steps

1. Write `~/.claude/agents/implementer.md` as above.
2. Use it for the next implementation task on this repository with a brief reduced to the task alone; compare the result and the brief length with the ad hoc runs on `feat/ux-research-batch`.
3. If it holds up, add the reviewer agent the same way.

## Out of scope

Shipping the agent or the skills with this repository. The `mz-product-development` plugin's `doer` agent, which conflicts with the style skill (it asks to match the surrounding code's comment density); that plugin is disabled for this project in `.claude/settings.local.json`.
