# Product decisions for the Claude-alike subagent UX

Revised 2026-10-14 (fourth pass): subagents are self-sufficient and never ask the user for input; only the main session is interactive. A child's `confirm`/`select`/`input` dialogs resolve at once to their denial defaults (`false`, `undefined`, `undefined`) and its `notify` is a no-op, so dialog forwarding to the main UI, its serial queue, the record's `attention` field and every `needs input` surface (row status, list subtitle part, transcript status line, view header suffix, per-agent dialog notification) are removed. Why: agents run in the background while the user works in the main session; a dialog from an agent interrupts the one interactive surface for a decision the agent's caller should make, and an agent that needs a decision says so in its result, where the orchestrating model handles it. Children bind no UI context (`ctx.hasUI` false), so permission gates block with their headless reason, and the agent prompt says blocked approvals are not retried (`research/subagent-input.md`). This supersedes the `needs input` and forwarded-dialog parts of the third pass below; D2, D3 and D5 carry the new text.

Revised 2026-10-14 (round 2): D1's per-agent completion lines are gone (second Goals bullet).

Decided by the orchestrator on 2026-10-13 after the four research reports in this folder. Revised 2026-10-14 after the review (`review-findings.md`): D5's `auto` channel sends no bell and `idleDelayMs` is 20 s; D1's idle wake carries a `↳ N agents finished` user line (pi cannot start a run from idle without a visible user message, see plan 01 §C). (Superseded 2026-10-14: on pi 1.2.0 the idle wake is a hidden message that starts the run itself, so there is no `↳ N agents finished` line.) Revised 2026-10-14 (later): D4 keeps the first provider request visible as one collapsed text block (key `r`), because the user tests agent definitions from the view; the breakdown and the per-section collapsibles stay removed. The UX spec (`plans/00-ux-spec.md`) turns these into exact screens, strings, keys and timings; the implementation plans follow the spec. Revised 2026-10-14 (later): the panel is entered with `←` on an empty editor, not `↓`, so history browsing keeps `↑`/`↓`. Revised 2026-10-14 (third pass): D3's list shows the agent structure everywhere (sections `Running` and `Completed (n)` only, each in tree order with children under their caller; an agent waiting on a dialog keeps its tree position and shows `needs input` on its row); agents are named by agent name and description, not by id (view header `<agent> › <description>` with the id on the dim second line, same-agent batches named in the block header, forwarded dialogs titled `<agent> › <description> asks: <title>`, the model on the transcript row and the view header only); one padding and margin rule set for every surface (spec §2, from `padding.md`); the agent view hint shrinks to `esc`, `x`, `r request` and the tools key (no `↑/↓ to scroll`); the recorded-session test fixture loses its model name, and a view load error draws no Request line. Where the spec and this file disagree, the spec wins (it is later and more precise).

## Goals

1. The main session feels like Claude Code with background subagents: the prompt is always free, agents are visible but quiet, finishing work is one calm line, not a wall of text.
2. The user never needs to type into an agent. The main session is the orchestrator; corrections go through the model (`message_agent`).
3. One desktop notification when the work is done, none per agent.
4. The working indicator shows work, not output.

## Decisions

### D1. Main transcript

