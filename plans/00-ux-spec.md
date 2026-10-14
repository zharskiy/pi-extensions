# UX spec: Claude-alike subagents

Reviewed 2026-10-14: the wake line gets a `↳` glyph, the notification channel `auto` sends no bell, `idleDelayMs` is 20 000, the panel window keeps its top row on deselect, `Esc` in the list also cancels a pending stop-all, the token and duration formatters live in `core/manager/format.ts`, and the start block's spinner moves only on agent events (see `research/review-findings.md`). Revised 2026-10-14 (third pass): the `/agents` list keeps the agent tree in both of its sections (`Running`, `Completed (n)`; no `Needs input` section); agents are named by `<agent> › <description>` (§2 Identity); one padding rule set for every surface (§2 "Padding and margins", from `research/padding.md`); a shorter agent view hint. Revised 2026-10-14 (fourth pass): agents never ask the user for input; a child's dialogs resolve at once to their denial defaults and its `notify` is a no-op, so dialog forwarding, the `needs input` status and the record's `attention` field are gone (§2 Agents never ask, decisions D2, D3, D5). Revised 2026-10-14 (fifth pass): the idle wake is fully hidden; the `↳ N agents finished` user line is gone, since pi 1.2.0 keeps the main prompt for runs that a custom message starts (§3 "The wake").

Single source of truth for what the user sees and does. Follows `plans/research/decisions.md` (D1–D7); where this file is more precise, it wins. Strings in code spans are exact. Timings are in ms with their setting name. Mockups are 80 columns wide and draw the padding of §2 "Padding and margins" (a leading space is `PAD` or pi's `outputPad`; no text line reaches the last column; only `─` rules are 80 wide); `provider/model:high` stands for any model label. Nothing here names a provider or a model.

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

Spinner: the ten braille frames `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`, painted `accent`. The frame is `floor(now / 100) % 10` at render time, so every surface shows the same frame and no surface keeps a frame counter. Surfaces that need to animate while pi is otherwise idle run a shared ticker (`agentsTickMs`, fixed 100 ms, not a setting) while any record is `running` or `grace`; 1000 ms while only `queued` or closed rows are on screen; none when nothing is on screen.

Shared formatters (`formatTokens` and `formatDuration` live in `core/manager/format.ts` so the footer and the working indicator share them too; the subagents module re-exports them; the duplicates in `footer/src/render.ts` and `components/agent-row.ts` go):

- Tokens: `842`, `12.3k`, `1.2M` (one decimal from 1 000 up). With unit: `12.3k tokens`. A zero count is omitted wherever it is optional.
- Durations: `3s`, `1m 2s`, `1h 2m` (below one minute seconds only; below one hour minutes and seconds; from one hour hours and minutes). Never `75s`.
- Tool uses: `1 tool use`, `0 tool uses`, `4 tool uses`.
- Context: `23% ctx` (rounded percent of the agent's context limit), omitted when unknown.
- Agent counts: `1 agent`, `3 agents`.
- Separator inside stats: ` · ` (space, middle dot, space).
- Truncation: `…` as the last visible cell, measured in display columns, never in UTF-16 units.

Identity: what the user sees about an agent is its agent definition name (`record.agent`, e.g. `explorer`, with ` #2` for a later chain link), its description, its model, its state and its stats. The name and the description appear together everywhere an agent is named: transcript rows `explorer (Map the auth module)`, panel and list rows, the agent view header `explorer › Map the auth module`. The model label is shown on the transcript row (§3, `dim`) and on the agent view header's second line (§6), not on panel or list rows. The hex id (`explorer-3f2a9c1b7d0e`) is a handle for commands, not a label: it appears only on the agent view header (`id <id>` on its second line, the link ids of its chain line) and in command and status lines (`/agents <id>`, `Status unavailable · /agents <id>`, the `message_agent <id> …` call line), plus the model-facing task message `Task from <caller> (agent id <id>): …` that the view shows unchanged as its first transcript item.

### Padding and margins

Every surface follows one set of margins, so no text is glued to a display edge and the surfaces line up with pi's messages, editor and footer.

- Left pad: every line drawn in a widget or an overlay (the panel, the list, the agent view) starts with `PAD`, one column, like pi's widgets, pending list and status line, our footer and the composer's chevron. Transcript surfaces (the `run_agent` block) use pi's `outputPad` setting instead (0 or 1, default 1), so they line up with pi's messages and follow the user's setting.
- Right margin: the same width on the right. The content width is `inner = width - 2 * PAD` (transcript surfaces: `width - 2 * outputPad`); no text goes past column `width - 1 - PAD` (0-based), so the last column is always blank. Every cut is `truncateCols(text, inner - <prefix>)`, never `truncateCols(text, width)`.
- What `width` is: in a widget, the terminal width pi passes to the factory (pi adds no padding); in an overlay (`width: "100%"`, no frame), the terminal width; in a transcript block, the chat width pi passes to the component (pi does not pad a self-rendered block). The adapter's hard cut at `width` stays a safety net only; a correct line never reaches it.
- Columns inside the pad: column `PAD` holds the first cell of every line: title, section header, feedback, hint, view header, `▸ Request`, and the glyph (or tree connector) of every row and the panel's `↑ N more` / `↓ N more` markers. The selected row starts with `PAD`, then the pointer `›` and a space, then its tree and glyph: the row moves two columns right; every other row's glyph (or tree connector) is at `PAD`. No row text touches the display edge. A right-aligned part ends at `inner` (`alignRight`): `PAD + padEndCols(left, inner - displayWidth(right)) + right`, shown only when `displayWidth(left) + 2 + displayWidth(right) <= inner`; otherwise the right part is dropped and the line is `PAD + truncateCols(left, inner)`.
- Rules: `─` rules are chrome, not text, and run the full width, edge to edge, like pi's editor borders and dialogs. Only the agent view has one.
- Blank lines: a full-screen overlay (list and view) has one blank row at the top, one blank row at the bottom, and one blank row between its body window and the feedback/hint block, always reserved so the hint never moves. List: title, blank, first section; one blank between sections. View: header, rule, then `▸ Request`, then one blank (pi's spacer before the task message, which the transcript pane adds before every user message) in both states. Panel: no blank above (with the footer extension it sits under the footer block (which itself starts with one blank line so pi's command list never touches its first line), whose trailing blank line separates them; without it, the editor's bottom border does), no blanks between rows, markers and hint, and one trailing blank line so the panel never touches the bottom of the screen or pi's own footer.
- Wrapping: transcripts drawn by pi's components get the full `width` (pi already pads them by 1 on both sides; narrowing them would move their text to column 2 and break the alignment with `▸ Request`). The expanded Request JSON starts at `PAD + 2` and soft-wraps at `inner - 2` columns, continuations at `PAD + 2` too. The `run_agent` block is cut per line at `width - 2 * outputPad` with `…`, never wrapped, so tree rows keep their connectors.

`PAD`, `innerWidth(width)` and `alignRight(left, right, cols)` live in `extensions/subagents/src/components/format.ts` (plan 04) next to `truncateCols` and `padEndCols`; the panel, the list and the view import them.

### Agents never ask

Only the main session is interactive. A child's `confirm` resolves `false`, its `select` and `input` resolve `undefined`, all at once and without showing anything, and its `notify` does nothing, because the child binds no UI context (pi's no-op UI: `ctx.hasUI` is false, no `ui_prompt_*` events), so extensions take their headless branch (`core/adapter/pi-child.ts` binds `bindExtensions({ mode: "print" })` with no `uiContext`). The agent prompt tells the model that approvals are refused and blocked steps go in its result. An agent that needs a decision states it in its result. No state, word, colour or row variant signals a waiting dialog; there is no `needs input` anywhere. The main session's own dialogs are unchanged; they are the only dialogs §8 notifies about.

## 3. Surface A: main transcript

### `run_agent` block

One block per `run_agent` call. The tool call line draws nothing (the working line already shows the run); the tool result is the header and the rows. The block sits in pi's tool box (`renderShell: "box"`: pi-tui's `Box` with a blank line above, padding `outputPad` × 1, the geometry of a native tool; no `(ctrl+o to expand)` hint, no `Took Xs` footer, since each row has its own duration). The adapter indents every line by pi's `outputPad` and cuts it at `width - 2 * outputPad` with `…` (no wrapping), so the block lines up with pi's messages (§2 "Padding and margins"). The box background is one of pi's tool tokens and follows the batch, not the call: `toolPendingBg` (grey) while any agent of the batch is open, including a `wait: false` call that already returned; `toolSuccessBg` (green) once every agent is closed (stopped and handed-off agents count as success, their rows say so); `toolErrorBg` when the tool errored (`✗ No agents started`, an interrupted `wait: true` call) or, once every agent is closed, any agent failed. Without a registry record (after `/reload` or a resume) the box follows pi's own rule (grey while the call runs, green or red by its result) (deviation: pi turns a tool green as soon as the call returns; a background batch stays grey until its agents finish, so green means the agents are done). It re-renders through the stored `invalidate` at most every `renderThrottleMs` (default 250) after an `agent:changed` of its batch. It never schedules its own timer; pi caches a tool block between invalidations, so the rows advance only on agent events (the panel below the editor animates).

