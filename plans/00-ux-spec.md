# UX spec: Claude-alike subagents

Reviewed 2026-10-14: the wake line gets a `↳` glyph, the notification channel `auto` sends no bell, `idleDelayMs` is 20 000, the panel window keeps its top row on deselect, `Esc` in the list also cancels a pending stop-all, the token and duration formatters live in `core/manager/format.ts`, and the start block's spinner moves only on agent events (see `research/review-findings.md`).

Single source of truth for what the user sees and does. Follows `plans/research/decisions.md` (D1–D7); where this file is more precise, it wins. Strings in code spans are exact. Timings are in ms with their setting name. Mockups are 80 columns wide; `provider/model:high` stands for any model label. Nothing here names a provider or a model.

## 1. Principles

1. Claude-alike means: the prompt is always free, agents are visible but quiet, and finishing work is one calm line, not a wall of text.
2. The prompt is always free. No surface takes the editor's focus except an overlay the user opened, and nothing the panel does interrupts the main turn.
3. One calm line per event. An agent that finishes, fails, stops or hands off adds exactly one dim transcript line. Nothing else scrolls.
4. Background agents show status, never their tool calls, in the main transcript. Their transcript lives in the agent view only.
5. Nothing the model needs is hidden from it. The wake carries the full batch text to the model; what the user sees is a summary of what the model already has.
6. One clock, one spinner. Every surface reads the same wall clock, the same spinner frames and the same formatters, so numbers agree between the panel, the list, the view and the transcript.
7. When in doubt, use Claude Code's string and timing. Deviations are marked `(deviation: …)` with a one-line reason.

## 2. Vocabulary

State words, glyphs and theme tokens for every `AgentRecord.state` (theme tokens from `core/adapter/contract.ts` `ThemeToken`: `accent|muted|dim|success|warning|error|text`; no new token is needed, no background is used):

| State | Word (rows, subtitle) | Word (sentences) | Glyph | Token |
|---|---|---|---|---|
| `queued` | `queued` | `queued` | `○` | `muted` |
| `running` | `running` | `running` | spinner frame | `accent` |
| `grace` | `stopping` | `stopping` | `◐` | `warning` |
| `done` | `done` | `finished` | `✓` | `success` |
| `failed` | `failed` | `failed` | `✗` | `error` |
| `stopped` | `stopped` | `was stopped` | `■` | `muted` |
| `handoff` | `handed off` | `handed off` | `↪` | `warning` |

Attention (a forwarded dialog waits): the glyph stays the state's glyph; the status word is `needs input` in `warning`, and it replaces the elapsed/tokens stats wherever stats are shown.

Spinner: the ten braille frames `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`, painted `accent`. The frame is `floor(now / 100) % 10` at render time, so every surface shows the same frame and no surface keeps a frame counter. Surfaces that need to animate while pi is otherwise idle run a shared ticker (`agentsTickMs`, fixed 100 ms, not a setting) while any record is `running` or `grace`; 1000 ms while only `queued` or closed rows are on screen; none when nothing is on screen.

Shared formatters (`formatTokens` and `formatDuration` live in `core/manager/format.ts` so the footer and the working indicator share them too; the subagents module re-exports them; the duplicates in `footer/src/render.ts` and `components/agent-row.ts` go):

