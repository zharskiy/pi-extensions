# Plans: a Claude-alike subagent UX for pi

Branch `plans/claude-ux`. These documents are the complete design and implementation plan for reworking how the pi extensions in this repository present background subagents, the working indicator and notifications. Nothing in `plans/` is published (the `files` list in `package.json` excludes it); it is removed once the work has landed.

## Goals

1. The main session feels like Claude Code with background subagents: the prompt is always free, agents are visible but quiet, and finishing work is one calm line, not a wall of text.
2. The user never types into an agent. The main session is the orchestrator; corrections go through the model (`message_agent`).
3. One desktop notification when the work is done, none per agent.
4. The working indicator shows work (waiting for the model, thinking, running tools), not output.
5. The agent view shows an agent's transcript and nothing else; codemode calls read like they do in the main session.

## Documents

Read in this order. Each later document assumes the earlier ones.

| File | What it is | Status |
|---|---|---|
| `research/decisions.md` | The product decisions (D1–D7) the spec and the plans follow. | final |
| `00-ux-spec.md` | The single source of truth for what the user sees and does: screens, exact strings, keys, colours, timings, settings, removed features. | final |
| `research/shared-modules.md` | Module names, signatures and ownership shared between the feature plans. | final |
| `01-adapter-foundations.md` | Platform work in `core/adapter` and `core/manager` (A–H): turn phases, editor key hooks, hidden messages and entry renderers, richer tool rendering and pi's codemode renderers in the agent view, dialog and key events, busy channel rename. | final |
| `02-working-indicator.md` | The working-indicator extension on phases. | final |
| `03-notifications.md` | The new global `notifications` extension; removal of per-agent notifications from subagents. | final |
| `04-main-transcript.md` | The `run_agent` block, completion lines, the wake, the `activity` field, shared formatters. | final |
| `05-agent-panel.md` | The panel below the editor, keyboard selection, footer status, row/tree/refresh modules. | final |
| `06-list-and-agent-view.md` | The `/agents` list and the simplified agent view in one overlay; codemode rendering. | final |
| `research/review-findings.md` | The cross-plan review: findings and their resolution. | final |
| `research/*.md` (others) | Research: Claude Code behaviour (agents UX; indicator and notifications), the current UI audit, pi 1.1.0 API capabilities. | reference |

## What changes, in one screen

- Main transcript: `run_agent` renders as `3 background agents launched (↓ to manage)` with one tree row per agent and a live status line; each agent that closes adds one dim line (`✓ Agent "Map the auth module" finished · 1m 5s`); the batch results reach the model as a hidden message (plus a short `↳ 3 agents finished` user line when the session was idle).
- Panel below the editor: Claude-style rows (`⠹ explorer  Map the auth module   grep · 1m 5s · ↓ 12.3k tokens`), at most 5 visible with `↑ N more`/`↓ N more`, tree order with `(+N)`; `↓` on an empty editor selects a row, `Enter` opens it, `x` stops or clears, `Esc` deselects; done rows leave after 10 s, failed ones after 30 s; the footer shows `3 agents`, then `/agents to see agents` for 30 s.
- `/agents`: `Running`, `Needs input`, `Completed (n)` sections; `Enter` opens the agent view inside the same overlay, `Esc` returns; `X` twice stops all; closed rows leave after 30 s.
- Agent view: header, transcript, `Ctrl+O` tool detail, `x` stop, `Esc` back or close. Context breakdown, prompt sections, focus/verbose mode and the message box are gone. Codemode renders with pi's own renderer.
- Working indicator: visible while waiting, thinking, streaming tool arguments and running tools (`Pondering… (bash · 12s · esc to interrupt)`); hidden while the assistant's text streams; child sessions never touch it.
- Notifications: a new extension sends `pi is waiting for your input` 20 s after the session settles with no agent running and no keystroke since, and `pi needs your input: <title>` 6 s after a dialog opens. A desktop notification without a bell on `auto`; nothing per agent.

## Integration order

Each step ends with a green `npm run check`. The authoritative sequence, with the bridges, is in `research/review-findings.md` "Integration order":

1. Plan 01 §G (busy channel rename `pi:busy`).
2. Plan 01 §A (turn phases) → plan 02 (working indicator; creates `core/manager/format.ts` with `formatDuration` if it lands before plan 04).
3. Plan 01 §F (dialog events, key listener) → plan 03 (remove the subagents notifications plugin, `ChoiceRule`, `terminalNotify(message, channel)`, the new extension, docs).
4. Plan 01 §B (editor hooks) → §D (tool render state with `args` and `isError`, pi renderers in the agent view transcript) → §C (hidden message, entry renderer; run the live wake test locally).
5. Plan 04 (step 0 `core/manager/format.ts` with `formatTokens`; shared modules; `activity`; the start block; completion lines; the wake; the `tools` service).
6. Plan 05 (optional `{ from }` on `agentView.open`; the `legacy-row.ts` bridge; settings; README "Other keys" sentence).
7. Plan 06 (one overlay; list; view; codemode snapshot; deletes `legacy-row.ts`; README and ARCHITECTURE merges per plan 04 §9).
8. Final doc pass: `ARCHITECTURE.md` plugin list and "Status and views", `STRUCTURE.md`, root `README.md`, `package.json` description; then delete `plans/`.

Plans 05 and 06 may land in one PR; then the bridge and the optional parameter are skipped.

## Rules that apply to every step

- `npm run check` must pass after each plan section; live tests (`npm run test:live`) are local only and needed once, for the wake (plan 01 §C).
- Only `core/adapter` imports pi packages; extensions never import each other; no provider or model names in code, prompts or docs (mockups use `provider/model:high`).
- Every behaviour has a unit test against the fakes in `core/test/helpers/fakes.ts`; snapshot tests with pi's real components stay in `extensions/subagents/test/plugins/agent-view/`.
- Update `ARCHITECTURE.md`, `STRUCTURE.md` and the extension READMEs in the same change as the code they describe; each plan carries its final doc text.
