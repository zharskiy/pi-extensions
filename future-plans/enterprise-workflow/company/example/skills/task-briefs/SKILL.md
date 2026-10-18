---
name: task-briefs
description: Split an approved spec into tracer-bullet tasks and write one agent brief per task, ready for CI agents. Use in a feature workflow's briefs stage.
---

# Task briefs

Adapted from Matt Pocock's `to-tickets` and `AGENT-BRIEF`.

## Split

- Each task is a tracer bullet: a narrow but complete path through every layer it needs in one repo, verifiable on its own, small enough for one fresh agent context.
- Prefactoring (renames, extractions that make the change easy) is its own task and comes first.
- One repo per task. Edges are `blocked by`; work that can run in parallel has no edge.
- Present the split as a numbered list (title, repo, blocked by) and quiz the user: too coarse, too fine, wrong edges, merge or split. Wait for approval before writing briefs.

## Brief

Use `templates/brief.md` in this package (two folders up from this file). The brief is the whole contract for an agent that sees only the repo and the ticket.

- Durable, not precise: name behaviours, modules and interfaces, not file paths or line numbers.
- Behavioural, not procedural: what must be true, not the steps.
- Acceptance criteria each independently checkable, carried over from the spec's `WHEN … SHALL` lines that this task covers.
- Out of scope always filled.
- `Branch` from the department's scheme in `departments.json`, with the task key.
- Done when every spec acceptance criterion is covered by exactly one brief, or listed as not covered with the reason.