Header phases:

| Phase | Header line |
|---|---|
| Arguments streaming | nothing (the working line shows the run) |
| Tool running, `wait: true` | `3 agents launched` (`3` bold); `1 agent launched` singular |
| Tool running, `wait: false` | `3 background agents launched (← to manage)` from the first render, as in the next row |
| Returned, `wait: false`, at least one agent still open | `3 background agents launched (← to manage)` (`3` bold, hint `dim`) |
| Returned, `wait: false`, every agent closed | `3 background agents launched` (deviation: Claude keeps the hint; we drop it because there is nothing left to manage) |
| Returned, `wait: true` | `3 agents finished` (`3` bold) |
| Error result (nothing started) | `✗ No agents started: <first line of the error>` (`error`); the full error text when expanded with `Ctrl+O` |

When every agent of the batch has the same agent name, the header names it (as Claude Code does with the agent type): `3 explorer agents launched`, `3 background explorer agents launched (← to manage)`, `3 background explorer agents launched`, `3 explorer agents finished`; singular `1 explorer agent launched`, `1 background explorer agent launched (← to manage)`, `1 explorer agent finished`. The name is plain `text`, the count stays bold. Mixed batches keep the wording of the table. The rows are unchanged: each still reads `<agent> (<description>)` (deviation: Claude drops the type from same-type rows; we keep the name so a row reads the same in every batch).

Rows, one per agent of the batch, tree-connected under the header with `├─ ` and `└─ ` (last), continuation `│  ` / `   `:

