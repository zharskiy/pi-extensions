# 02 Plan mode

> Status: dropped. Date: 2026-10-18. The owner dropped a harness-enforced plan mode; planning is a company skill (see q4-q8-plan-mode-guards.md). Kept because the owner may reconsider.

## Goal

A harness-enforced read-only state for the main session. While it is on, nothing in the project can be edited, shell is limited to an allowlist, and delegation is limited to read-only agents. It is entered by the user or by the main model, and left only when the user approves the plan file. No other modes are planned.

## Why

- Across Claude Code, Gemini CLI, Factory and Copilot "plan mode is a permission state, not just a prompt: edits are blocked by the harness, exploration commands are allowed, the plan is a markdown file, approval is a discrete event" (frontier-workflows.md §2).
- No product uses a classifier to decide whether to plan; entry is "the user, the main model, or a keyword hint". The recommendation is A3: user toggle plus a model tool, user exit (modes-and-compaction.md §1, "Design options (a)").
- Keeping the tool set and system prompt constant and blocking calls in `tool_call` avoids a cache break; a changed tool list or model costs a cold turn, 12–25× a warm one (modes-and-compaction.md §1, §2).
- Pi offers `tool_call` (`{ block, reason }`) and the repo adapter does not use it yet (pi-capabilities.md §1).

## Design

| Aspect | Rule |
|---|---|
| Enter | `/plan`, or the main model calls `enter_plan_mode { reason }`, or a workflow stage with `mode: plan` (01-workflows.md). |
| While on | A hidden message states the mode and the plan file path. Footer status `plan mode · /plan approve`. |
| Edits | `edit`, `write` and any tool whose input names a path are blocked unless the absolute path (after pi's resolve-to-cwd) starts with `<session folder>/workflow/` or, in an epic, `workbench/<epic>/` outside the repo worktrees. |
| Shell | `bash` runs only commands matching `allowCommands` (default: `git status|log|diff|show|branch`, `ls`, `cat`, `head`, `tail`, `wc`, `find`, `grep`, `rg`) and, in a workspace, the `check` commands of `pi-workspace.json`. Everything else is blocked. |
| Delegation | `run_agent` accepts only agents whose record is read-only: `tools` a subset of `read, grep, find, ls, fetch` and `mcp: false`. The list is computed, not configured; `planner` qualifies because a plan-mode stage spawns it with `mcp: false`. `reviewer` (bash) and `implementer` are refused with the reason. |
| Child sessions | The same guard runs in each spawned agent's hidden extension while the main session is in plan mode, so a read-only agent with an unexpected tool still cannot write. |
| Refusal | One line to the model: `plan mode: <tool> <path or command> is not allowed; write the plan to <plan file> and ask the user to approve it.` |
| Plan file | `<session folder>/workflow/plan.md` by default; a workflow stage names its own artefact instead. |
| Leave | The model calls `exit_plan_mode { file }`; the harness shows the path and a choice: approve, keep planning, abandon. `/plan approve` does the same from the user's side; `/plan off` asks the same three-way confirmation before abandoning. Only approve or abandon leaves. |
| After approval | The mode ends, a hidden message names the approved file; a workflow stage's `user` gate is satisfied. |
| Persistence | A `pi-subagents:plan-mode` custom entry records enter, approve and abandon, so a resumed or handed-off session restores the state. |

The main session's model and tool list never change with the mode (the two mode tools are always registered), so the prompt cache survives a toggle. Blocking in `tool_call` is preferred over removing tools from the loadout for that reason.

Optional future, out of scope now: a first-message classifier through pi's `ctx.modelRegistry.classify()` that suggests a workflow or plan mode once, before any cache exists, behind a setting `firstMessageClassifier: true` (modes-and-compaction.md "Design options (a)"). `quick` never enters plan mode.

## User surface

- Commands: `/plan` (enter; while on, shows the plan file path), `/plan approve`, `/plan off` (abandon after confirmation).
- Tools (model-only): `enter_plan_mode { reason }`, `exit_plan_mode { file }`.
- Footer status `plan mode · /plan approve`.
- Settings (`pi-subagents.json`):

```json
{
  "planMode": {
    "allowCommands": ["^git (status|log|diff|show|branch)", "^(ls|cat|head|tail|wc|find|grep|rg) "]
  }
}
```

`allowCommands` are regular expressions tested against the whole command and replace the default list.

## Architecture

- `core/adapter/contract.ts`: `Host.onToolCall(handler)` over pi's `tool_call`; the handler returns `{ block: true, reason }` or nothing. `SpawnSpec.guards` carries the plan-mode guard to children (shared with 06-project-rules.md).
- Subagents, new plugin `plan-mode` [run-agent, workflow]: `index.ts` (commands, tools, state entry, footer status), `policy.ts` (pure: allowed paths, commands, read-only agent test), `approve.ts` (the three-way choice through `HostUi.showForm` with `selectForm`; outside tui, `/plan approve` only).
- `run-agent/runner.ts`: `startBatch` asks the `planMode` service whether the agent record is read-only and throws with the reason; passes the guard in `SpawnSpec.guards`.
- Main prompt: one paragraph on when to call `enter_plan_mode` (multi-step, design choice, several modules, or a workflow stage that says so) and that approval is the user's.
- Rules: only the adapter touches pi; no model names; the only files written are under the session folder (already covered by the file-location rule).

## Out of scope

Classifier entry, auto-approval modes, other modes, editing the plan in an external editor, a plan subagent of its own, removing tools from the loadout.

## Open questions for the owner

None; defaults taken: `reviewer` stays excluded, `/plan off` confirms, `finish_stage` tracks progress after approval.

## Acceptance checks

- [ ] With plan mode on, `write` to a project path returns the refusal line and the file is unchanged; `write` to `<session folder>/workflow/plan.md` (absolute) succeeds.
- [ ] `bash` with `git diff` runs; `bash` with `npm install` returns the refusal.
- [ ] `run_agent` with `implementer` or `reviewer` throws `plan mode: …`; with `scout`, and with `planner` at `mcp: false`, it starts; a `planner` with `mcp: true` is refused.
- [ ] A scout spawned in plan mode gets the guard in its own session.
- [ ] `exit_plan_mode` shows the choice; `keep planning` leaves the mode on; `approve` ends it and names the file; `/plan off` asks first.
- [ ] A session resumed while the entry says `enter` restores the mode.
- [ ] The main session's model and tool list are unchanged across enter and exit (checked in the request payload).
