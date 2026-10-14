# Plan 05: agent panel, keyboard selection, footer status, shared row/tree/refresh modules

Implements spec `plans/00-ux-spec.md` §4 (Surface B) and the footer status, replacing `plugins/progress-widget/`. Decisions from `plans/research/decisions.md` D2; module contracts from `plans/research/shared-modules.md` (this plan owns `components/refresh.ts`, `components/agent-row.ts`, `components/tree.ts`, settings `doneLingerMs`, `failedLingerMs`, `agentsHintMs`). Paths are relative to `extensions/subagents/` unless they start with `core/` or are repo docs.

Reviewed 2026-10-14: findings 1, 4, 9, 10, 11, 13, 26, 34, 41, 42 applied; decision P5 (window top kept). Finding 26 checked against the codebase: the `/agents <id>`, then `x` sentence is at `prompts/main-session.md:61` today and stays there after plan 04 (its prompt section keeps the line count), so §6 keeps `:61`. Revised 2026-10-14 (third pass): padding per spec §2 "Padding and margins" (`research/padding.md`): `PAD` and `innerWidth` come from plan 04's `format.ts`, rows end one column before the last, markers sit in the glyph column, the hint is cut at the inner width, and the panel ends with one blank line; `treeOrder`'s `roots` predicate is now used by plan 06's list. Revised 2026-10-14 (fourth pass): agents never ask the user, so the row has no `needs input` variant and the record no `attention` field (plan 04 §4 "Agents never ask").

## 1. Goal

1. A widget below the editor lists agents as Claude-style rows: glyph, name, description, right-aligned activity and stats; tree order with connectors and `(+N)`; at most 5 rows with `↑ N more` / `↓ N more` markers (spec §4 mockups: two running; seven agents scrolled; one done; one failed selected).
2. No header, no `/agents` text; the widget is absent without rows; `done` rows leave after `doneLingerMs`, `failed`/`stopped`/`handoff` after `failedLingerMs` or on `x`.
3. `↓` on an empty editor that is not browsing input history selects the first row (revised 2026-10-14; it was `←`, which now opens the `/agents` list, plan 06); `↑`/`↓` move; `Enter` opens the agent view; `x` stops/closes/clears; `Esc` deselects; any other key deselects and is typed (`←` is such a key, which then opens the list; `→` is too: it deselects, and in an empty editor it is a no-op; `Esc` stays the documented deselect key). The editor keeps focus; a selected row never lets `Esc` interrupt the main turn.
4. The footer status shows `3 agents` while any record is open, `/agents to see agents` for `agentsHintMs` after the last closes, then nothing.
5. One clock, one spinner: rows read `spinnerFrame(now)` and plan 04's formatters; the panel refreshes on `agent:changed` (throttled by `renderThrottleMs`) and the shared ticker (100 ms / 1000 ms / none).
6. Shared modules (`tree.ts`, `agent-row.ts`, `refresh.ts`) are pure and reused by plan 06's list view.
7. Depends on plan 01 §B (`HostUi.onEmptyEditorDown`, `HostUi.captureEditorKeys`, `KeyPress` names) and plan 04 (`format.ts`, `spinner.ts`, `state-text.ts`, `AgentRecord.activity`); calls `agentView.open(id, { from: "panel" })`, whose `AgentViewOrigin` type and optional `options` parameter this plan adds to `model/types.ts` (§3.3; plan 06 makes `options` required).
8. Everything stays in memory; nothing new is written to disk.

Deviations from the contract/spec, each justified where it appears: `nameColumn` takes tree rows, not records (§2.2); the closed-row cache key also includes the tree shape and name column (§3.2); `watchAgents` call sites in `agent-view` and `agent-list-view` get a one-line adaptation so `npm run check` stays green until plan 06 rewrites them (§2.3); today's row helpers move unchanged to a temporary `components/legacy-row.ts` that plan 06 deletes (§9 step 3); the window keeps its top row when the selection clears (decision P5, §3.1).

## 2. Shared modules

### 2.1 `src/components/tree.ts` (new)

```ts
import { type AgentRecord, isClosed } from "../model/types.ts";

export type TreeRow = { record: AgentRecord; depth: number; last: boolean; ancestorsContinue: boolean[]; openDescendants: number };

export const treeOrder = (records: AgentRecord[], roots?: (record: AgentRecord) => boolean): TreeRow[];
```

Rules (`records` is the input; nothing outside it exists for this function):