- Line 1: `├─ explorer (Map the auth module) · provider/model:high` — `explorer` is `record.agent`, bold; with a chain, `explorer #2`; the description in parentheses, `muted`, cut with `…` so the line fits `BLOCK_WIDTH` (the adapter's per-line cut at `width - 2 * outputPad` handles narrower terminals); then ` · <model>` (`dim`, the resolved `provider/id:thinking` label, dropped first when the budget is short). Besides the agent view header (§6, line 2), this row is the only place that names the model; the panel and the list rows do not.
- Line 2 (status line, indented under the name) per state:

| State | Status line | Token |
|---|---|---|
| `queued` | `Queued` | `muted` |
| `running`, no turn ended yet, no tool started | `Initializing…` | `muted` |
| `running`, `wait: false` | `Running in the background` | `muted` |
| `running`, `wait: true` | `Running · 4 tool uses · 12.3k tokens` (live) | `muted` |
| `grace` | `Stopping…` | `warning` |
| `done` | `Done · 4 tool uses · 12.3k tokens · 1m 5s` | `Done` `success`, rest `dim` |
| `failed` | `Failed: <first line of error>` | `error` |
| `stopped` | `Stopped · 4 tool uses · 12.3k tokens · 1m 5s` | `muted` |
| `handoff` | `Handed off · 4 tool uses · 12.3k tokens · 1m 5s` | `warning` |

Closed worktree agents append ` · worktree removed`, ` · branch <branch> kept` or ` · worktree kept` (`dim`) to the status line once the cleanup outcome is known. A chain row follows the chain terminal; its stats sum the chain.

Live updates stop when the batch settles (`batch:settled`, after worktree cleanup). After a transcript rebuild (resume, `/reload`) with no registry record for the batch, the status line reads `Status unavailable · /agents <id>` (`dim`); the header keeps its last phase from the persisted result.

### No per-agent lines

The main transcript gets no per-agent line when an agent closes: the block's rows and colour are the record. Deviation: Claude Code prints a dim `Agent "…" finished · <duration>` notification per agent (`plans/research/claude-code-agents-ux.md:27`); removed at the user's request because the live block and the panel already carry it, and the wake never depended on them. After a resume the block reads `Status unavailable · /agents <id>`; the model's reply and `/agents <id>` carry the outcome. An interrupted `wait: true` call shows `✗ No agents started: Operation aborted`; the panel rows (`stopped`) show that agents did start.

### The wake

The batch text for the model always travels as a hidden custom message (`display: false`; see `plans/01-adapter-foundations.md` §C, `Host.sendHiddenMessage`). What the user sees depends on whether the main session is busy when the batch settles:

- Main session busy (the model is mid-run): the hidden message joins the run as a follow-up. The user sees nothing new; the model's reply simply takes the results into account.
- Main session idle: the hidden message starts the turn itself (pi 1.2.0 runs `before_agent_start` for it, so the main prompt stays intact; several batches held in the outbox start one turn together). Nothing new appears except the working indicator (section 7) and the model's reply; there is no user-message box.

In both cases the `run_agent` block's rows show each outcome and its header has lost `(← to manage)`.

### Unchanged

- `message_agent` call line `message_agent <id> <first 60 chars>` and its default-rendered result (`Message delivered to <id> (steer).` and the error strings) stay.
- `agent_status` call line and result stay.

### Mockups

Batch of 3 just launched (`wait: false`):

```
 3 background agents launched (← to manage)
 ├─ explorer (Map the auth module) · provider/model:high
 │  Initializing…
 ├─ worker (Fix the login redirect) · provider/model:medium
 │  Running in the background
 └─ reviewer (Review the diff of PR 5) · provider/model:high
    Queued
```

One leading space = pi's `outputPad` (1 by default) in every transcript mockup.

Same batch, one done:

```
 3 background agents launched (← to manage)
 ├─ explorer (Map the auth module)
 │  Done · 4 tool uses · 12.3k tokens · 1m 5s
 ├─ worker (Fix the login redirect)
 │  Running in the background
 └─ reviewer (Review the diff of PR 5)
    Running in the background
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

 The auth module lives in src/auth. The login redirect fix did not land:
 its tests failed twice; the reviewer found the diff of PR 5 clean. …
```

## 4. Surface B: agent panel

A widget below the editor (`belowEditor`), replacing the progress widget. No header line, no `/agents` text. Absent when it has no rows. With the footer extension the panel sits below the footer block (usage, session total, folder, branch, thinking, other extensions' statuses): the footer draws its block as the first below-editor widget (`setFooter(render, { slot: "belowEditor" })`) and leaves pi's footer slot empty; pi keeps below-editor widgets in the order they were first set, and the panel is set only once a row exists, after every extension's session start. Without the footer extension the panel sits directly under the editor, above pi's footer.

### Row grammar

```
<PAD>[› ]<tree><glyph> <name>[ (+N)]  <description>  [<activity> · ]<stats>
```

- `PAD`: one column (§2 "Padding and margins").
- `pointer`: on the selected row only, `› ` (`›` in `accent`, bold, then a space) after `PAD`; the glyph of an unselected root row is at `PAD`.
- `tree`: nothing for agents called by `main`; `├─ ` / `└─ ` (`dim`) for children under their caller, with `│  ` / `   ` continuation per level above. Rows are in tree order: callers first, children directly under them, siblings by `createdAt`. A row keeps its place when it closes.
- `glyph` + space: the state glyph in the state token (spinner while `running`).
- `name`: `record.agent`, `text` (`muted` on closed rows), with ` #2` for chain links after the first; `(+N)` (`dim`) is the number of open descendants of this agent; omitted when 0. The name column is padded to the widest visible name, capped at 24 columns, then two spaces.
- `description` (`muted`): always the agent's description, so two agents of the same kind stay distinguishable (deviation: Claude replaces it with the latest progress summary; we keep the description and put the activity in the stats column).
- `activity`: while `running`, the latest activity when known, shown as the first part of the stats: the last top-level tool name (`grep`, `bash`, `codemode`, …) or, when the last event was an assistant message, the word `writing`. It is `dim` like the stats and separated with ` · `. The record gains `activity?: { kind: "tool" | "text"; text: string; at: number }`; its `text` is the tool name or the first line of the assistant text (used by the agent view header later, not by the row).
- `stats`, right-aligned to `PAD + W` (ending one column before the last): `grep · 1m 5s · ↓ 12.3k tokens` (`dim`); the activity part only while `running` and known; tokens omitted when 0. Status words replace the stats: `queued` (`muted`), `stopping` (`warning`). Closed rows show `<word> · <duration>`: `done · 1m 5s`, `failed · 2m 10s`, `stopped · 3s`, `handed off · 1h 2m` (word in the state token, duration `dim`).

Column rule, from `W = width - 2 * PAD` (`innerWidth(width)`): fixed parts are the tree, glyph (2), name column, two spaces, and two spaces before the stats. The description gets the rest. If that is below 12 columns, drop the activity from the stats; if still below 12, drop the tokens; if still below 12, drop the elapsed too (status words stay); if still below 8, the description is omitted and the name is cut with `…`. Otherwise the description is cut with `…` to fit. A correct line ends at `PAD + W` (79 columns at width 80); the last column stays blank, and the adapter's hard cut at `width` is only a safety net.

### Window and markers

- At most 5 agent rows. With more rows, a dim `↑ N more` line precedes the first visible row and a dim `↓ N more` line follows the last visible row (either, both or none). The markers start in the glyph column (`PAD`), as Claude Code's do. The window scrolls by the minimum to keep the selected row visible. When the selection clears, the window keeps its top row (clamped to the row count); it never jumps back to the first row on its own.
- The hint line (below the rows and markers, at `PAD`, cut at `inner`) exists only while a row is selected.
- One blank line follows the panel's last line; there is no blank above the panel (the footer block's trailing blank line, or without the footer extension the editor's bottom border, separates it).
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
| `←` | Editor empty, no autocomplete, panel present: selects the first row. Otherwise the editor's own behaviour (a no-op cursor move on an empty editor; `←` has no history or autocomplete meaning). | Nothing happens (the key is consumed). |
| `↓` | The editor's own behaviour (history), nothing new. | Moves to the next row (clamped at the last). |
| `↑` | Editor's own behaviour (history). | Moves to the previous row; on the first row it deselects and focus stays in the editor. |
| `Enter` | Submits the editor. | Opens the agent view of the selected row (section 6) in an overlay; the selection clears. |
| `x` | Types `x`. | `running` or `queued`: stops the agent (a running agent enters grace; a queued one closes at once). `grace`: closes it now. Closed: clears the row. |
| `Esc` | pi's own behaviour (interrupt when busy). | Deselects. The main turn is never interrupted while a row is selected. |
| any other key | Editor. | The selection clears and the key goes to the editor (it is not swallowed). `→` is such a key: it deselects, and in an empty editor it is a no-op. `Esc` stays the documented deselect key. |

The panel never takes focus; the editor keeps it throughout. A new row appearing or a row leaving does not move the selection unless the selected row left, in which case the selection clears.

### Hint line

Only while a row is selected, `dim`, one line:

- running or queued row: `enter to view · x to stop · esc to deselect`
- grace row: `enter to view · x to close now · esc to deselect`
- closed row: `enter to view · x to clear · esc to deselect`

(deviation: Claude says `esc to collapse` and adds `ctrl+x ctrl+k to stop all agents`; we have no idle-collapse and stop-all lives in the list view.)

### Footer status

Revised 2026-10-14: the panel sets no footer status (no `N agents` counter, no `/agents to see agents` hint); it lists every open agent itself, and `←` opens the list.

### Refresh

Re-render on `agent:changed` throttled by `renderThrottleMs` (default 250), plus the shared ticker (section 2). Closed rows are cached by `id`, `version`, width and theme as today.

### Mockups

Two running (one is a worktree agent; the panel does not say so); one leading space = `PAD` = the glyph column, and the selected row has `› ` after `PAD` (pushing its glyph two columns in), the last column stays blank, and the trailing blank line is the panel's own:

```
 ⠹ explorer  Map the auth module                grep · 1m 5s · ↓ 12.3k tokens
 ⠹ worker    Fix the login redirect            bash · 2m 10s · ↓ 30.1k tokens

```

Seven agents, selection on the fourth, window scrolled (the name column is measured over all seven rows):

```
 ↑ 2 more
 ⠹ worker         Fix the login redirect       bash · 2m 10s · ↓ 30.1k tokens
 › ⠹ reviewer (+1)  Review the diff of PR 5     writing · 45s · ↓ 8.2k tokens
 └─ ⠹ explorer       Find callers of login         read · 12s · ↓ 1.1k tokens
 ○ worker         Rename parseDate callers                             queued
 ○ explorer       Find every date format in tests                      queued
 ↓ 1 more
 enter to view · x to stop · esc to deselect

```

One done row (it leaves 10 s after it finished; no countdown is shown):

```
 ⠹ worker    Fix the login redirect            bash · 2m 10s · ↓ 30.1k tokens
 ✓ explorer  Map the auth module                                 done · 1m 5s

```

One failed row, selected, with the hint line:

```
 › ✗ worker  Fix the login redirect                           failed · 2m 10s
 enter to view · x to clear · esc to deselect

```

Every row line is 79 columns at width 80 (`PAD + inner`).

## 5. Surface C: `/agents` list view

A full-screen overlay (`openOverlay`, width `100%`, max height `100%`). `/agents` opens the list; `/agents <id>` opens the view of that agent directly (manifest fallback, chains followed to the terminal, as today).

### Layout

```
(blank)
 Agents · 3 running · 3 done
(blank)
 Running
<rows: open roots, each with its descendants in tree order>
(blank)
 Completed (1)
<rows: closed roots, newest first, each with its descendants in tree order>
(padding to the height)
(blank, always reserved)
 <feedback line, only while shown>
 <hint line>
(blank)
```

- Every text line starts at `PAD` and is cut at `inner` (§2 "Padding and margins"); rows start at `PAD`, under the first letter of the section headers; the selected row has `› ` after `PAD`, pushing its glyph two columns in.
- Title `Agents` bold; subtitle (`dim`) ` · 3 running · 3 done`: `running` counts every open record (queued, running, grace), `done` counts the closed records listed (in either section; not only the roots). A zero part is omitted (`Agents · 3 running`). With no rows at all the body is one `muted` line `No agents running` and no subtitle.
- Two sections, headers bold: `Running` and `Completed (n)`, where `n` counts the closed roots. An empty section is not shown; one blank line between sections. There is no third section: every agent is either running or completed (agents never wait on the user, §2).
- The list shows the agent structure everywhere: a subagent is always under the agent that started it, in both sections. A root is a record whose caller is `main` or not in the registry; an open record whose caller is closed also counts as a root (rare: a caller normally outlives its children).
- `Running`: every open root, in tree order (callers first, children under them, siblings by `createdAt`) with the panel's connectors, with all its listed descendants under it, open or closed. A closed descendant renders as a closed row (`muted` name, state word and duration in the stats column) and keeps its tree position.
- `Completed (n)`: the closed roots, newest `endedAt` first, each followed by its closed descendants in tree order.
- Rows reuse the panel row grammar exactly (`PAD`, pointer, tree, glyph, name, `(+N)`, description, right-aligned activity and stats), at the overlay width with the §2 padding; one name column for the whole list.
- Scroll window: the rows between the title block and the reserved blank above the feedback/hint block, page keys as today, wheel in fullscreen TUI mode. The selection is kept visible.

### Lifecycle

Open records are always listed. A closed record under an open root stays listed for `lingerMs` (default 30 000) after its `endedAt`, and for as long as its caller is open; a listed record keeps its callers listed, so the structure is never torn. When a root closes, its whole subtree moves to `Completed` and lingers as one: it leaves `lingerMs` after the root's `endedAt`. Refresh as the panel (`agent:changed` throttled by `renderThrottleMs`, plus the shared ticker). A record that leaves while selected moves the selection to the next row, or clears it.

### Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Move the selection over rows (headers are skipped, clamped at both ends). |
| `PgUp` / `PgDn` | Scroll by a page. |
| `Home` / `End` | First / last row. |
| `Enter` | Open the selected agent's view inside this overlay (section 6). |
| `x` | Open row: stop (grace); grace row: close now; closed row: clear it from the list. A closed root in `Completed` is cleared with its whole subtree; a closed child is cleared alone (with its own closed descendants, so no row loses its caller). |
| `X` | Stop all: first press shows the feedback `Press X again to stop all agents`; a second `X` within `stopAllConfirmMs` (fixed 3 000) stops every open agent (each enters grace) and clears the feedback. With no open agent the feedback is `No running agents`. Any other key cancels the pending confirmation. |
| `Esc` | Close the overlay (a pending stop-all confirmation is cancelled as well). |

Feedback line: `warning` for `Press X again to stop all agents`, `muted` for `No running agents`; shown above the hint line for 3 000 ms (the confirmation window) or 2 000 ms (`No running agents`), then removed.

Hint line (`dim`, at `PAD`, 72 columns): `↑/↓ to select · enter to view · x to stop · X to stop all · esc to close`; with a closed row selected `x to clear`; with a grace row `x to close now`. Feedback and hint sit under the reserved blank row and above the overlay's bottom blank row.

### List and view in one overlay

`Enter` swaps the overlay's content to the agent view; the list keeps its selection and scroll position. `Esc` in a view opened this way swaps back to the list (the list reloads its rows). `Esc` in a view opened from the panel or from `/agents <id>` closes the overlay. The `/` filter and the `y` confirmation are gone.

### Mockup

A closed child under a running parent, a running child in its tree position, and a completed root with its child; one leading space = `PAD`, every row 79 columns at width 80:

```

 Agents · 3 running · 3 done

 Running
 ⠹ explorer     Map the auth module             grep · 1m 5s · ↓ 12.3k tokens
 › ⠹ worker (+1)  Fix the login redirect       bash · 2m 10s · ↓ 30.1k tokens
 ├─ ⠹ explorer     Find callers of login           read · 12s · ↓ 1.1k tokens
 └─ ✓ explorer     Find callers of parseDate                       done · 45s

 Completed (1)
 ✓ reviewer     Review the diff of PR 5                          done · 3m 2s
 └─ ✓ explorer     Collect the changed files                       done · 40s


 Press X again to stop all agents
 ↑/↓ to select · enter to view · x to stop · X to stop all · esc to close

```

## 6. Surface D: agent view

### Header

The overlay's top row is blank (§2 "Padding and margins"). Then the header lines, top to bottom, each at `PAD` and cut at `inner`, then a `dim` rule of `─` across the full width (edge to edge; rules are not inset):

1. `<glyph> <agent>[ #n] › <description>` (like Claude Code's `Explore › Map the auth module`): glyph in the state token (coloured, unlike today); agent name (`record.agent`) bold, with ` #n` for a chain link after the first (`explorer #2 › …`); ` › ` and the description plain `text`. The description is cut with `…` so the line fits `inner` (at least 8 columns of it; when even that does not fit, the line is cut at `inner`).
2. `<state word> · <model> · id <id>` (`dim`): state word from section 2 (`queued`, `running`, `stopping`, `done`, `failed`, `stopped`, `handed off`); the model label or `model n/a`; the hex id, the handle `/agents <id>` takes. Apart from the chain line (5), whose link ids open those links with `/agents <id>`, and the task message, this is the only place in the view that shows an id.
3. `4 tool uses · 12.3k tokens · 1m 5s · 23% ctx` (`dim`); live while open; `23% ctx` omitted when unknown.
4. Optional, `failed`: `error: <first line of error>` (`error`). Optional, `handoff`: `handoff: <path>[ (invalid: <reasons>)]` (`warning`).
5. Optional chain line (`dim`): `chain: <id> → <id> (2 sessions)`; when the opened id is not the terminal, ` · opened <id>` is appended.
6. Optional worktree line (`dim`): `worktree: <path> (branch <branch>)`, or after cleanup `worktree: removed`, `worktree: removed; branch <branch> kept`, `worktree: kept: <reason>`.

### Transcript

- Rendered with pi's own components (`UserMessageComponent`, `AssistantMessageComponent` with thinking hidden, `ToolExecutionComponent`, `CustomMessageComponent`) as today. Thinking is never shown.
- `Ctrl+O` (pi's `app.tools.expand` binding; the label comes from `keyText("app.tools.expand")`) toggles tool detail for every tool row; a left click on a tool row toggles that one call (pi's own per-call expansion, fullscreen TUI only). `Ctrl+O` resets per-call state, as in pi's main transcript. Collapsed previews stay pi's own (grep 15, read 10, bash 5 lines).
- Tool definitions for rendering: the eight built-ins plus `codemode` and `tool_search` captured from pi's exported factories, plus this extension's `run_agent`, `message_agent` and `agent_status` with the same `renderCall`/`renderResult` as the main session (so a nested `run_agent` shows the block of section 3 inside the agent's transcript). Every other tool keeps pi's generic fallback.
- Codemode, collapsed: the title `codemode`, the script syntax-highlighted with its first 10 visual lines and `… (N more lines, ctrl+o to expand)`, then the nested-call list (the last 8 calls, `… (N earlier calls, ctrl+o to expand)` above them), one per line: `<icon> <tool name> <args cut at 80> <duration>`, icons `…` (`warning`, running), `✓` (`success`), `✗` (`error`), `⊘` (`muted`, cancelled), then the output's first 5 visual lines. Expanded: the full script, every nested call, the full output, `Full output: <path>` when codemode truncated it.
- The task arrives as the user message `Task from <caller> (agent id <id>): …` and routed messages as `[message from <sender>]` user messages, unchanged.

### Task

The task the agent was given is always visible: the header's first line names the agent and its description, and the transcript's first item is the user message `Task from <caller> (agent id <id>): <task>`, rendered with pi's `UserMessageComponent`. Keep both; they are how the user checks what an agent was asked.

### Request

One block at the top of the body, before the first transcript item, so the user can test an agent definition against what the model actually received. It is the literal first provider request: the `providerPayload` of the prompt record (`pi-subagents:prompt-record`), the exact object pi handed to `before_provider_request` on the agent's first model call. Nothing is omitted or truncated: the system prompt, the tool list with schemas and the first messages are all there as the provider received them. Not a breakdown, no sections.

| State | Line (`dim`) |
|---|---|
| collapsed (default on every open; never persisted) | `▸ Request · 912 lines` |
| expanded | `▾ Request · 912 lines`, then the request |
| agent open, no `providerPayload` yet (the record arrives at the first `before_provider_request`, within the agent's first second) | `▸ Request · not sent yet` |
| agent closed, no `providerPayload` (manifest-only past agents, session files from before the upgrade) | `▸ Request · not recorded` |

- The count is the number of lines of `JSON.stringify(payload, null, 2)`.
- Expanded: that pretty-printed JSON as simple text (no syntax highlighting, no colour), every line starting at `PAD + 2` and soft-wrapped at `inner - 2` columns with plain wrapping (continuations at `PAD + 2` too; nothing reaches the last column), then the transcript, whose first item (the task message) brings its own blank line (pi's spacer) above it, as in the collapsed state.
- `r` toggles it. Expanding stops following and scrolls to the top (the block begins at line 0), so the request is read from its start. Collapsing scrolls to the tail and resumes following when the agent is open; a closed agent never follows, it only scrolls to the tail.
- On `not sent yet` and `not recorded`, `r` does nothing; the line still shows.
- A left click on the `▸ Request` / `▾ Request` line does the same as `r` (fullscreen TUI only); a click on the request's JSON does nothing.
- `Ctrl+O` does not affect the block.
- When the view shows a load error instead of a transcript (`session file not written yet`, `cannot read session: <message>`), the body is only that `warning` line at `PAD`; no Request line is drawn.

### Scrolling

Opens at the tail. Follows the tail while the agent is open and new content arrives. `↑`, `PgUp`, `Home`, a wheel-up, a click on a tool row or expanding the Request block with `r` stop following; `End` (or collapsing the Request block) scrolls to the tail and resumes following. A closed agent neither ticks nor follows.

### Hint line

One `dim` line at `PAD` near the bottom, under the reserved blank row and above the overlay's bottom blank row (an optional `warning` notice such as `stop failed: <message>` sits between the blank and the hint). The position `12-52/312` is right-aligned on the same line, ending at `inner` (column `width - 2`), and dropped when it does not fit (`alignRight`, §2); when not following, ` · end to follow` is appended to the position. The hint names no scroll keys: the arrows, page keys and wheel are implicit, and the position shows the scrolling.

Parts, in this order, joined with ` · `:

| Part | Text |
|---|---|
| leave | `esc to close` (opened from the panel or `/agents <id>`), `esc to go back` (opened from the list) |
| stop | `x to stop` (open), `x to close now` (grace); absent when closed |
| request | `r request` (collapsed), `r hide request` (expanded); absent when there is nothing to show (`not sent yet`, `not recorded`) |
| tools | `<toolsKey> tool detail` |

Examples: `esc to close · x to stop · r request · ctrl+o tool detail` (57 columns), `esc to go back · r hide request · ctrl+o tool detail`, `esc to close · x to stop · ctrl+o tool detail` (no request yet). `ctrl+o` is whatever `keyText("app.tools.expand")` returns.

### Keys

| Key | Action |
|---|---|
| `↑` / `↓` | Scroll one line (stops following / no effect on following). |
| `PgUp` / `PgDn` | Scroll one page. |
| `Home` / `End` | Top (stops following) / tail (resumes following). |
| `Ctrl+O` | Toggle tool detail. |
| `r` | Toggle the Request block: expand (stops following, scrolls to the top) / collapse (scrolls to the tail; resumes following when open). Nothing on `not sent yet` / `not recorded`. |
| `x` | Open: stop (grace); grace: close now; closed: nothing. |
| `Esc` | Back to the list when opened from it, else close the overlay. |
| wheel | Scroll (fullscreen TUI only). |
| click | Toggle that tool call's detail, or the Request block on its line (fullscreen TUI only). Stops following and keeps the clicked row in place. |

Every other key does nothing.

### Refresh

Transcript re-parse only when the session file's size or mtime changed, at most every `renderThrottleMs` (default 250) after a chain `agent:changed`; header stats and spinner through the shared ticker while the agent is open.

### Removed (planners delete)

The context breakdown and `components/context-breakdown.ts`; the effective-prompt sections (`system-prompt-block.ts`, `collapsible.ts`, the prompt record's `sections`, `tools`, `skills` and `guidelines` in the view), replaced by the single Request block (above), which reads only the record's `providerPayload`; the focus/verbose mode, `mode-store.ts` and the file `pi-subagents-view.json`; the message box, its status line and the view's `route` call; the keys `c`, `v`, `Tab`, `Space`; the `Transcript` and `Effective prompt` titles; the `agent closed, messages disabled` hint; the `Task: ` prefix on the description line.

### Mockup (running agent, codemode call collapsed)

One leading space = `PAD` (and pi's own transcript pad, which lands on the same column); the rule is the only full-width line:

```

 ⠹ explorer › Map the auth module
 running · provider/model:high · id explorer-3f2a9c1b7d0e
 4 tool uses · 12.3k tokens · 1m 5s · 23% ctx
────────────────────────────────────────────────────────────────────────────────
 ▸ Request · 912 lines

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



 esc to close · x to stop · r request · ctrl+o tool detail              1-19/19

```

The hint (57 columns) and the position (7) need `2 + 57 + 2 + 7 = 68` columns, so at 80 both fit and the position ends at column 78. The longest hint, `esc to go back · x to close now · r hide request · ctrl+o tool detail` (69 columns), keeps a position of up to 7 columns at 80; a longer position drops first: `1-14/940` (8) needs 81 columns, `1-14/940 · end to follow` (24) needs 97. Below 71 columns the hint itself is cut with `…`.

### Mockup (Request expanded, finished agent, after `r`; first lines)

```

 ✓ explorer › Map the auth module
 done · provider/model:high · id explorer-3f2a9c1b7d0e
 4 tool uses · 12.3k tokens · 1m 5s · 23% ctx
────────────────────────────────────────────────────────────────────────────────
 ▾ Request · 912 lines
   {
     "model": "provider/model",
     "system": "You are explorer, a read-only agent. Map the code you are point
   ed at and report entry points with file paths.\n\n# Tools\n...",
     "tools": [
       {
         "name": "read",
         "description": "Read a file. Returns its contents with line numbers.",
         "parameters": {
           "type": "object",
           "properties": {
             "path": {

 esc to close · r hide request · ctrl+o tool detail                    1-13/940

```

The `▸`/`▾` line starts at column `PAD` (1), aligned with pi's transcript text; request lines and their wrapped continuations start at column 3 (the `ed at and report…` line: plain wrapping cuts at the column, not at a word) and wrap at column 78, so nothing reaches the last column. The block ends without a blank of its own; the one blank line before the task is the transcript's spacer. The keys inside the JSON are whatever the request contains; the mockup's are illustrative.

## 7. Surface E: working indicator

The adapter computes a phase from pi's `turn_start`, `message_update`, `message_end`, `tool_execution_start/end`, `agent_end`, `agent_settled` events (assistant messages only; events with `parentToolCallId` ignored) and exposes `host.onPhase(phase, detail)`. The extension toggles `setWorkingVisible` and writes the message. pi draws the working line embedded in the editor's top rule after `───── ` (the composer frame's 3 rule columns in front of pi's `── `, so the spinner sits 3 columns right of the input text; the composer's editor is built with `embedWorkingStatus`), so it sits directly on the input with no gap; nothing else to change.

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

Nothing from child sessions affects the indicator: no child event, child tool, agent close, batch settle or busy-channel change may change the phase, the message, the clock or the visibility. The plan states and tests this.

## 8. Surface F: notifications

A new global extension `extensions/notifications/`. TUI mode only. Channels: `auto` (OSC 9; on rxvt OSC 777 with title `pi`; no bell, so terminals without OSC 9/777 support show nothing, as Claude Code does), `bell` (BEL only, the fallback for such terminals), `off`. One text per notification, no title except where OSC 777 requires one.

| Trigger | Timer | Cancelled by | Text |
|---|---|---|---|
| Main session settled (`onIdle`) with no source on the busy channel | `idleDelayMs` (default 20 000; deviation from Claude's 60 000 by decision D5, raised from 10 000 after the review because the notification also follows replies the user is only reading) with no keystroke since the settle | any keystroke; a new run starting; a busy source appearing | `pi is waiting for your input` |
| Busy channel empties while the session is idle (agents finished, no wake yet) | the same timer, armed then; the wake normally starts a run first, whose settle re-arms it | same | same |
| A main-session dialog opens (`ui_prompt_start`) | `dialogDelayMs` (default 6 000) since the later of the dialog's start and the last keystroke; each keystroke restarts it | `ui_prompt_end`; closing the session | `pi needs your input: <title>` |

Rules: once per settle (a settle that fired never fires again); evaluated at fire time (idle, no busy source, no dialog open, no keystroke since the settle); keystrokes are observed through `onTerminalInput` regardless of focus. The busy channel is the renamed `session-limits:busy` in `core/manager/channels.ts` (new neutral name `pi:busy`, same payload); subagents publishes on it while any agent is open, so the idle notification waits for agents.

Settings file `pi-notifications.json` (user `<agentDir>`, project `<cwd>/.pi/` when trusted): `channel` (`"auto"` | `"bell"` | `"off"`, default `"auto"`), `idleDelayMs` (default 20 000, range 0–600 000), `dialogDelayMs` (default 6 000, range 0–600 000).

Events that must not notify:

| Event | Reason |
|---|---|
| An agent finishes, fails, stops or hands off | the `run_agent` block, the panel and the idle notification cover it |
| A batch settles, a wake is delivered | the model's reply follows; the next settle notifies |
| A tool starts or ends, in main or in an agent | noise |
| The main turn ends, before the delay | the user is likely present |
| A `/agents` action, a stop, a worktree cleanup | user-initiated or informational |
| A dialog answered within 6 s, or any dialog while the user types | the user is present |
| Session shutdown, `rpc`, `print` or `json` modes | no terminal to notify |

## 9. Settings

| Setting | File | Change | Default | Range |
|---|---|---|---|---|
| `doneLingerMs` | `pi-subagents.json` | new: panel linger for `done` rows | 10 000 | 0–3 600 000 |
| `failedLingerMs` | `pi-subagents.json` | default lowered; panel linger for `failed`, `stopped`, `handoff` | 30 000 (was 60 000) | 0–3 600 000 |
| `lingerMs` | `pi-subagents.json` | meaning narrowed: list-view linger for every closed row | 30 000 | 0–3 600 000 |
| `agentsHintMs` | removed | the footer hint is gone; old files that still carry the key are ignored | none | none |
| `renderThrottleMs` | `pi-subagents.json` | now also governs the list and the view (the hard-coded 300 goes) | 250 | 0–10 000 |
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
- Wake as a visible user message with full results inline: hidden custom message that joins a busy run or starts the turn when idle, with no visible user line (D1, adapter plan §C).
- `/agents` list grouping `Working / Needs attention / Done / Failed / Closed` with `· count` headers: replaced by `Running / Completed (n)`, both in tree order (D3).
- `/agents` `/` filter and its input line: removed, the list is short-lived (D3).
- `X` then `y` stop-all confirmation: replaced by `X` twice within 3 s (D3).
- List closing before the view opens: list and view share one overlay (D3).
- Agent view context breakdown (`c`): removed (D4).
- Agent view effective-prompt sections and `Tab`/`Enter`/`Space` on them: removed, replaced by one collapsed Request block, key `r` (D4).
- Agent view focus/verbose mode, `v`, and `pi-subagents-view.json`: removed (D4).
- Agent view header led by the hex id: the header leads with `<agent> › <description>`; the id moves to the dim second line (§2 Identity).
- `↑/↓ to scroll` in the agent view hint: the position indicator shows scrolling (§6 Hint line).
- Forwarded agent dialogs (`<id> (<agent>) asks: <title>`, one serial queue in the main UI), child `notify` lines `<id> (<agent>): <message>`, the `needs input` status on rows, the `Needs input:` status line and the record's `attention` field: removed; a child's dialogs resolve to their denial defaults and its `notify` does nothing (§2 Agents never ask, D2).
- Agent view message box, delivery status line and `route` from the UI: the user never types into an agent (D4, goal 2).
- Subagents `notifications` plugin, the `notifications` setting, per-batch / per-failure / per-agent-dialog terminal notifications: replaced by the global notifications extension (D5).
- Busy channel name `session-limits:busy`: renamed `pi:busy` (D5).
- `formatTokens` duplicate in `footer/src/render.ts`, `REFRESH_MS` 300 in `components/refresh.ts`: replaced by the shared formatters and `renderThrottleMs`.
- Working indicator always visible during text streaming and its `75s` elapsed: replaced by phases and the shared duration formatter (D6).

## 11. Open points (resolved)

1. Model label: resolved. The transcript row names the model (` · <model>` dim, section 3) and so does the agent view header's second line (§6); the panel and the list rows do not. The README sentence about "the progress row" changes to "the start block". (deviation: Claude Code names the model on a transcript row only when the call overrides it; we always show it, because agent files pin their models and the user wants to see which one runs.)
2. Panel markers: resolved. `↑ N more` / `↓ N more` stay separate lines; clarity over height.
3. Idle delay: resolved at `idleDelayMs` 20 000 after the review (10 000 before). The user asked to be told promptly when the work is done; the keystroke cancel covers a user who is typing, and `auto` sends no bell, so a notification after a reply the user is reading is a quiet banner. The setting exists for people who want it faster or slower.
4. Activity versus description: resolved. The description always stays; the activity is the first part of the stats column (section 4).
5. Identity: resolved (§2 Identity, from `research/claude-code-agent-identity.md`). Agents are named by `<agent> › <description>` in the view header, and same-agent batches name the agent in the block header. Unchanged on purpose: the `Task from <caller> (agent id <id>): …` user message in the view, the default `message_agent` rendering, and `Status unavailable · /agents <id>`.