- Tokens: `842`, `12.3k`, `1.2M` (one decimal from 1 000 up). With unit: `12.3k tokens`. A zero count is omitted wherever it is optional.
- Durations: `3s`, `1m 2s`, `1h 2m` (below one minute seconds only; below one hour minutes and seconds; from one hour hours and minutes). Never `75s`.
- Tool uses: `1 tool use`, `0 tool uses`, `4 tool uses`.
- Context: `23% ctx` (rounded percent of the agent's context limit), omitted when unknown.
- Agent counts: `1 agent`, `3 agents`.
- Separator inside stats: ` · ` (space, middle dot, space).
- Truncation: `…` as the last visible cell, measured in display columns, never in UTF-16 units.

## 3. Surface A: main transcript

### `run_agent` block

One block per `run_agent` call. The tool call line is the header; the tool result is the rows. The block uses pi's plain shell (`renderShell: "self"`, no coloured box, no `(ctrl+o to expand)` hint). It re-renders through the stored `invalidate` at most every `renderThrottleMs` (default 250) after an `agent:changed` of its batch. It never schedules its own timer, and pi caches a tool block between invalidations, so the spinner in the header advances only on agent events (deviation: a frozen spinner between events is accepted; the panel below the editor animates).

Header phases:

| Phase | Header line |
|---|---|
| Tool running (`wait: true`, or `wait: false` before it returns) | `⠹ Running 3 agents…` (spinner `accent`, `3` bold, `agents…` `text`); `1 agent…` singular |
| Returned, `wait: false`, at least one agent still open | `3 background agents launched (↓ to manage)` (`3` bold, hint `dim`) |
| Returned, `wait: false`, every agent closed | `3 background agents launched` (deviation: Claude keeps the hint; we drop it because there is nothing left to manage) |
| Returned, `wait: true` | `3 agents finished` (`3` bold) |
| Error result (nothing started) | `✗ No agents started: <first line of the error>` (`error`); the full error text when expanded with `Ctrl+O` |

Rows, one per agent of the batch, tree-connected under the header with `├─ ` and `└─ ` (last), continuation `│  ` / `   `:

- Line 1: `├─ explorer (Map the auth module) · provider/model:high` — `explorer` is `record.agent`, bold; with a chain, `explorer #2`; the description in parentheses, `muted`, cut with `…` to the width; then ` · <model>` (`dim`, the resolved `provider/id:thinking` label, dropped first when the width is short). This is the only row that names the model; the panel and the list do not.
- Line 2 (status line, indented under the name) per state:

| State | Status line | Token |
|---|---|---|
| `queued` | `Queued` | `muted` |
| `running`, no turn ended yet, no tool started | `Initializing…` | `muted` |
| `running`, `wait: false` | `Running in the background` | `muted` |
| `running`, `wait: true` | `Running · 4 tool uses · 12.3k tokens` (live) | `muted` |
| attention (any open state) | `Needs input: <dialog title>` | `warning` |
| `grace` | `Stopping…` | `warning` |
| `done` | `Done · 4 tool uses · 12.3k tokens · 1m 5s` | `Done` `success`, rest `dim` |
| `failed` | `Failed: <first line of error>` | `error` |
| `stopped` | `Stopped · 4 tool uses · 12.3k tokens · 1m 5s` | `muted` |
| `handoff` | `Handed off · 4 tool uses · 12.3k tokens · 1m 5s` | `warning` |

Closed worktree agents append ` · worktree removed`, ` · branch <branch> kept` or ` · worktree kept` (`dim`) to the status line once the cleanup outcome is known. A chain row follows the chain terminal; its stats sum the chain.

Live updates stop when the batch settles (`batch:settled`, after worktree cleanup). After a transcript rebuild (resume, `/reload`) with no registry record for the batch, the status line reads `Status unavailable · /agents <id>` (`dim`); the header keeps its last phase from the persisted result.

### Per-agent completion lines

A custom transcript entry (`appendEntry`, rendered by a registered entry renderer; the model never sees it) for every agent whose caller is `main` (children of agents print nothing), appended when the record closes; for a worktree agent, when its cleanup outcome is known. One line each, glyph then text, whole line in one token:

| State | Line | Token |
|---|---|---|
| `done` | `✓ Agent "Map the auth module" finished · 1m 5s` | `dim` |
| `failed` | `✗ Agent "Fix the login redirect" failed: tests failed twice · 2m 10s` | `error` |
| `stopped` | `■ Agent "Review the diff of PR 5" was stopped · 3m 2s` | `warning` |
| `handoff` | `↪ Agent "Map the auth module" handed off · 1h 2m` | `warning` |

Details after the text, each ` · `-joined: duration (always); `2 sessions` for a chain (printed once, at the chain's end; links that continue print nothing); `worktree removed` / `branch <branch> kept` / `worktree kept` for worktree agents. The error is its first line, cut at 120 columns with `…`. The description is cut at 60 columns with `…`.

### The wake

The batch text for the model always travels as a hidden custom message (`display: false`; see `plans/01-adapter-foundations.md` §C, `Host.sendHiddenMessage`). What the user sees depends on whether the main session is busy when the batch settles:

- Main session busy (the model is mid-run): the hidden message joins the run as a follow-up. The user sees nothing new; the model's reply simply takes the results into account.
- Main session idle: a run can only start safely through a visible user message, so one short user-role line starts the turn: `↳ 3 agents finished` (`↳ 1 agent finished` singular; several batches held in the outbox are counted together). The leading `↳` marks it as a system note inside the user-message box. It renders as a user message (pi's user-message box; that is the only way to start a turn with the main prompt intact), and the hidden results message follows it for the model. Then the working indicator (section 7) and the model's reply.

In both cases the dim completion lines (above) have already appeared as each agent closed, and the `run_agent` block's header has lost `(↓ to manage)`.

(deviation: Claude shows no user line at all; pi has no other safe way to start a run from idle. The line is short, starts with `↳` and names only the count so it reads as a system note, not as pasted results.)

### Unchanged

- `message_agent` call line `message_agent <id> <first 60 chars>` and its default-rendered result (`Message delivered to <id> (steer).` and the error strings) stay.
- `agent_status` call line and result stay.
- Forwarded dialogs keep the title `<id> (<agent>) asks: <title>`; `Esc` denies that one call. Child `notify` lines keep `<id> (<agent>): <message>`.

### Mockups

Batch of 3 just launched (`wait: false`):

```
 3 background agents launched (↓ to manage)
 ├─ explorer (Map the auth module) · provider/model:high
 │  Initializing…
 ├─ worker (Fix the login redirect) · provider/model:medium
 │  Running in the background
 └─ reviewer (Review the diff of PR 5) · provider/model:high
    Queued
```

Same batch, one done and one needing input (the completion line is a separate entry below the block):

```
 3 background agents launched (↓ to manage)
 ├─ explorer (Map the auth module)
 │  Done · 4 tool uses · 12.3k tokens · 1m 5s
 ├─ worker (Fix the login redirect)
 │  Needs input: Run npm test?
 └─ reviewer (Review the diff of PR 5)
    Running in the background

 ✓ Agent "Map the auth module" finished · 1m 5s
```

After everything finished, including the model's reply:

```
 3 background agents launched
 ├─ explorer (Map the auth module)
 │  Done · 4 tool uses · 12.3k tokens · 1m 5s
 ├─ worker (Fix the login redirect)
 │  Failed: tests failed twice
 └─ reviewer (Review the diff of PR 5)
    Done · 12 tool uses · 44.0k tokens · 3m 2s

 ✓ Agent "Map the auth module" finished · 1m 5s
 ✗ Agent "Fix the login redirect" failed: tests failed twice · 2m 10s
 ✓ Agent "Review the diff of PR 5" finished · 3m 2s

 The auth module lives in src/auth. The login redirect fix did not land:
 its tests failed twice; the reviewer found the diff of PR 5 clean. …
```

## 4. Surface B: agent panel

A widget below the editor (`belowEditor`), replacing the progress widget. No header line, no `/agents` text. Absent when it has no rows.

### Row grammar

```
<pointer><tree><glyph> <name>[ (+N)]  <description>   [<activity> · ]<stats>
```

- `pointer`: `› ` (`accent`, bold) on the selected row, else two spaces.
- `tree`: nothing for agents called by `main`; `├─ ` / `└─ ` (`dim`) for children under their caller, with `│  ` / `   ` continuation per level above. Rows are in tree order: callers first, children directly under them, siblings by `createdAt`. A row keeps its place when it closes.
- `glyph` + space: the state glyph in the state token (spinner while `running`).
- `name`: `record.agent`, `text` (`muted` on closed rows), with ` #2` for chain links after the first; `(+N)` (`dim`) is the number of open descendants of this agent; omitted when 0. The name column is padded to the widest visible name, capped at 24 columns, then two spaces.
- `description` (`muted`): always the agent's description, so two agents of the same kind stay distinguishable (deviation: Claude replaces it with the latest progress summary; we keep the description and put the activity in the stats column).
- `activity`: while `running`, the latest activity when known, shown as the first part of the stats: the last top-level tool name (`grep`, `bash`, `codemode`, …) or, when the last event was an assistant message, the word `writing`. It is `dim` like the stats and separated with ` · `. The record gains `activity?: { kind: "tool" | "text"; text: string; at: number }`; its `text` is the tool name or the first line of the assistant text (used by the agent view header later, not by the row).
- `stats`, right-aligned to the width: `grep · 1m 5s · ↓ 12.3k tokens` (`dim`); the activity part only while `running` and known; tokens omitted when 0. Status words replace the stats: `queued` (`muted`), `needs input` (`warning`), `stopping` (`warning`). Closed rows show `<word> · <duration>`: `done · 1m 5s`, `failed · 2m 10s`, `stopped · 3s`, `handed off · 1h 2m` (word in the state token, duration `dim`).

Column rule, from the full width `W`: fixed parts are pointer (2), tree, glyph (2), name column, two spaces, and two spaces before the stats. The description gets the rest. If that is below 12 columns, drop the activity from the stats; if still below 12, drop the tokens; if still below 12, drop the elapsed too (status words stay); if still below 8, the description is omitted and the name is cut with `…`. Otherwise the description is cut with `…` to fit. Each line is finally hard-cut to `W` by the adapter.

### Window and markers

- At most 5 agent rows. With more rows, a dim `↑ N more` line precedes the first visible row and a dim `↓ N more` line follows the last visible row (either, both or none). The window scrolls by the minimum to keep the selected row visible. When the selection clears, the window keeps its top row (clamped to the row count); it never jumps back to the first row on its own.
- The hint line (below the rows and markers) exists only while a row is selected.
- `(+N)` on a visible row tells the user that rows under it exist even when they are scrolled out.

### Which rows are visible

- `queued`, `running`, `grace`: always.
- `done`: for `doneLingerMs` (new, default 10 000) after `endedAt`.
- `failed`, `stopped`, `handoff`: for `failedLingerMs` (default lowered to 30 000) after `endedAt`, or until `x` clears the row.
- When the last row leaves, the widget is removed and the selection cleared.

### Keys

The interception lives in the framed editor's input handler and acts only while the editor has focus.

| Key | Nothing selected | Row selected |
|---|---|---|
| `↓` | Editor empty, no autocomplete, panel present: selects the first row. Editor non-empty or panel absent: the editor's own behaviour, nothing new. | Moves to the next row (clamped at the last). |
| `↑` | Editor's own behaviour (history). | Moves to the previous row; on the first row it deselects and focus stays in the editor. |
| `Enter` | Submits the editor. | Opens the agent view of the selected row (section 6) in an overlay; the selection clears. |
| `x` | Types `x`. | `running` or `queued`: stops the agent (a running agent enters grace; a queued one closes at once). `grace`: closes it now. Closed: clears the row. |
| `Esc` | pi's own behaviour (interrupt when busy). | Deselects. The main turn is never interrupted while a row is selected. |
| any other key | Editor. | The selection clears and the key goes to the editor (it is not swallowed). |

The panel never takes focus; the editor keeps it throughout. A new row appearing or a row leaving does not move the selection unless the selected row left, in which case the selection clears.

### Hint line

Only while a row is selected, `dim`, one line:

- running or queued row: `enter to view · x to stop · esc to deselect`
- grace row: `enter to view · x to close now · esc to deselect`
- closed row: `enter to view · x to clear · esc to deselect`

(deviation: Claude says `esc to collapse` and adds `ctrl+x ctrl+k to stop all agents`; we have no idle-collapse and stop-all lives in the list view.)

### Footer status

Through `setStatus("pi-subagents", …)`:

- While any record is open (`queued`, `running`, `grace`, any depth): `3 agents` (`accent`), `1 agent` singular.
- From the moment the last open record closes, for `agentsHintMs` (new, default 30 000): `/agents to see agents` (`dim`).
- Then nothing. A new open record replaces the hint with the count at once.

### Refresh

Re-render on `agent:changed` throttled by `renderThrottleMs` (default 250), plus the shared ticker (section 2). Closed rows are cached by `id`, `version`, width and theme as today.

### Mockups

Two running (one is a worktree agent; the panel does not say so):

```
   ⠹ explorer  Map the auth module              grep · 1m 5s · ↓ 12.3k tokens
   ⠹ worker    Fix the login redirect          bash · 2m 10s · ↓ 30.1k tokens
```

Seven agents, selection on the fourth, window scrolled:

```
 ↑ 2 more
   ⠹ worker     Fix the login redirect         bash · 2m 10s · ↓ 30.1k tokens
 › ⠹ reviewer (+1)  Review the diff of PR 5     writing · 45s · ↓ 8.2k tokens
   └─ ⠹ explorer  Find callers of login          read · 12s · ↓ 1.1k tokens
   ○ worker     Rename parseDate callers                                queued
   ○ explorer   Find every date format in tests                         queued
 ↓ 1 more
 enter to view · x to stop · esc to deselect
```

One done row (it leaves 10 s after it finished; no countdown is shown):

```
   ⠹ worker    Fix the login redirect          bash · 2m 10s · ↓ 30.1k tokens
   ✓ explorer  Map the auth module                                done · 1m 5s
```

One failed row, selected, with the hint line:

```
 › ✗ worker    Fix the login redirect                          failed · 2m 10s
 enter to view · x to clear · esc to deselect
```

## 5. Surface C: `/agents` list view

A full-screen overlay (`openOverlay`, width `100%`, max height `100%`). `/agents` opens the list; `/agents <id>` opens the view of that agent directly (manifest fallback, chains followed to the terminal, as today).

### Layout

```
Agents · 3 running · 1 done
(blank)
Running
<rows>
(blank)
Needs input
<rows>
(blank)
Completed (1)
<rows>
(padding to the height)
<feedback line, only while shown>
<hint line>
```

- Title `Agents` bold; subtitle ` · 3 running · 1 done` (`dim`): `running` counts every open record (queued, running, grace, needs input), `done` counts the rows in `Completed`. A zero part is omitted (`Agents · 3 running`). With no rows at all the body is one `muted` line `No agents running` and no subtitle.
- Section headers bold: `Running`, `Needs input`, `Completed (1)`; empty sections are not shown; one blank line between sections.
- `Running`: open records without attention, in tree order with the panel's tree connectors. `Needs input`: open records with attention, flat. `Completed`: closed records, flat, newest `endedAt` first. A child whose caller is in another section renders at depth 0.
- Rows reuse the panel row grammar exactly (pointer, glyph, name, `(+N)`, description, right-aligned activity and stats), at the overlay width.
- Scroll window: the rows between the title block and the hint, page keys as today, wheel in fullscreen TUI mode. The selection is kept visible.

### Lifecycle

Closed records stay listed for `lingerMs` (default 30 000) after `endedAt`, then leave. Open records are always listed. Refresh as the panel (`agent:changed` throttled by `renderThrottleMs`, plus the shared ticker). A record that leaves while selected moves the selection to the next row, or clears it.

### Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection over rows (headers are skipped, clamped at both ends). |
| `PgUp` / `PgDn` | Scroll by a page. |
| `Home` / `End` | First / last row. |
| `Enter` | Open the selected agent's view inside this overlay (section 6). |
| `x` | Open row: stop (grace); grace row: close now; closed row: clear it from the list. |
| `X` | Stop all: first press shows the feedback `Press X again to stop all agents`; a second `X` within `stopAllConfirmMs` (fixed 3 000) stops every open agent (each enters grace) and clears the feedback. With no open agent the feedback is `No running agents`. Any other key cancels the pending confirmation. |
| `Esc` | Close the overlay (a pending stop-all confirmation is cancelled as well). |

Feedback line: `warning` for `Press X again to stop all agents`, `muted` for `No running agents`; shown above the hint line for 3 000 ms (the confirmation window) or 2 000 ms (`No running agents`), then removed.

Hint line (`dim`): `↑/↓ to select · enter to view · x to stop · X to stop all · esc to close`; with a closed row selected `x to clear`; with a grace row `x to close now`.

### List and view in one overlay

`Enter` swaps the overlay's content to the agent view; the list keeps its selection and scroll position. `Esc` in a view opened this way swaps back to the list (the list reloads its rows). `Esc` in a view opened from the panel or from `/agents <id>` closes the overlay. The `/` filter and the `y` confirmation are gone.

### Mockup

```
Agents · 4 running · 1 done

Running
   ⠹ explorer  Map the auth module              grep · 1m 5s · ↓ 12.3k tokens
 › ⠹ worker (+1)  Fix the login redirect      bash · 2m 10s · ↓ 30.1k tokens
   └─ ⠹ explorer  Find callers of login          read · 12s · ↓ 1.1k tokens

Needs input
   ⠹ reviewer  Review the diff of PR 5                            needs input

Completed (1)
   ✓ explorer  Find callers of parseDate                           done · 45s



Press X again to stop all agents
↑/↓ to select · enter to view · x to stop · X to stop all · esc to close
```

## 6. Surface D: agent view

### Header

Lines, top to bottom, then a `dim` rule of `─` across the width:

1. `<glyph> <id>[ #n] · <state word> · <model>` — glyph in the state token (coloured, unlike today); id bold; state word from section 2 (`queued`, `running`, `stopping`, `done`, `failed`, `stopped`, `handed off`); model label or `model n/a`. With attention: ` · needs input: <title>` (`warning`) appended.
2. `<description>` (`muted`).
3. `4 tool uses · 12.3k tokens · 1m 5s · 23% ctx` (`dim`); live while open; `23% ctx` omitted when unknown.
4. Optional, `failed`: `error: <first line of error>` (`error`). Optional, `handoff`: `handoff: <path>[ (invalid: <reasons>)]` (`warning`).
5. Optional chain line (`dim`): `chain: <id> → <id> (2 sessions)`; when the opened id is not the terminal, ` · opened <id>` is appended.
6. Optional worktree line (`dim`): `worktree: <path> (branch <branch>)`, or after cleanup `worktree: removed`, `worktree: removed; branch <branch> kept`, `worktree: kept: <reason>`.

### Transcript

- Rendered with pi's own components (`UserMessageComponent`, `AssistantMessageComponent` with thinking hidden, `ToolExecutionComponent`, `CustomMessageComponent`) as today. Thinking is never shown.
- `Ctrl+O` (pi's `app.tools.expand` binding; the label comes from `keyText("app.tools.expand")`) toggles tool detail for every tool row.
- Tool definitions for rendering: the eight built-ins plus `codemode` and `tool_search` captured from pi's exported factories, plus this extension's `run_agent`, `message_agent` and `agent_status` with the same `renderCall`/`renderResult` as the main session (so a nested `run_agent` shows the block of section 3 inside the agent's transcript). Every other tool keeps pi's generic fallback.
- Codemode, collapsed: the title `codemode`, the script syntax-highlighted with its first 10 visual lines and `… (N more lines, ctrl+o to expand)`, then the nested-call list (the last 8 calls, `… (N earlier calls, ctrl+o to expand)` above them), one per line: `<icon> <tool name> <args cut at 80> <duration>`, icons `…` (`warning`, running), `✓` (`success`), `✗` (`error`), `⊘` (`muted`, cancelled), then the output's first 5 visual lines. Expanded: the full script, every nested call, the full output, `Full output: <path>` when codemode truncated it.
- The task arrives as the user message `Task from <caller> (agent id <id>): …` and routed messages as `[message from <sender>]` user messages, unchanged.

### Scrolling

Opens at the tail. Follows the tail while the agent is open and new content arrives. `↑`, `PgUp`, `Home` or a wheel-up stop following; `End` scrolls to the tail and resumes following. A closed agent neither ticks nor follows.

### Hint line

One `dim` line at the bottom; the position `12-52/312` is right-aligned on the same line and dropped when it does not fit; when not following, ` · end to follow` is appended to the position.

| Agent | Opened from | Hint |
|---|---|---|
| open | panel or `/agents <id>` | `esc to close · x to stop · ctrl+o tool detail · ↑/↓ to scroll` |
| open | list | `esc to go back · x to stop · ctrl+o tool detail · ↑/↓ to scroll` |
| grace | any | `x to close now` replaces `x to stop` |
| closed | panel or `/agents <id>` | `esc to close · ctrl+o tool detail · ↑/↓ to scroll` |
| closed | list | `esc to go back · ctrl+o tool detail · ↑/↓ to scroll` |

`ctrl+o` is whatever `keyText("app.tools.expand")` returns.

### Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll one line (stops following / no effect on following). |
| `PgUp` / `PgDn` | Scroll one page. |
| `Home` / `End` | Top (stops following) / tail (resumes following). |
| `Ctrl+O` | Toggle tool detail. |
| `x` | Open: stop (grace); grace: close now; closed: nothing. |
| `Esc` | Back to the list when opened from it, else close the overlay. |
| wheel | Scroll (fullscreen TUI only). |

Every other key does nothing.

### Refresh

Transcript re-parse only when the session file's size or mtime changed, at most every `renderThrottleMs` (default 250) after a chain `agent:changed`; header stats and spinner through the shared ticker while the agent is open.

### Removed (planners delete)

The context breakdown and `components/context-breakdown.ts`; the effective-prompt sections (`system-prompt-block.ts`, `collapsible.ts`, the prompt record's use in the view); the focus/verbose mode, `mode-store.ts` and the file `pi-subagents-view.json`; the message box, its status line and the view's `route` call; the keys `c`, `v`, `Tab`, `Space`; the `Transcript` and `Effective prompt` titles; the `agent closed, messages disabled` hint; the `Task: ` prefix on the description line.

### Mockup (running agent, codemode call collapsed)

```
⠹ explorer-3f2a9c1b7d0e · running · provider/model:high
Map the auth module
4 tool uses · 12.3k tokens · 1m 5s · 23% ctx
────────────────────────────────────────────────────────────────────────────────
 Task from main (agent id explorer-3f2a9c1b7d0e): Map the auth module. List
 every entry point and the session handling.

 I will start with the login path.

 codemode
 const hits = await tools.grep({ pattern: "login", path: "src" });
 const file = await tools.read({ path: hits[0].path });
 return file.slice(0, 200);
 ✓ grep {"pattern":"login","path":"src"} 0.1s
 ✓ read {"path":"src/auth/login.ts"} 0.0s
 export const login = async (req: Request) => {
   const session = await sessions.open(req);
 … (3 more lines, ctrl+o to expand)

 grep pattern="session" path="src/auth"


esc to close · x to stop · ctrl+o tool detail · ↑/↓ to scroll        1-18/18
```

## 7. Surface E: working indicator

The adapter computes a phase from pi's `turn_start`, `message_update`, `message_end`, `tool_execution_start/end`, `agent_end`, `agent_settled` events (assistant messages only; events with `parentToolCallId` ignored) and exposes `host.onPhase(phase, detail)`. The extension toggles `setWorkingVisible` and writes the message.

| Phase | Entered on | Visible | Message |
|---|---|---|---|
| `waiting` | `turn_start`; `tool_execution_end` with no tool still running | yes | `Pondering… (12s · esc to interrupt)` |
| `thinking` | `thinking_start` / `thinking_delta` | yes | same |
| `writing` | `text_start` / `text_delta` | no | (the streaming text is the progress) |
| `toolArgs` | `toolcall_start` / `toolcall_delta` | yes | same |
| `tool` | `tool_execution_start` (top level) | yes | `Pondering… (bash · 12s · esc to interrupt)` |
| `idle` | `agent_settled` | no | message cleared |

Grammar: `<Verb>… (<tool name> · <elapsed> · <key> to interrupt)`, where `<tool name> · ` is present only in `tool`; `<elapsed>` uses the shared duration formatter (`12s`, `1m 5s`; deviation from today's `75s`); `<key>` is `keyText("app.interrupt")` read once per run. With several tools running at once the name is the most recently started one still running.

Clock: starts at the `agent_start` that begins a run (the previous run has settled), resets per run, keeps counting across every turn, follow-up and internal `agent_start` of that run, and stops at `agent_settled`. The verb is picked at run start and rotates every `VERB_MS` (fixed 8 000) as today. The message is rewritten every 1 000 ms while visible.

A wake-triggered run is a run like any other: the indicator appears at its `agent_start` with a fresh clock and verb, in phase `waiting`, the moment the model's turn starts. `run_agent` with `wait: true` is a tool execution of the main session, so the indicator shows `Verb… (run_agent · 1m 5s · esc to interrupt)` for the whole batch.

Nothing from child sessions affects the indicator: no child event, child tool, child dialog, child notify, agent close, batch settle or busy-channel change may change the phase, the message, the clock or the visibility. The plan states and tests this.

## 8. Surface F: notifications

A new global extension `extensions/notifications/`. TUI mode only. Channels: `auto` (OSC 9; on rxvt OSC 777 with title `pi`; no bell, so terminals without OSC 9/777 support show nothing, as Claude Code does), `bell` (BEL only, the fallback for such terminals), `off`. One text per notification, no title except where OSC 777 requires one.

| Trigger | Timer | Cancelled by | Text |
|---|---|---|---|
| Main session settled (`onIdle`) with no source on the busy channel | `idleDelayMs` (default 20 000; deviation from Claude's 60 000 by decision D5, raised from 10 000 after the review because the notification also follows replies the user is only reading) with no keystroke since the settle | any keystroke; a new run starting; a busy source appearing | `pi is waiting for your input` |
| Busy channel empties while the session is idle (agents finished, no wake yet) | the same timer, armed then; the wake normally starts a run first, whose settle re-arms it | same | same |
| A dialog opens (`ui_prompt_start`, including agents' forwarded dialogs) | `dialogDelayMs` (default 6 000) since the later of the dialog's start and the last keystroke; each keystroke restarts it | `ui_prompt_end`; closing the session | `pi needs your input: <title>` |

Rules: once per settle (a settle that fired never fires again); evaluated at fire time (idle, no busy source, no dialog open, no keystroke since the settle); keystrokes are observed through `onTerminalInput` regardless of focus. The busy channel is the renamed `session-limits:busy` in `core/manager/channels.ts` (new neutral name `pi:busy`, same payload); subagents publishes on it while any agent is open, so the idle notification waits for agents.

Settings file `pi-notifications.json` (user `<agentDir>`, project `<cwd>/.pi/` when trusted): `channel` (`"auto"` | `"bell"` | `"off"`, default `"auto"`), `idleDelayMs` (default 20 000, range 0–600 000), `dialogDelayMs` (default 6 000, range 0–600 000).

Events that must not notify:

| Event | Reason |
|---|---|
| An agent finishes, fails, stops or hands off | the completion line and the idle notification cover it |
| A batch settles, a wake is delivered | the model's reply follows; the next settle notifies |
| A tool starts or ends, in main or in an agent | noise |
| The main turn ends, before the delay | the user is likely present |
| A child `notify` line, a `/agents` action, a stop, a worktree cleanup | user-initiated or informational |
| A forwarded dialog answered within 6 s, or any dialog while the user types | the user is present |
| Session shutdown, `rpc`, `print` or `json` modes | no terminal to notify |

## 9. Settings

| Setting | File | Change | Default | Range |
|---|---|---|---|---|
| `doneLingerMs` | `pi-subagents.json` | new: panel linger for `done` rows | 10 000 | 0–3 600 000 |
| `failedLingerMs` | `pi-subagents.json` | default lowered; panel linger for `failed`, `stopped`, `handoff` | 30 000 (was 60 000) | 0–3 600 000 |
| `lingerMs` | `pi-subagents.json` | meaning narrowed: list-view linger for every closed row | 30 000 | 0–3 600 000 |
| `agentsHintMs` | `pi-subagents.json` | new: footer `/agents to see agents` duration | 30 000 | 0–3 600 000 |
| `renderThrottleMs` | `pi-subagents.json` | now also governs the list, the view and the completion lines (the hard-coded 300 goes) | 250 | 0–10 000 |
| `stopGraceSeconds` | `pi-subagents.json` | unchanged | 60 | 0–3 600 |
| `notifications` | `pi-subagents.json` | removed | — | — |
| `channel` | `pi-notifications.json` | new | `"auto"` | `auto` / `bell` / `off` |
| `idleDelayMs` | `pi-notifications.json` | new | 20 000 | 0–600 000 |
| `dialogDelayMs` | `pi-notifications.json` | new | 6 000 | 0–600 000 |

Fixed constants, not settings: spinner frame period 100 ms; ticker 100 ms / 1 000 ms; `VERB_MS` 8 000; indicator rewrite 1 000 ms; `stopAllConfirmMs` 3 000; `No running agents` feedback 2 000 ms.

## 10. Removed features

- Progress widget header `Agents · N running · /agents to browse`: the panel has no header (D2).
- Progress widget rows with id, model, tool counts and `% ctx`: replaced by the Claude-style panel row (D2).
- Creation-order rows and indent-only nesting: replaced by tree order with connectors and `(+N)` (D2).
- Unlimited panel rows: replaced by the 5-row window with markers (D2).
- `run_agent` result rendered as fixed-width 120 agent rows with a frozen spinner: replaced by the block of section 3 (D1).
- Wake as a visible user message with full results inline: hidden custom message, plus a one-line `↳ 3 agents finished` user line only when the session was idle (D1, adapter plan §C).
- `/agents` list grouping `Working / Needs attention / Done / Failed / Closed` with `· count` headers: replaced by `Running / Needs input / Completed (n)` (D3).
- `/agents` `/` filter and its input line: removed, the list is short-lived (D3).
- `X` then `y` stop-all confirmation: replaced by `X` twice within 3 s (D3).
- List closing before the view opens: list and view share one overlay (D3).
- Agent view context breakdown (`c`): removed (D4).
- Agent view effective-prompt sections and `Tab`/`Enter`/`Space` on them: removed (D4).
- Agent view focus/verbose mode, `v`, and `pi-subagents-view.json`: removed (D4).
- Agent view message box, delivery status line and `route` from the UI: the user never types into an agent (D4, goal 2).
- Subagents `notifications` plugin, the `notifications` setting, per-batch / per-failure / per-dialog terminal notifications: replaced by the global notifications extension (D5).
- Busy channel name `session-limits:busy`: renamed `pi:busy` (D5).
- `formatTokens` duplicate in `footer/src/render.ts`, `REFRESH_MS` 300 in `components/refresh.ts`: replaced by the shared formatters and `renderThrottleMs`.
- Working indicator always visible during text streaming and its `75s` elapsed: replaced by phases and the shared duration formatter (D6).

## 11. Open points (resolved)

1. Model label: resolved. The transcript row names the model (` · <model>` dim, section 3); the panel and the list do not. The README sentence about "the progress row" changes to "the start block".
2. Panel markers: resolved. `↑ N more` / `↓ N more` stay separate lines; clarity over height.
3. Idle delay: resolved at `idleDelayMs` 20 000 after the review (10 000 before). The user asked to be told promptly when the work is done; the keystroke cancel covers a user who is typing, and `auto` sends no bell, so a notification after a reply the user is reading is a quiet banner. The setting exists for people who want it faster or slower.
4. Activity versus description: resolved. The description always stays; the activity is the first part of the stats column (section 4).