- Chain links: a record whose `successorId` names a record in the input is a link, never a row. The chain's row is its terminal (last link in the input). Its position is the first link's: sort key = `createdAt` of the earliest link reachable through `predecessorId` within the input; parent = that link's `callerId` (all links share it). Children whose `callerId` is any link of the chain attach to the chain's row. Reason: the row keeps its place when the agent hands off, and `#n` on the name tells the story.
- Parent of a row = the row whose chain contains `record.callerId`. A row whose parent is not in the input is a root (`depth` 0), including `callerId === "main"`. `roots`, when given, forces matching records to depth 0 regardless of their caller (plan 06's list uses it for an open record whose caller is closed; the panel does not).
- Order: depth-first; roots sorted by sort key, then each root's children (sorted by sort key) directly under it, recursively.
- `depth` is the tree depth (0 for roots), not `record.depth`.
- `last`: the row is the last child of its parent (roots: last root). `ancestorsContinue[k]` for `k < depth - 1`: whether the ancestor at depth `k + 1` is not `last`. Connector for a row at depth ≥ 1 = `ancestorsContinue.map(c => c ? "│  " : "   ").join("") + (last ? "└─ " : "├─ ")`; depth 0 has no connector. Width = `3 * depth`.
- `openDescendants`: number of rows in the subtree (excluding the row itself; links are not rows) whose `record.state` is not closed.

Implementation sketch: `byId = new Map(records.map(r => [r.id, r]))`; `rowKey(id)` walks `successorId` while the successor is in the map (terminal id); `firstLink(id)` walks `predecessorId` likewise; `terminalIds = records.filter(r => !r.successorId || !byId.has(r.successorId))`; `parentRow(terminal) = roots?.(terminal) ? undefined : rowKey(firstLink(terminal).callerId) if that id is in the map`; build `children: Map<string | undefined, AgentRecord[]>` keyed by parent terminal id, sorted by `firstLink(r).createdAt`; recursive `walk(parentId, depth, continues)` emits rows and returns the open count. Cycles cannot occur (ids are unique and chains are linear).

Tests `test/components/tree.test.ts` (fixture builder `rec({ id, callerId, createdAt, state, successorId, predecessorId, chainIndex })`):

- `"orders callers first, children under their caller and siblings by createdAt"`: `a(main, 10)`, `b(main, 5)`, `c(caller a, 7)`, `d(caller a, 6)` → ids `[b, a, d, c]`, depths `[0, 0, 1, 1]`, `last` `[false, true, false, true]`.
- `"marks continuation per ancestor level"`: `a`, `b` (children of main), `a1` (child of a), `a1x` (child of a1) → `a1x.ancestorsContinue` is `[true]` (a is not last), `a1.ancestorsContinue` is `[]`.
- `"renders a child whose caller is absent at depth 0"`: input `[c(caller "gone")]` → one row, depth 0, `ancestorsContinue` `[]`.
- `"collapses a chain to its terminal at the first link's position"`: `a(main, 1, handoff, successorId a2)`, `b(main, 2)`, `a2(main, 9, predecessorId a, chainIndex 2)` → ids `[a2, b]`; `a2` is depth 0.
- `"attaches children of any chain link to the chain row"`: child `k(caller a)` with the chain above → `k` is depth 1 under `a2`; `a2.openDescendants` is 1 while `k` runs, 0 after `k` is done.
- `"counts open descendants over the whole subtree"`: `a → a1 → a1x` (a1 done, a1x running) → `a.openDescendants` 1, `a1.openDescendants` 1.
- `"honours a roots predicate"`: `roots = r => r.id === "a1"` → `a1` at depth 0 after `a`'s subtree, not under it.
- `"returns an empty list for no records"`.

### 2.2 `src/components/agent-row.ts` (rewrite; plan 04 already removed `SPINNER_FRAMES`, `STATE_ICONS`, `STATE_COLORS`, `formatTokens`, `formatElapsed`, `elapsedOf`, `singleLine`, `plural` and moved `elapsedOf` to `format.ts`; what plan 04 kept (`stateIcon`, `finishSummary`, `progressText`, `truncate`, `chainLabel`, `graceSecondsLeft`, `agentRow`, `treeRow`; `attentionText` is already gone with plan 04 §4 "Agents never ask") moves unchanged to `components/legacy-row.ts` (§9 step 3) and is not part of the new file)

```ts
import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { displayWidth, elapsedOf, formatDuration, formatTokens, innerWidth, PAD, padEndCols, SEP, singleLine, truncateCols } from "./format.ts";
import { stateGlyph, stateToken, stateWord } from "./state-text.ts";
import type { TreeRow } from "./tree.ts";
import { type AgentRecord, isClosed } from "../model/types.ts";

export const NAME_COLS_MAX = 24;
export type RowInput = TreeRow & { selected: boolean };
export const rowName = (row: Pick<TreeRow, "record" | "openDescendants">): string;   // `explorer`, `explorer #2`, `reviewer (+1)`, `explorer #2 (+1)`
export const nameColumn = (rows: Pick<TreeRow, "record" | "openDescendants">[]): number;  // max displayWidth(rowName), capped at 24; 0 for no rows
export const renderRow = (input: RowInput, now: number, width: number, theme: ThemeLike, nameCols: number): string;
```

`elapsedOf(record, now)` = `(endedAt ?? now) - (startedAt ?? createdAt)`, `singleLine` and `firstLine` are plan 04's, in `format.ts`; none is redefined here (spec §1 principle 6: one set of formatters).

Deviation: the contract says `nameColumn(records: AgentRecord[])`, but `(+N)` is a tree fact, so it takes `{ record, openDescendants }[]` (a `TreeRow[]` works as is). Plan 06 calls it with its tree rows. The panel measures the column over every lifecycle-visible row (not just the 5 in the window) so columns do not shift while scrolling.

Padding (spec §2 "Padding and margins"): every panel line (rows, markers, hint) starts with `PAD`, imported from `format.ts` (plan 04 owns it; this module does not export one), and the row grammar gets `W = innerWidth(width)` columns, so the last column stays blank.

`renderRow` algorithm (plain strings; theme applied at the end; every width in display columns via `displayWidth`):

1. Parts: `pointer` = `› ` (`theme.fg("accent", theme.bold("›")) + " "`) when `selected`, else `"  "`. `tree` = connector from `depth`/`last`/`ancestorsContinue` (§2.1), painted `dim`. `glyph` = `stateGlyph(record.state, now)` painted `stateToken(record.state)` (the spinner is `accent`), then a space. `name` = `rowName(row)`; painted `text` (closed rows: `muted`), with the `(+N)` part `dim`. `description` = `singleLine(record.description)` (from `format.ts`), `muted`.
2. Stats candidates, most to least complete, computed by `statsVariants(record, now)`:
   - closed: one candidate, `stateWord(state) + SEP + formatDuration(elapsedOf)`; word in `stateToken(state)`, duration `dim`.
   - `grace`: `["stopping"]` (`warning`). `queued`: `["queued"]` (`muted`).
   - `running`: `activity` = `record.activity.text` when `kind === "tool"`, `writing` when `kind === "text"`, none when unset; `elapsed` = `formatDuration(elapsedOf)`; `tokens` = `↓ ${formatTokens(record.tokens)} tokens` when `tokens > 0`. Candidates: `[join(activity, elapsed, tokens), join(elapsed, tokens), elapsed, ""]` (`join` drops missing parts and uses `SEP`). All `dim`.
3. Column rule with `W = innerWidth(width)` (`width - 2`) and `fixed = 2 + displayWidth(tree) + 2 + nameCols + 2`: for each candidate `stats` in order, `room = W - fixed - (stats ? 2 + displayWidth(stats) : 0)`; take the first candidate with `room >= 12`. If none qualifies, keep the last candidate (status words and closed stats are never dropped) and its `room`.
4. `room >= 8`: line = `PAD + pointer + tree + glyph + " " + padEndCols(name, nameCols) + "  " + description part + tail`, where the description part is `padEndCols(truncateCols(description, room), room)` when `stats` is non-empty (so the stats are right-aligned to `PAD + W`, ending at column `width - 2`), or `truncateCols(description, room)` without padding when `stats` is empty; `tail` = `"  " + stats` or `""`.
5. `room < 8`: the description is omitted; `nameRoom = W - 2 - displayWidth(tree) - 2 - (stats ? 2 + displayWidth(stats) : 0)`; line = `PAD + pointer + tree + glyph + " " + padEndCols(truncateCols(name, nameRoom), nameRoom) + tail`.
6. Painting never changes widths: measure plain parts, then wrap each part with `theme.fg`/`theme.bold`. The adapter's hard cut at `width` is a safety net only; a correct line is exactly `width - 1` columns when stats are present and never longer.

Tests `test/components/agent-row.test.ts` (rewrite; `plainTheme`; fixture `rec(patch)` with `agent: "explorer"`, `callerId: "main"`, `chainIndex: 1`, `createdAt: 0`, `startedAt: 0`, `tokens: 0`, `state: "running"`; `row(record, patch)` with `depth: 0`, `last: true`, `ancestorsContinue: []`, `openDescendants: 0`, `selected: false`; spinner frame at the chosen `now` values is `⠋`):

| test | input (`now`, `nameCols`) | width | expected line |
|---|---|---|---|
| `"renders a running row with activity, elapsed and tokens at 80 columns"` | explorer, "Map the auth module", tokens 12 300, activity tool `grep` (65 000, 8) | 80 | `"   ⠋ explorer  Map the auth module                grep · 1m 5s · ↓ 12.3k tokens"` |
| `"cuts the description before dropping stats"` | same | 60 | `"   ⠋ explorer  Map the auth…  grep · 1m 5s · ↓ 12.3k tokens"` |
| `"drops the activity, then the tokens, when the description would fall below 12 columns"` | same | 40 | `"   ⠋ explorer  Map the auth mod…  1m 5s"` |
| `"drops the elapsed too and keeps the description"` | same | 30 | `"   ⠋ explorer  Map the auth …"` |
| `"shows queued as the status word"` | worker, "Rename parseDate callers", queued (65 000, 6) | 80 | `"   ○ worker  Rename parseDate callers                                    queued"` |
| `"keeps the status word on a narrow row"` | same | 30 | `"   ○ worker  Rename …  queued"` |
| `"shows done with the duration"` | explorer, "Map the auth module", done, endedAt 65 000 (99 000, 8) | 80 | `"   ✓ explorer  Map the auth module                                 done · 1m 5s"` |
| `"omits the description and pads the name when fewer than 8 columns remain"` | same | 30 | `"   ✓ explorer    done · 1m 5s"` |
| `"marks the selected row with the pointer"` | worker, "Fix the login redirect", failed, endedAt 130 000, selected (200 000, 6) | 80 | `" › ✗ worker  Fix the login redirect                             failed · 2m 10s"` |
| `"shows stopping during grace"` | worker, "Fix the login redirect", grace (130 000, 6) | 80 | `"   ◐ worker  Fix the login redirect                                    stopping"` |
| `"appends the chain index to the name"` | explorer, chainIndex 2, "Map the auth module", tokens 30 100, activity tool `bash` (130 000, 11) | 80 | `"   ⠋ explorer #2  Map the auth module            bash · 2m 10s · ↓ 30.1k tokens"` |
| `"draws the connector of a last child"` | explorer, "Find callers of login", tokens 1 100, activity tool `read`, depth 1, last (12 000, 13) | 80 | `"   └─ ⠋ explorer       Find callers of login         read · 12s · ↓ 1.1k tokens"` |
| `"draws continuation bars for deeper rows"` | same, depth 2, last false, ancestorsContinue `[true]` | 80 | `"   │  ├─ ⠋ explorer       Find callers of login      read · 12s · ↓ 1.1k tokens"` |
| `"shows open descendants and writing"` | reviewer, "Review the diff of PR 5", tokens 8 200, activity text, openDescendants 1, selected (45 000, 13) | 80 | `" › ⠋ reviewer (+1)  Review the diff of PR 5       writing · 45s · ↓ 8.2k tokens"` |
| `"omits zero tokens"` | explorer, "Map the auth module", tokens 0, no activity (3 000, 8) | 80 | `"   ⠋ explorer  Map the auth module                                           3s"` |
| `"paints the parts with the theme tokens"` | failed selected row with a recording theme (`fg: (t, s) => `<${t}>${s}``) | 80 | contains `<accent>›`, `<error>✗`, `<muted>worker`, `<error>failed`, `<dim>2m 10s` |
| `"measures the name column over names, chain suffixes and counts, capped at 24"` | `nameColumn` over rows `explorer`, `explorer #2 (+3)`, a 40-char agent name | — | `8`, `16`, `24` for the cumulative inputs |
| `"collapses whitespace in the description"` | description `"a\n  b"` | 80 | contains `a b` |

Every expected line is asserted with `displayWidth(line)` equal to `width - 1` when stats are present (79 at width 80: one leading `PAD`, the last column blank), and every line starts with `" "`. New: `"ends every line before the last column"` (each case above at widths 80, 60, 40, 30, 20: `displayWidth(line) <= width - 1` and the line starts with `PAD`).

### 2.3 `src/components/refresh.ts` (rewrite)

```ts
export const createThrottle = (run: () => void, intervalMs: () => number): { call(): void; cancel(): void };
export const watchAgents = (bus: Bus, watch: {
  relevant(record: AgentRecord): boolean;
  tickMs(): number | undefined;
  throttleMs(): number;
  onChange(): void;
}): () => void;
```

- `createThrottle`: today's semantics (leading call, one trailing call at `last + intervalMs()`), returned as `{ call, cancel }` per the contract (callers of the old callable shape: only the deleted widget).
- `watchAgents`: `throttled = createThrottle(watch.onChange, watch.throttleMs)`; `bus.on("agent:changed")` → when `relevant(record)`: `throttled.call()` then `arm()`. Ticker: a self-rescheduling `setTimeout` chain, never `setInterval`: `arm()` reads `wanted = watch.tickMs()`; if `wanted === armedMs` nothing happens; otherwise clear the pending timer, `armedMs = wanted`, and when `wanted` is a number schedule `tick` after `wanted`; `tick` sets `armedMs = undefined`, calls `watch.onChange()`, then `arm()`. Every timer is `.unref()`'d (a lingering widget must not keep the process alive). The unsubscribe removes the bus listener, cancels the throttle and clears the timer. Drop `REFRESH_MS` and `TICK_MS`.
- Call-site adaptation until plan 06 lands (two lines each, behaviour-preserving): `plugins/agent-view/index.ts:173` → `watchAgents(bus, { relevant: (record) => inChain(record, id), tickMs: () => (ticking() ? 1_000 : undefined), throttleMs: () => settings.renderThrottleMs, onChange })`; `plugins/agent-list-view/index.ts:13-17` the same with its `ticking` predicate and `settings` added to the destructured context. Plan 06 replaces both.

Tests `test/components/refresh.test.ts` (rewrite; fake timers as today):

- `"runs at most once per interval and keeps a trailing call"` (today's test on `.call()`).
- `"cancel drops the trailing call"`.
- `"throttles relevant changes by throttleMs and ignores irrelevant ones"`: `throttleMs: () => 250`; two relevant emits → one call, trailing at 250 ms; an irrelevant emit → nothing.
- `"ticks every 100 ms while tickMs says so and re-arms at 1000 ms when it changes"`: `tickMs` returns 100 → after 1 000 ms 10 ticks; switch to 1 000 and emit a relevant change → the next tick comes 1 000 ms later and then every 1 000 ms.
- `"stops ticking when tickMs returns undefined and resumes on the next change"`.
- `"unrefs the ticker"`: spy `vi.spyOn(global, "setTimeout")` is not reliable under fake timers; instead assert the returned timer object's `unref` was called by wrapping `setTimeout` through `vi.stubGlobal` with a recorder for the duration of the test.
- `"clears everything on unsubscribe"`.

## 3. The panel plugin: `src/plugins/agent-panel/`

Delete `src/plugins/progress-widget/` (`index.ts`, `model.ts`) and `test/plugins/progress-widget/`. Add the new folder with `index.ts`, `model.ts`, `keys.ts`. Register `agentPanelPlugin` in `src/plugins.ts` in the slot of `progressWidgetPlugin`.

Constants: `WIDGET_KEY = "pi-subagents-agents"`, `STATUS_KEY = "pi-subagents"`, `WINDOW = 5`, `TICK_RUNNING_MS = 100`, `TICK_IDLE_MS = 1_000`.

### 3.1 `model.ts` (pure, no host)

```ts
export type PanelSettings = Pick<Settings, "doneLingerMs" | "failedLingerMs">;
export type PanelState = { selectedId?: string; top: number; cleared: Set<string> };
export const createPanelState = (): PanelState;
export const isVisible = (record: AgentRecord, now: number, settings: PanelSettings, cleared: ReadonlySet<string>): boolean;
export const panelRows = (records: AgentRecord[], now: number, settings: PanelSettings, cleared: ReadonlySet<string>): TreeRow[];
export const selectedIndex = (rows: TreeRow[], state: PanelState): number;           // -1 when nothing selected or gone
export const reconcile = (rows: TreeRow[], state: PanelState): { deselected: boolean };  // clears a selection whose row left; clamps top
export const windowOf = (rows: TreeRow[], state: PanelState): { start: number; end: number; above: number; below: number };
export const hintText = (record: AgentRecord, actions: { view: boolean; stop: boolean }): string;
export const panelLines = (rows: TreeRow[], state: PanelState, now: number, width: number, theme: ThemeLike, row: RowRenderer, actions): string[];
export const createClosedRowCache = (): RowRenderer & { prune(rows: TreeRow[]): void };
```

- `isVisible`: open states always; `done` while `now - endedAt < doneLingerMs`; `failed`/`stopped`/`handoff` while `now - endedAt < failedLingerMs` and `!cleared.has(id)`. A missing `endedAt` counts as `now`.
- `panelRows`: `visible = records.filter(isVisible)`; `links` = every record reachable through `predecessorId` from a visible record (walk the full `records` map); `treeOrder([...visible, ...links])`, then keep rows whose `record` is visible (links never become rows; a lingered-out predecessor still anchors the chain's position). Children whose parent lingered out render at depth 0 (tree rule).
- Selection is by id. `reconcile`: `selectedId` not among the rows → `selectedId = undefined`, return `{ deselected: true }` (after the clamp below). Otherwise scroll by the minimum to keep it visible: `index < top` → `top = index`; `index >= top + WINDOW` → `top = index - WINDOW + 1`. In every case finally `top = clamp(top, 0, max(0, rows.length - WINDOW))`. Decision P5: when the selection clears (`Esc`, a typed key, the selected row leaving) the window keeps its top row, clamped to the row count, instead of jumping back to 0; the window moves only to keep a selection visible. With nothing selected `top` is therefore only clamped.
- `windowOf`: `start = top`, `end = min(rows.length, top + WINDOW)`, `above = start`, `below = rows.length - end`.
- `hintText(record, actions)`: parts `enter to view` (only when `actions.view`), the `x` part (only when `actions.stop` or the row is closed): closed → `x to clear`, `grace` → `x to close now`, else `x to stop`; then `esc to deselect`; joined with `SEP`. With both actions available this yields exactly the spec's three lines.
- `panelLines`: `nameCols = nameColumn(rows)`; lines = [`PAD + "  " + dim("↑ N more")` when `above > 0`] + window rows through `row({ ...treeRow, selected: treeRow.record.id === selectedId }, now, width, theme, nameCols)` + [`PAD + "  " + dim("↓ N more")` when `below > 0`] + [`PAD + dim(truncateCols(hint, innerWidth(width)))` while a row is selected] + [`""`, the trailing blank line so the footer does not touch the panel]. The markers start in the glyph column (`PAD + 2`, as Claude Code's do). Empty rows → `[]` (no trailing blank without rows).
- `createClosedRowCache`: `cache: Map<id, { key: string; theme: ThemeLike; line: string }>`; open rows always re-render; closed rows reuse the line when `theme` is the same object and `key` equals `${version}|${width}|${selected}|${depth}|${last}|${ancestorsContinue.join("")}|${openDescendants}|${nameCols}` (today's id/version/width/theme, plus selection, and the tree facts that change the line without a version bump). `prune(rows)` deletes ids not in `rows`.

### 3.2 `keys.ts`

```ts
export type PanelActions = {
  rows(): TreeRow[];
  state: PanelState;
  refresh(): void;
  view?: (id: string) => void;           // undefined without agent-view
  stop?: (id: string) => void;           // undefined without run-agent
  release(): void;                       // drops the capture (idempotent)
};
export const panelKeyHandler = (actions: PanelActions): EditorKeyHandler;
export const selectFirst = (actions: PanelActions): boolean;   // false when there are no rows
```

`panelKeyHandler` returns `(key) => "consumed" | "release"`:

| `key.name` / `char` | action | returns |
|---|---|---|
| `down` | `index = selectedIndex`; `selectedId = rows[min(index + 1, rows.length - 1)].id`; `refresh()` | `consumed` |
| `up` | `index === 0` → `selectedId = undefined`, `release()`; else `selectedId = rows[index - 1].id`; `refresh()` | `consumed` |
| `enter` | `id = selectedId`; `selectedId = undefined`, `release()`, `refresh()`; `view?.(id)` | `consumed` |
| `char === "x"` | record = selected row's record: closed → `state.cleared.add(id)`, `refresh()` (the row leaves; `reconcile` deselects and releases); open → `stop?.(id)` (the runner decides: `running` → grace, `queued` → closed at once, `grace` → closed now, `stopGraceSeconds: 0` → at once); nothing without `stop` | `consumed` |
| `escape` | `selectedId = undefined`, `release()`, `refresh()` | `consumed` |
| anything else | `selectedId = undefined`, `refresh()` (the adapter drops the capture itself on `release`; `release()` is still called for its bookkeeping) | `release` |

`selectFirst`: `rows()` empty → `false`; else `selectedId = rows[0].id`, `top = 0`, `refresh()`, `true`.

### 3.3 `index.ts`

```ts
export const agentPanelPlugin: Plugin = {
  id: "agent-panel",
  requires: ["agent-registry"],
  enable: ({ host, bus, settings, services }) => { … },
};
```

Optional services, read once at enable: `view = services.has("agentView") ? (id) => void services.require("agentView").open(id, { from: "panel" }) : undefined`; `stop = services.has("runner") ? (id) => void services.require("runner").stop(id) : undefined`. Degraded behaviour: without `agent-view`, `Enter` deselects and does nothing, and the hint has no `enter to view`; without `run-agent`, `x` on an open row does nothing and the hint has no `x to stop`/`x to close now` (`x to clear` on closed rows still works). `services.require` is never called for an absent service.

State: `state = createPanelState()`, `rowCache = createClosedRowCache()`, `handle: WidgetHandle | undefined`, `shownSignature = ""`, `capture: (() => void) | undefined`.

- `rows()` = `panelRows(registry.list(), Date.now(), settings, state.cleared)`.
- `release()`: `capture?.()`, `capture = undefined`.
- `install()`: `capture = host.ui.captureEditorKeys(panelKeyHandler(actions))` (replaces an existing capture first via `release()`).
- `refresh()`: `current = rows()`; `rowCache.prune(current)`; `reconcile(current, state).deselected` → `release()`. No rows → `setWidget(WIDGET_KEY, undefined)` when `handle` is set, `handle = undefined`, `shownSignature = ""`, return. Else `handle ??= host.ui.setWidget(WIDGET_KEY, (width, theme) => panelLines(rows(), state, Date.now(), width, theme, rowCache, actionsAvailable))` (the render closure recomputes rows and reads the clock on every TUI render, as today). Signature skip: when every row is closed, `signature = ids@version joined + "|" + selectedId + "|" + top`; equal to `shownSignature` → return without `handle.refresh()`. Output skip: once the closure has rendered, it keeps `lastWidth`, `lastTheme`, `lastOutput` (the joined `panelLines` string) and `lastLines`; `refresh()` computes `panelLines(current, state, Date.now(), lastWidth, lastTheme, rowCache, actionsAvailable).join("\n")` and, when it equals `lastOutput`, returns without `handle.refresh()`; the closure itself returns `lastLines` (same array) when its joined output equals `lastOutput`. Otherwise store and `handle.refresh()`.
- `tickMs()`: rows empty → `undefined`; any row `running` or `grace` → 100; else 1 000. The 1 000 ms tick also retires lingered rows (a closed row leaves within one tick of its linger end; the exact instant is not observable and tests use the fake clock).
- `unwatch = watchAgents(bus, { relevant: () => true, tickMs, throttleMs: () => settings.renderThrottleMs, onChange: refresh })`.
- `offDown = host.ui.onEmptyEditorDown(() => { if (selectFirst(actions)) install(); })`. Registered at enable (returns a no-op remover when another extension owns the editor; the panel then has no keyboard selection, as plan 01 §B says).
- Footer status (§4) wired here too.
- Disable: `offDown()`, `release()`, `unwatch()`, footer timer cleared, `setStatus(STATUS_KEY, undefined)`, and `setWidget(WIDGET_KEY, undefined)` when a handle exists.

Why keys in the panel call `refresh()` synchronously: a key must be reflected on the next TUI render, and `refresh()` is cheap (one `registry.list()` pass); the throttle applies to bus storms only.

Render cost (review finding 34): the render closure runs `panelRows` (a full `treeOrder`) on every TUI render, and the ticker asks for a render every 100 ms while any agent runs, even when the main session is idle (today's widget renders at most once a second when idle). Acceptable for the expected ≤ 20 records. The output skip above keeps pi's diff cheap: a tick or change that leaves the joined `panelLines` string unchanged (queued rows, lingering closed rows, a bus event that changes nothing visible) causes no `handle.refresh()`, and a render with unchanged output hands back the previous lines.

## 4. Footer status

Lives in `agent-panel/index.ts`. Two-line justification: the hint timer is a linger timer like the rows' (same clock, same unref/disable discipline, same settings file), and `agent-registry` has no UI and no timers today; keeping it data-only means a user who disables the panel also drops the footer pill, which is consistent (no panel, no pill).

```ts
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let shownStatus: string | undefined;
const setStatus = (text: string | undefined) => { if (text !== shownStatus) { shownStatus = text; host.ui.setStatus(STATUS_KEY, text); } };
const updateStatus = () => {
  const open = registry.list().filter((record) => !isClosed(record.state)).length;
  if (open > 0) { clearTimeout(hintTimer); hintTimer = undefined; setStatus(host.ui.style("accent", formatAgents(open))); return; }
  if (shownStatus === undefined || hintTimer) return;      // nothing was shown, or the hint is already running
  setStatus(host.ui.style("dim", "/agents to see agents"));
  hintTimer = setTimeout(() => { hintTimer = undefined; setStatus(undefined); }, settings.agentsHintMs); hintTimer.unref();
};
bus.on("agent:changed", updateStatus);   // unthrottled: one list pass, setStatus only on change
```

`formatAgents` is plan 04's (`1 agent`, `3 agents`). A new open record while the hint runs clears the timer and shows the count at once. `agentsHintMs: 0` → the hint is set and cleared on the next macrotask (acceptable; no special case).

## 5. Settings

`src/model/settings.ts`: add `doneLingerMs: number` and `agentsHintMs: number` to `Settings`; defaults `doneLingerMs: 10_000`, `failedLingerMs: 30_000` (was 60 000), `agentsHintMs: 30_000`; schema `doneLingerMs: range(0, 3_600_000)`, `agentsHintMs: range(0, 3_600_000)`. `lingerMs` is untouched here (plan 06 narrows its meaning to the list). Place the new keys after `failedLingerMs`.

README `extensions/subagents/README.md` "Other keys" sentence (line 125): this plan owns its final text (plans 04 and 06 do not edit it; plan 03 only guarantees the `notifications` clause is gone, and if plan 03 has not landed this plan drops it). Replace the whole sentence with:

"Other keys: `maxDepth` (3, from 2 to 4; the main session counts as level 1, so 2 means agents cannot start agents), `maxChainLength` (3; sessions one agent may use before a partial handoff reaches the caller), `hardContextRatio` (1.15; share past which an agent asked for a handoff is stopped; an agent asked for a handoff is also stopped three turns after the request), `reserveTokens` (16384), `stopGraceSeconds` (60), `doneLingerMs` (10000; how long a finished agent's row stays in the panel below the editor), `failedLingerMs` (30000; the same for failed, stopped and handoff rows, unless `x` clears them first), `lingerMs` (30000; how long closed agents stay in the `/agents` list), `agentsHintMs` (30000; how long the footer shows `/agents to see agents` after the last agent finished), `renderThrottleMs` (250; minimum time between redraws; it governs every surface: the start block, the panel, the list, the view and the completion lines)."

Tests: `test/model/settings.test.ts` (if it asserts defaults) gets the three new values; otherwise add `"defaults the panel lingers and the agents hint"` asserting `doneLingerMs 10000`, `failedLingerMs 30000`, `agentsHintMs 30000`, and `"rejects doneLingerMs and agentsHintMs outside 0–3600000"` through `loadSettings` with a user file.

## 6. The main-session prompt

`prompts/main-session.md:61` (`/agents <id>`, then `x`; line 61 verified today and after plan 04's prompt edit) stays: the view's `x` still stops. Line 39 `Give each agent a short `description` for the progress rows.` → `Give each agent a short `description`; it names the agent in the panel and the transcript.` No other prompt mentions the widget (`prompts/*.md` grep for `widget`/`progress` returns only that line).

## 7. Docs

`extensions/subagents/README.md` "Use": replace line 36 (the bullet starting `The widget below the editor lists running, queued and stopping agents…`) and its three sub-bullets with the three panel bullets below. Plan 06 appends its list and view bullets after them and deletes line 40 (the old `/agents` list bullet); this plan does not touch line 40.

- `The panel below the editor shows one row per agent: a spinner or state glyph, the agent name (with `#2` for a continued session and `(+N)` for agents it started), the description, and on the right the current tool or `writing`, the elapsed time and the tokens it used; `queued` and `stopping` replace the stats, finished rows show `done · 1m 5s`, `failed · 2m 10s`, `stopped · 3s` or `handed off · 1h 2m`. Agents started by other agents sit under their caller. At most five rows are shown; `↑ N more` and `↓ N more` mark the rest.`
- `Press `↓` in an empty prompt (after the newest input history entry) to select the first row, `↑`/`↓` to move (`↑` on the first row returns to the prompt), `Enter` to open the agent's view, `x` to stop a running agent (it keeps answering for `stopGraceSeconds`; `x` again closes it now), to close a queued agent at once, or to clear a finished row; `Esc` deselects. The prompt keeps the focus: any other key deselects and is typed, and `Esc` never interrupts the main session while a row is selected. While the panel shows rows, `↓` on an empty prompt always selects the panel; `Esc` returns you to typing. `←` in an empty prompt, or on a selected row, opens the agents list (as `/agents` does) when it has agents to show.`
- `Finished rows leave after `doneLingerMs` (10 s); failed, stopped and handoff rows after `failedLingerMs` (30 s) or when you clear them. The panel disappears with its last row. The footer shows `3 agents` while agents are open and `/agents to see agents` for `agentsHintMs` (30 s) after the last one finished.`

README line 45 `shown in the start message, the progress row, …` → plan 04 changes it to `the start block` (spec §11.1); if plan 04 has not landed, change `the progress row` to `the start block` here.

`ARCHITECTURE.md`: plugin list line 51: `progress-widget` [registry] → `agent-panel` [registry] (panel below the editor, keyboard selection, footer status). "Status, views, notifications": the section's final bullet list is in plan 04 §9. This plan replaces today's second bullet (`The progress widget and list view re-render…`) with bullet 3 of the list in plan 04 §9 (the list half of today's bullet returns as plan 06's bullet 4): "The agent panel (`agent-panel`) renders the registry in tree order (`components/tree.ts`) with the shared row grammar (`components/agent-row.ts`) in a `belowEditor` widget: at most five rows plus `↑/↓ N more` markers, a selection driven by `HostUi.onEmptyEditorDown` and `captureEditorKeys` (consumed: `↑`, `↓`, `Enter`, `x`, `Esc`; any other key releases the capture and clears the selection), `done` rows kept `doneLingerMs`, other closed rows `failedLingerMs` or until cleared. It refreshes through `components/refresh.ts` (`watchAgents`: `agent:changed` throttled by `renderThrottleMs`, plus an unref'd ticker at 100 ms while any row runs, 1 s while only queued or closed rows show, none otherwise). The same plugin sets the footer status `pi-subagents` (`N agents` while any record is open, `/agents to see agents` for `agentsHintMs` after the last closes)."

`STRUCTURE.md`: components comment: add `tree.ts` (tree order, connectors, open descendants) next to `agent-row`; plugin list: `progress-widget/    # live progress widget below the editor` → `agent-panel/        # panel below the editor: model.ts (rows, window, lingers), keys.ts (selection keys)`.

## 8. Tests for the plugin

Harness: `createHarness([agentRegistryPlugin, agentPanelPlugin], overrides)` with fake timers (`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `Date`) and `vi.setSystemTime(1_000_000)`. `widget()` = `harness.host.widgets.get("pi-subagents-agents")`; `lines(width = 80)` = `widget()?.(width, plainTheme) ?? []`. Fake drivers from plan 01 §B: `host.pressEmptyDown()`, `host.pressEditorKey(key)`, `host.editorCapture`, `host.foreignEditor`. Stubs for the optional services: `services.provide("agentView", { open: vi.fn() })` and `services.provide("runner", { stop: vi.fn(async () => true), … })` through a tiny `stubPlugin(id, provide)` plugin listed before the panel. `newAgent(patch)` as in today's widget test; `running(id)` = `registry.update(id, { state: "running", startedAt: Date.now() })`.

`test/plugins/agent-panel/model.test.ts` (pure):

- `"keeps open rows, done rows for doneLingerMs and other closed rows for failedLingerMs"`: `doneLingerMs 10_000`, `failedLingerMs 30_000`, `endedAt 0`: at 9 999 all four (done, failed, stopped, running) visible; at 10 000 the done row is gone; at 30 000 only the running row.
- `"hides a cleared row for good"`: failed row with `cleared` containing its id is absent at 0 and at 29 999.
- `"anchors a chain at the first link even after the link lingered out"`: records `a` (handoff, `endedAt` 0, `successorId a2`), `b` (running, created 5), `a2` (running, created 100, `predecessorId a`); at `now` 40 000 (a invisible) rows are `[a2, b]`.
- `"windows seven rows around the selection"`: 7 running roots `r0..r6`; nothing selected → `windowOf` `{ start 0, end 5, above 0, below 2 }`; `selectedId r3` → `{ 0, 5, 0, 2 }` (already visible); `r0` → same; `r6` → `{ 2, 7, 2, 0 }`; then `r3` again from `top 2` → stays `{ 2, 7 }` (no scroll since visible).
- `"renders markers and the hint around the window"`: same 7 rows, `r6` selected → first line `"   ↑ 2 more"`, five rows, no `↓` line, then `" enter to view · x to stop · esc to deselect"`, then the trailing `""`; with `r3` selected and `top 0` → no `↑` line, `"   ↓ 2 more"`, hint, `""`.
- `"puts the markers in the glyph column"`: the marker lines start with three spaces and their arrow is at the column of the rows' glyph (`PAD + 2`).
- `"ends every line before the last column"`: at widths 80 and 30, every line of `panelLines` (rows, markers, a hint longer than the width) has `displayWidth <= width - 1`, starts with `" "` unless it is the trailing `""`; the hint at width 30 is cut with `…`.
- `"clears a selection whose row left and keeps it when rows are added"`: `reconcile` with `selectedId` absent → `deselected: true`; adding a row before the selected one → `selectedIndex` moves with it, `deselected: false`.
- `"keeps the window top when the selection clears"` (decision P5): 7 rows, `top 2`, `selectedId r6`; remove `r6` → `reconcile` gives `deselected: true` and `top` 1 (clamped to `6 - 5`); with `top 2` and `selectedId` cleared by hand (Esc) on 7 rows → `top` stays 2; with 4 rows left → `top` 0 (clamped).
- `"builds the hint per state and per available action"`: running → `enter to view · x to stop · esc to deselect`; grace → `… x to close now …`; done → `… x to clear …`; running with `{ view: false, stop: false }` → `esc to deselect`; done with `{ view: false, stop: false }` → `x to clear · esc to deselect`.
- `"reuses a closed row until its record, width, theme, selection or tree shape changes"`: counting theme as today; same inputs → same string instance and no new `bold` call; new `version`, other width, other theme object, `selected: true`, `last: false` each re-render; open rows re-render every time.
- `"returns no lines without rows"`.

`test/plugins/agent-panel/keys.test.ts` (pure, with a fake `PanelActions` recording `refresh`, `release`, `view`, `stop`):

- `"down moves to the next row and clamps at the last"`.
- `"up moves to the previous row and deselects on the first"` (release called once).
- `"enter opens the view with the selected id and deselects"` (`view` called with the id; `selectedId` undefined; release called).
- `"x stops an open row, closes a grace row now and clears a closed row"`: running → `stop(id)`; grace → `stop(id)` (the runner closes now); done → `state.cleared` has the id, `stop` not called.
- `"x does nothing on an open row without the stop action"`.
- `"escape deselects and is consumed"`.
- `"any other key clears the selection and is released"` (`"a"` → `"release"`, `selectedId` undefined; `tab` → `"release"`).
- `"selectFirst picks the first row and reports false without rows"`.

`test/plugins/agent-panel/agent-panel.test.ts` (plugin through the harness):

- `"shows rows below the editor and removes the widget when the last row leaves"`: create one agent → `lines()` has one `○ … queued` row; `running`, close `done`; at `+9 999` the widget exists; at `+10 001` `widget()` is undefined.
- `"keeps failed rows failedLingerMs and done rows doneLingerMs"` (fake clock, both rows).
- `"renders seven agents in tree order with markers and (+N)"`: a running root with one running child plus six other roots → `lines()[0]` is a row (no `↑`), 5 rows, `"   ↓ 3 more"`, then `""`; the parent row contains `(+1)`; the child row starts with `"   └─ "`.
- `"down on an empty editor selects the first row and installs a capture"`: `host.pressEmptyDown()` → `lines()[0]` starts with `" › "`, the line before the trailing `""` is the hint, `host.editorCapture` defined.
- `"down with no rows does nothing"`: `pressEmptyDown()` → no capture, no widget.
- `"moves the selection and scrolls the window"`: 7 rows, `pressEmptyDown()`, five `down` → `"   ↑ 1 more"` first, pointer on the last visible row.
- `"enter opens the agent view from the panel and deselects"`: `agentView.open` called with `(id, { from: "panel" })`; no pointer afterwards; `host.editorCapture` undefined.
- `"x stops a running agent through the runner and clears a done row for good"`: running → `runner.stop(id)` called once; done row → after `x` the row is gone at once, and still gone at `+1 ms` (the widget disappears when it was the only row).
- `"a released key clears the selection and reaches the editor"`: `pressEditorKey({ name: "other", char: "a" })` returns `"release"`, no pointer, no hint.
- `"esc deselects without reaching the editor"`: returns `"consumed"`.
- `"deselects and releases the capture when the selected row leaves"`: select a done row, advance past `doneLingerMs` → no capture, no pointer; a new agent created meanwhile did not move the selection before that (check after creating a second agent while the first is selected: pointer still on the first).
- `"keeps the window in place when the selection clears"` (decision P5): 7 running rows, `pressEmptyDown()` and six `down` → first line `"   ↑ 2 more"`; `escape` → no pointer, no hint, first line still `"   ↑ 2 more"`; select again and type `a` → same window.
- `"ticks every 100 ms while a row runs, every second with only queued rows, and never when empty"`: count `host.widgetRefreshes` over 1 s while a row runs (≥ 9; the spinner changes the output); with only queued rows after one `lines()` render, 0 refreshes over 1 s (output skip) but a done row whose linger ends within that second is gone after it (the 1 s tick ran); with no rows, no ticker timer is pending.
- `"skips the redraw when the panel output is unchanged"` (finding 34): one queued row, `lines()` once; a relevant `registry.update` that changes nothing visible (e.g. `tokens` on a queued row) adds no `widgetRefreshes`; `lines()` twice returns the same array instance; a state change to `running` refreshes.
- `"stops redrawing on ticks once every row is closed and unchanged"` (today's test, with the new signature including the selection: pressing `down` redraws once).
- `"reuses the closed-row cache across renders"`: counting theme through `widget()(80, theme)` twice → second call adds no `bold` calls for the closed row.
- `"degrades without agent-view and run-agent"`: harness without the stubs; `Enter` is consumed and nothing is thrown; hint for a running row is `" esc to deselect"`; `x` on the running row is consumed and the record stays running; `x` on a done row clears it.
- `"does nothing with a foreign editor"`: `host.foreignEditor = true` → `pressEmptyDown()` returns false; rows still render.
- `"removes the widget, the capture and the status on disable"`: `manager.disableAll()` → widget undefined, capture undefined, `statuses.get("pi-subagents")` undefined, no pending timers (`vi.getTimerCount()` is 0).
- Footer status, with the fake clock: `"shows N agents while any record is open"` (one queued → `<accent>1 agent`; second → `<accent>2 agents`; one closed → `<accent>1 agent`); `"shows the /agents hint for agentsHintMs after the last agent closes, then nothing"` (close the last → `<dim>/agents to see agents`; `+29 999` same; `+30 000` undefined); `"replaces the hint with the count when a new agent starts"`; `"counts nested agents"` (depth 3 record counts); `"sets no status before any agent exists"`.

## 9. Order of work

Prerequisites: plan 01 §B merged (`onEmptyEditorDown`, `captureEditorKeys`, fake drivers) and plan 04's `components/format.ts`, `spinner.ts`, `state-text.ts` and `AgentRecord.activity` present. If plan 04 is not merged yet, land those three modules first from the shared-modules contract (they are small) rather than stubbing them here.

1. `model/settings.ts` + settings test; README settings paragraph. `npm run check`.
2. `components/tree.ts` + `test/components/tree.test.ts`.
3. `components/agent-row.ts` rewrite + `test/components/agent-row.test.ts` rewrite (the old tests go entirely). Bridge first: rename today's `components/agent-row.ts` (as plan 04 left it after its trim, with `finishSummary`'s model wording already in `run-agent/result.ts` and `graceSecondsLeft` in `agent-status/snapshot.ts`) to `components/legacy-row.ts`, content unchanged, and repoint its remaining importers: `components/agent-list.ts` (`treeRow`), `plugins/agent-list-view/view.ts` (`truncate`), `plugins/agent-view/view.ts` (`chainLabel`, `finishSummary`, `progressText`, `stateIcon`, `truncate`) and `plugins/progress-widget/model.ts` (`treeRow`, deleted in step 6). `run-agent/result.ts` drops its `truncate` import for a local character cut `cutChars` (plan 04 §6: `truncateCols` is wrong for model text). The old cases of `test/components/agent-row.test.ts` move to `test/components/legacy-row.test.ts` with only the import path changed. Then write the new `agent-row.ts`; do not leave the old exports in it. Grep `src/` and `test/` for `agent-row` afterwards: only the new module's users remain. Plan 06 deletes `legacy-row.ts` and its test with the old list and view. Alternative: land plans 05 and 06 in one PR (plan 06 §10 allows it); then skip the bridge (no `legacy-row.ts`) and add `options` to `agentView.open` as required at once.
4. `components/refresh.ts` rewrite + tests; the two call-site adaptations (§2.3). `npm run check`.
5. `plugins/agent-panel/model.ts` + `model.test.ts`; `keys.ts` + `keys.test.ts`.
6. `model/types.ts`: `export type AgentViewOrigin = "list" | "panel" | "command"` and `AgentViewService = { open(id: string, options?: { from: AgentViewOrigin }): Promise<void> }` (today's `agent-view` implementation, `open(id)`, still satisfies it and ignores the option; plan 06 makes `options` required). `plugins/agent-panel/index.ts` (widget, refresh, keys, footer status); `src/plugins.ts`; delete `plugins/progress-widget/` and `test/plugins/progress-widget/`; `agent-panel.test.ts`. `npm run check`.
7. Docs: README "Use" line 36 and its sub-bullets, line 45, `prompts/main-session.md:39`, ARCHITECTURE.md (bullet 3 of the list in plan 04 §9), STRUCTURE.md.
8. `npm run check` (typecheck, biome, unit tests) must be green; `test/architecture.test.ts` must still pass (the new folder imports only `../../components`, `../../model`, `core/adapter/contract.ts` types).

Manual checklist (`pi -e ./extensions/subagents/src/index.ts`, tui):

- Narrow terminal at 40 columns: a running row shows the description and `1m 5s` only; at 30 the stats go and the description stays; a done row at 30 shows the name and `done · 1m 5s`; no line wraps, every line starts one column in and the last column stays blank; one blank line separates the panel from the footer.
- Seven agents: five rows, `↓ 2 more`; `↓` on the empty prompt selects the first; six more `↓` presses scroll one row at a time, `↑ N more` appears, the window never jumps; `Esc` (or typing) then deselects and the window stays where it was.
- Nested agents (an agent with `subagents`): children under their caller with `└─`/`├─`, `(+N)` on the parent while they run, the count drops as they finish.
- Typing while selected: with a row selected, type `a` → the selection clears and `a` appears in the prompt; `x` while selected stops the agent and is not typed; `Enter` opens the view, and `Esc` from there returns to the prompt with nothing selected.
- Esc while the main session is busy: start a long main turn (agents running), select a row, press `Esc` → the row deselects and the main turn keeps running; press `Esc` again (nothing selected) → pi interrupts as usual.
- Footer: `2 agents` in the accent colour while two run; after both finish `/agents to see agents` (dim) for 30 s, then the status line is empty; starting a new agent during the 30 s shows `1 agent` at once.
- Linger: a done row leaves after ~10 s, a failed row after ~30 s or at once on `x`; the panel vanishes with its last row and `↓` then does nothing visible.
- `/reload` with agents running: no stray timers (the process exits cleanly on `/quit`), the panel reappears empty (registry is per instance).