- `run_agent` renders as one block per call: a spinner header `Running N agents…` while the tool runs, then `N background agents launched (← to manage)` once it returned (`wait: false`), or `N agents finished` (`wait: true`). One row per agent under it, tree-connected: `agent (description)` with a status line. Rows keep updating live while the batch runs (we have `invalidate`): status `Initializing…` → `Running in the background` → `Done · N tool uses · 12.3k tokens · 1m 2s` (or `Failed: …`, `Stopped`). Background rows never show their tool calls.
- ~~Each finished agent produces a dim one-line transcript entry: `Agent "description" finished · 1m 2s` (dim), `Agent "description" failed: <error>` (error colour), `Agent "description" was stopped` (warning colour), `Agent "description" handed off` (warning). These are custom entries the model never sees.~~ Superseded (round 2, 2026-10-14): no per-agent lines; the live block (rows, green or red box) and the model's reply carry the outcome, and the wake never depended on them.
- The wake (batch results to the model) must stop looking like a message the user typed. Preferred: a custom message with `display: false` (model gets the full batch text; user sees nothing beyond the dim lines, since the model's reply follows). Fallback if the main-prompt caveat (pi skips `before_agent_start` for `sendMessage` when idle) cannot be solved safely: keep `sendUserMessage` and use a markdown transformer to display it as one short line. The implementation plan decides after reading pi's `agent-session.js`, and includes a live-test step that proves the main prompt is unchanged.
- `message_agent` and `agent_status` results stay as they are (model-facing, default rendering).

### D2. Agent panel below the editor (replaces the progress widget)

- Claude-style rows, max 5 visible, `↑ N more` / `↓ N more` markers when scrolled. Tree order (children under their caller) with `(+N)` descendant counts, not creation order.
- Row: `glyph name  description-or-latest-activity   elapsed · ↓ 12.3k tokens`, plus `queued` for queued agents, `stopping` during grace. Activity = the last tool name (`grep`, `bash`, `codemode`…) or last assistant line; the record gains the fields it needs.
- No header line, no `/agents to browse` text in the panel. A hint line under the rows only while a row is selected.
- Lifecycle: `done` rows leave the panel after 10 s (`doneLingerMs`, new default); `failed`, `stopped`, `handoff` rows stay 30 s (`failedLingerMs` default lowered from 60 s) or until `x` clears them. When the last row leaves, the panel disappears.
- Keyboard: `←` on an empty editor (no autocomplete) selects the first row; `↑`/`↓` move; `Enter` opens the agent view; `x` stops a running agent (grace, then `x` again closes now) or clears a finished row; `Esc` deselects and returns focus to the editor. Esc never interrupts the main turn while a row is selected. Stop-all lives in the list view only.
- Footer: while agents run the footer status shows `N agents` (accent); for 30 s after the last agent finished it shows `/agents to see agents` (dim), then nothing.
  - Revised 2026-10-14: removed. The panel lists every open agent, so the footer sets no `N agents` count and no hint; `agentsHintMs` is gone.

### D3. `/agents` list view

- Title `Agents`, subtitle `N running · N done` (zero parts omitted); sections `Running` and `Completed (n)`, both showing the agent structure: `Running` holds every open root with all its listed descendants under it in tree order (closed children stay under an open caller), `Completed (n)` the closed roots, newest first, each with its closed descendants (`n` counts roots). A completed subtree stays 30 s (`lingerMs`, from the root's `endedAt`) then leaves the list; `x` clears a closed root with its subtree, a closed child alone; `/agents <id>` still opens any agent of the session by id (manifest fallback), including from earlier runs.
- Keys: `↑`/`↓` select, `Enter` view, `x` stop (or clear), `X` stop all (press `X` again within 3 s to confirm; feedback line `Press X again to stop all agents`, `No running agents`), `Esc` close. Page keys and wheel as today. The `/` filter is removed.
- The list and the view live in one overlay: `Enter` switches to the view, `Esc` in a view opened from the list goes back to the list; `Esc` in a view opened from the panel or from `/agents <id>` closes.
- Empty state: `No agents running`.

### D4. Agent view (simplified)

- Removed: the context breakdown, the per-section effective-prompt collapsibles (system prompt, tools, skills, guidelines, provider request as separate sections), the focus/verbose mode and its file `pi-subagents-view.json`, the message box and the `route` from the UI, the `c`, `v`, `Tab`, `Space` keys.
- Kept, simplified: the task (the description line in the header and the first transcript item, the user message `Task from <caller> (agent id <id>): <task>`), and one `Request` block at the top of the transcript, collapsed by default (`▸ Request · 912 lines`), that `r` expands to the literal first provider request as plain pretty-printed JSON text, so an agent definition can be tested from the view.
- Kept: header (line 1 `glyph agent › description`, line 2 dim `state · model · id <id>`, line 3 dim `N tool uses · 12.3k tokens · 1m 2s · 23% ctx`, chain and worktree info when present), the transcript rendered with pi's own components, `Ctrl+O` (pi's tools key) toggling tool detail, scroll keys, `x` stop, `Esc` back/close. Thinking stays hidden.
- Codemode calls render like pi's main transcript (highlighted script, nested call list with status icons, output preview) by capturing pi's codemode and tool_search definitions through the exported factories. Nested `run_agent`, `message_agent`, `agent_status` calls inside an agent render with the same `renderCall`/`renderResult` as in the main session.

### D5. Notifications become a global extension

- New extension `extensions/notifications/`; the subagents `notifications` plugin and the `notifications` setting in `pi-subagents.json` are removed.
- One notification when the session is idle: main session settled (`onIdle`) and no busy source on the busy channel (subagents already publishes while agents are open; the channel is renamed from `session-limits:busy` to a neutral name in `core/manager/channels.ts`). Fires after `idleDelayMs` (default 10 s) with no keystroke since the settle, once per settle; cancelled by any key. Text: `pi is waiting for your input`. If agents are still running when main settles, wait for them (the wake will start a new turn; the timer re-arms on the next settle).
- A second notification when a main-session dialog waits (pi's `ui_prompt_start`; agents never open dialogs, their dialogs resolve to the denial defaults at once): after 6 s without a keystroke, `pi needs your input: <title>`; `ui_prompt_end` cancels.
- Channel: `auto` (OSC 9, or OSC 777 on rxvt, with BEL), `bell`, `off`. Settings file `pi-notifications.json`. TUI mode only.
- Nothing per agent, nothing per batch, nothing per tool.

### D6. Working indicator

- Shown while the main session is waiting for the model, streaming thinking, streaming tool-call arguments, or executing tools. Hidden while assistant text streams (the text is the progress). Idle: hidden.
- The adapter computes the phase from pi's `turn_start`, `message_update`, `message_end`, `tool_execution_start/end`, `agent_end`, `agent_settled` events and exposes it as `host.onPhase`. The extension toggles `setWorkingVisible` and keeps the clock from `agent_start` to `agent_settled` as today.
- Subagents never drive the indicator: child sessions are isolated already; the plan only states and tests this. The `run_agent` tool with `wait: true` is a real tool execution of the main session and counts as work.
- Message format stays `Verb… (12s · esc to interrupt)`; during a tool phase it adds the tool name: `Verb… (bash · 12s · esc to interrupt)`. Verb rotation stays as it is (the user did not ask to change it; Claude Code picks one verb per turn, noted as an option).

### D7. Out of scope

- Messaging agents from the UI, foreground (blocking) agent transcripts inline, Claude's `Ctrl+X Ctrl+K` chord, terminal focus detection, tab-title glyphs, per-phase shimmer colours, `embedWorkingStatus` in the composer frame.
