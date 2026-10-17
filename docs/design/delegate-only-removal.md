# Removing the delegate-only default

Status: proposal, 2026-10-17. Part of [orchestrator-model.md](orchestrator-model.md) (work packages A and B). Branch `feat/agent-workflow-revamp`, pi 1.3.0. `S/` means `extensions/subagents/`. Repo references are `file:line` on this branch.

The main session stops being a delegate-only coordinator. It runs in `normal` mode on a capable model with its full tool set. The tool-restriction mechanism stays, because `plan` mode needs it, and gains a restore operation.

Labels: **REMOVE** goes away. **KEEP** stays as is. **KEEP-FOR-PLAN** stays because plan mode reuses it, possibly changed.

## Code

| Where | What | Label |
| --- | --- | --- |
| `S/src/model/settings.ts:23-24, 47-48, 71-72` | `delegateOnly` (default `true`) and `delegateOnlyTools` (default `["read", "write", "questionnaire"]`): type, default, schema | REMOVE |
| `S/src/plugins/run-agent/index.ts:166-174` | `if (settings.delegateOnly) host.restrictTools([...agentTools, ...delegateOnlyTools])` in `onSessionStart` | REMOVE. Lines 160-164 (`setMainPrompt`) KEEP |
| `core/adapter/contract.ts:271` | `Host.restrictTools(keep)` | KEEP-FOR-PLAN. Only removes, never re-adds; plan mode needs `setTools(keep)` plus `restore()` |
| `core/adapter/pi-adapter.ts:93-160` | `createToolRestriction`: kept and removed sets, `restricted-tools` entry, read back on resume (101-122) | KEEP-FOR-PLAN. Extend with `restore()` that re-activates the removed names and appends an entry with an empty `removed` list |
| `core/adapter/pi-adapter.ts:162-169` | `parentTools` (active plus removed) for `tools: all` agents | KEEP-FOR-PLAN. In plan mode it would hand `general` the full set; the plan-mode `run_agent` guard refuses `tools: all` agents and any agent with `edit` or `write` anyway |
| `core/adapter/pi-adapter.ts:271, 305, 321, 472-474, 571-572, 584` | reset on session start and shutdown, reapply on `before_agent_start`, host wiring, `${namespace}:restricted-tools` | KEEP-FOR-PLAN |
| `core/adapter/pi-child.ts:369` | `skillNames` (skills validation) | KEEP; becomes caller-aware in WP-C, not part of this removal |
| `core/test/helpers/fakes.ts:56-57, 198-199, 409-414` | fake `restrictTools` | KEEP-FOR-PLAN; add fake `restore` |
| `core/test/helpers/fakes.ts:792, 812-813` | fake skills, `skillNames` | KEEP |

Migration: none. The settings reader ignores keys that are not in the schema (`core/manager/settings.ts:72-74` iterates the schema, not the file), so a file that still has `delegateOnly` or `delegateOnlyTools` loads without error and the keys do nothing. The keys existed on this branch only.

## Prompt: `S/prompts/main-session.md` becomes a normal-mode prompt

| Line | Text today | Label |
| --- | --- | --- |
| 1 | "You are the coordinator ... You do not search, edit or run anything yourself. Besides the agent tools you have `read` ..., `write` (handoff files only) ..." | REMOVE; replaced by the new opening below |
| 3 | "take the first row that fits" | REMOVE; heading becomes "Which agent" and the rows a guide |
| 5-12 | role to agent rows (planner, scout, implementer then reviewer, reviewer, fetch, shell, image, general) | KEEP as guidance, not first-match |
| 14 | "A request that mixes several rows becomes separate agents in row order" | REMOVE |
| 16, first sentence | ask only when the request reads two ways | REWRITE into the new "understand the request" line |
| 16, second sentence | parallel only when independent; never two editing agents on the same files | KEEP |
| 18-27 | brief template, `description`, skills guidance | KEEP |
| 29-31 | end the turn, woken once, relay, `message_agent` for corrections | KEEP |
| 31 | "Do not poll or redo the work." | REMOVE |
| 33-41 | result contract, handoff results, planner batches | KEEP |
| 43-45 | session handoffs | KEEP |

New opening, in the file's style (sketch, wording to settle in WP-B):

> You are the main session of pi, a coding agent harness. You talk to the user, decide what should happen, and delegate the work to background agents with `run_agent`. First understand the request; ask one short question when it can be read two ways. You may read one short file or run one orienting command yourself when a brief needs it; anything more (searching, editing, running checks) goes to an agent. Judge every result against its Goal before you report it. For multi-step or ambiguous work, suggest `/plan` to the user.

Other prompt text:
- `S/prompts/base-system-prompt.md` and `S/prompts/main-session-agent-status.md`: KEEP.
- `S/src/plugins/run-agent/tools.ts:108-132` (`describeRunAgent`): KEEP. Line 116 ("never choose or change a model yourself") stays; model choice is per agent definition and `/agents setup`.

## Tests

| File | Change |
| --- | --- |
| `S/test/plugins/run-agent/delegate-only.test.ts` | DELETE (five cases over `index.ts:166-173`). Move the case "never restricts for children" into the plan-mode tests if plan mode is per session |
| `S/test/model/settings.test.ts:80-139` | Strip the `delegateOnly` keys at 82-83, 94-95, 114-115, 125-126, 133-134 |
| `core/test/adapter/pi-restrict-tools.test.ts:88-168, 170-234, 236-242` | KEEP; add `restore` cases |
| `core/test/adapter/conformance.test.ts:233-286` | KEEP (pins pi's `setActiveTools`) |
| `S/test/live/routing.live.test.ts` | ADAPT. `builtinTools` (L119) becomes the tool set per mode: normal gets pi's defaults plus the agent tools; plan gets the plan set. "Exactly one agent" (L141) relaxes to "the first `run_agent` call includes the expected agent", and a direct `read` before it is allowed. L26 ("where do we parse settings") may now be answered by a direct read or by a scout; accept either. Keep the brief-fields (L16, L110) and skills-only-when-named (L144-145) checks |
| `core/test/adapter/live.ts:212` | KEEP (`openMainLikeSession`) |

No unit test asserts the main prompt text (`run-agent.test.ts:613-615` checks only the file set).

## Docs to rewrite

| Where | Sentence | Rewrite |
| --- | --- | --- |
| `S/README.md:5` | "The main session becomes a coordinator" | The main session decides and delegates |
| `S/README.md:51` | "With `delegateOnly` (on by default) the extension also deactivates ..." | Drop; mention `/plan` |
| `S/README.md:84` | "before `delegateOnly` narrows it" | Drop the clause |
| `S/README.md:100-102` | "Delegate-only main session" section | Replace with "Modes: normal and plan" |
| `S/README.md:108` | "a routing table (the first row that fits ...)" | Role guide, brief, results, plan batches |
| `S/README.md:130-131, 139` | `delegateOnly`, `delegateOnlyTools` in the settings example and list | Drop; add `plan` settings |
| `S/README.md:169` | "the delegate-only tool set decide which agent" | Tool set per mode |
| `ARCHITECTURE.md:30` | `restrictTools(keep)` entry | Add `restore` |
| `ARCHITECTURE.md:71` | "a routing table" | Role guide |
| `ARCHITECTURE.md:78` | "as they were before `delegateOnly` restricted them" | "before plan mode restricted them" |
| `ARCHITECTURE.md:88` | "Delegate-only:" paragraph | Replace with the mode controller |
| `ARCHITECTURE.md:196` | "the tools `delegateOnly` removed" | "the tools plan mode removed" |
| `STRUCTURE.md:72-73` | routing.live "checks the main session's routing" | Keep; add "per mode" |
| `STRUCTURE.md:141` | "delegate-only restriction" | "mode controller" |

History documents keep their text and gain or keep a status pointer: `docs/design/agent-workflow.md` (status note L5; delegate-only at L14, 371-372, 384-391, 406, 445-446, 474, 486-487) and `docs/design/implementation-plan.md` (L11, 19, 57-62). `future-plans/plan-mode.md` (L49, 127, 140, 188, 214) mentions delegate-only too; it is outside docs/ and left for its owner.
