# Plan 04: main transcript (run_agent block, completion lines, wake, shared modules)

Implements `plans/00-ux-spec.md` §2 and §3 (Surface A) on top of `plans/01-adapter-foundations.md` §C (`sendHiddenMessage`, `registerEntryRenderer`) and §D (`ToolRenderState`, `renderShell`, `update(text, details)`, `createTranscript({ tools })`). Owns the shared modules listed in `plans/research/shared-modules.md` for plan 04. Paths are relative to `extensions/subagents/` unless they start with `core/`.

Review resolution: Reviewed 2026-10-14: findings 3, 5, 6, 10, 13, 17, 18, 21, 22, 28, 29, 30, 35 applied; decision P3 (`↳` glyph), P4 (tools service object).

## 1. Goal

1. `run_agent` renders as one self-shelled block: a spinner header while the tool runs, then `N background agents launched (↓ to manage)` or `N agents finished`, with one tree-connected row per agent whose status line updates live until the batch settles.
2. Every agent of the main session adds exactly one dim completion line when it closes (after worktree cleanup for worktree agents); the model never sees it; resume renders it again from the persisted entry.
3. The batch text reaches the model as a hidden message; when the session was idle a `↳ 3 agents finished` user line starts the turn.
4. One set of formatters (`format.ts`), one spinner (`spinner.ts`), one state vocabulary (`state-text.ts`), used by plans 05 and 06 as given.
5. The record gains `activity` so the panel can show `grep · 1m 5s`.
6. `renderThrottleMs` governs every surface; the `tools` service exposes the three tool specs for the agent view.
7. The model is told that the user saw only one-line summaries and must relay what matters.
8. No new setting, no new file on disk, no provider knowledge.

What the user sees, end to end (mockups: spec §3 "Mockups"): the model calls `run_agent`; the block appears with `⠹ Running 3 agents…` and rows at `Queued`/`Initializing…`; the tool returns and the header becomes `3 background agents launched (↓ to manage)`; rows move to `Running in the background`, `Needs input: Run npm test?`, then `Done · 4 tool uses · 12.3k tokens · 1m 5s`; under the block, as each agent closes, one dim line `✓ Agent "Map the auth module" finished · 1m 5s` is appended; when the last agent closes the header drops `(↓ to manage)`, the live updates stop, and, if the session is idle, a user-message box `↳ 3 agents finished` starts the turn (busy: nothing visible, the results join the run); the working indicator runs and the model's reply follows.

## 2. Shared modules (owner)

### `core/manager/format.ts` (new, step 0)

`formatTokens` and `formatDuration` move to pi-free `core/manager`, so the footer, the working indicator and subagents share one copy (spec §2 and §10: the footer duplicate goes). The import rules allow it: `test/architecture.test.ts` forbids only `core/adapter` files other than `contract.ts` (and `pi-adapter.ts` from an extension's entry), imports between extensions, imports between plugins, and `core` importing `extensions`; `core/manager` is open to every extension (`ARCHITECTURE.md:9`). The file holds these two functions and nothing else:

```ts
export const formatTokens = (n: number): string =>
  n < 1_000 ? `${n}` : n < 1_000_000 ? `${(n / 1_000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
```

- `core/test/manager/format.test.ts` (new): `"formats tokens as 999, 1.0k, 1.2M"`: `formatTokens(999) === "999"`, `formatTokens(1000) === "1.0k"`, `formatTokens(1_234_567) === "1.2M"`, plus `formatTokens(0) === "0"`, `formatTokens(12_345) === "12.3k"` and the footer's moved case (`150_100 → "150.1k"`, `1_000_000 → "1.0M"`, `2_450_000 → "2.5M"`). `"formats durations as seconds, minutes and hours"`: `3_000 → "3s"`, `75_000 → "1m 15s"`, `3_600_000 → "1h 0m"`, plus `0 → "0s"`, `62_000 → "1m 2s"`, `3_720_000 → "1h 2m"`, `-5 → "0s"`.
- `extensions/footer/src/render.ts`: delete its own `formatTokens` and add `import { formatTokens } from "../../../core/manager/format.ts"`. `extensions/footer/test/render.test.ts`: drop `formatTokens` from its import list and the `"formats token counts"` case from `describe("format helpers")` (its values are in the core test above).
- `ARCHITECTURE.md` line 8 (`core/manager` contents): add `` `format.ts` (`formatTokens`, `formatDuration`, shared by the footer, the working indicator and subagents) ``. `STRUCTURE.md` `core/manager/` tree: `format.ts # token and duration formatters`.
- If plan 02 landed first, `core/manager/format.ts` already exists with `formatDuration` (plan 02 puts it there); step 0 then adds only `formatTokens` and its cases. If this plan lands first, plan 02 imports `formatDuration` from here and creates no `src/format.ts`.

### `src/components/format.ts`

```ts
export { formatDuration, formatTokens } from "../../../../core/manager/format.ts";

export const SEP = " · ";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const formatToolUses = (n: number): string => plural(n, "tool use");
export const formatAgents = (n: number): string => plural(n, "agent");
export const formatCtx = (percent: number | null | undefined): string | undefined =>
  percent === null || percent === undefined ? undefined : `${Math.round(percent)}% ctx`;

export const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();
export const firstLine = (text: string): string => text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
export const elapsedOf = (record: { startedAt?: number; createdAt: number; endedAt?: number }, now: number): number =>
  (record.endedAt ?? now) - (record.startedAt ?? record.createdAt);

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

const inRanges = (cp: number, ranges: [number, number][]) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
const ZERO: [number, number][] = [[0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff]];
const WIDE: [number, number][] = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];

export const charWidth = (char: string): number => {
  const cp = char.codePointAt(0) ?? 0;

  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || inRanges(cp, ZERO)) return 0;

  return inRanges(cp, WIDE) ? 2 : 1;
};

export const displayWidth = (text: string): number =>
  Array.from(stripAnsi(text)).reduce((sum, char) => sum + charWidth(char), 0);

export const truncateCols = (text: string, cols: number): string => {
  if (cols <= 0) return "";
  if (displayWidth(text) <= cols) return text;

  const chars = Array.from(text);
  const budget = cols - 1;
  const kept = chars.reduce(
    (acc, char) => (acc.width + charWidth(char) > budget ? acc : { width: acc.width + charWidth(char), count: acc.count + 1 }),
    { width: 0, count: 0 },
  );

  return `${chars.slice(0, kept.count).join("")}…`;
};

export const padEndCols = (text: string, cols: number): string => text + " ".repeat(Math.max(0, cols - displayWidth(text)));
```

Notes: `truncateCols` takes plain text (no ANSI); callers colour after cutting. `charWidth` is exported so plan 05 can measure a prefix without re-scanning. Braille frames, `✓ ✗ ○ ◐ ■ ↪ ├ └ │ ─ …` are width 1. `singleLine`, `firstLine`, `elapsedOf` are additions to the shared-modules signature list (today's `singleLine`/`elapsedOf` live in `agent-row.ts`; `firstLine` is used by the status lines and completion lines). `formatTokens` and `formatDuration` are re-exported from `core/manager/format.ts` (step 0), so subagents code imports every formatter from `components/format.ts`; the footer's duplicate is gone.

### `src/components/spinner.ts`

```ts
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinnerFrame = (now: number): string => SPINNER_FRAMES[Math.floor(now / 100) % SPINNER_FRAMES.length];
```

### `src/components/state-text.ts`

```ts
import type { ThemeToken } from "../../../../core/adapter/contract.ts";
import type { AgentState } from "../model/types.ts";
import { spinnerFrame } from "./spinner.ts";

const GLYPHS: Record<Exclude<AgentState, "running">, string> = { queued: "○", grace: "◐", done: "✓", failed: "✗", stopped: "■", handoff: "↪" };
const TOKENS: Record<AgentState, ThemeToken> = { queued: "muted", running: "accent", grace: "warning", done: "success", failed: "error", stopped: "muted", handoff: "warning" };
const WORDS: Record<AgentState, string> = { queued: "queued", running: "running", grace: "stopping", done: "done", failed: "failed", stopped: "stopped", handoff: "handed off" };
const SENTENCES: Record<AgentState, string> = { ...WORDS, done: "finished", stopped: "was stopped" };

export const stateGlyph = (state: AgentState, now: number): string => (state === "running" ? spinnerFrame(now) : GLYPHS[state]);
export const stateToken = (state: AgentState): ThemeToken => TOKENS[state];
export const stateWord = (state: AgentState): string => WORDS[state];
export const stateSentence = (state: AgentState): string => SENTENCES[state];
```

### Removals from `src/components/agent-row.ts`

Delete `SPINNER_FRAMES`, `STATE_ICONS`, `STATE_COLORS`, `formatTokens`, `formatElapsed`, `elapsedOf`, `singleLine`. `plural` and `graceSecondsLeft` stay as module-private copies (the old rows still say `12 tool calls` and `stopping in 5s`, which the row tests assert). Keep (until plan 05 deletes them) `stateIcon(state, frame)` reimplemented as `state === "running" ? SPINNER_FRAMES[frame % 10] : stateGlyph(state, 0)`, `statsText`, `finishSummary`, `progressText`, `truncate`, `chainLabel`, `attentionText`, `graceCountdown`, `agentRow`, `treeRow`, with `statsText` importing `formatTokens`/`formatDuration`/`elapsedOf` from `format.ts` and colours from `stateToken`. These are copies kept only for `agentRow`/`treeRow`; `finishSummary` and `truncate` stay exported only because the old views import them (`plugins/agent-view/view.ts:12,15`, `plugins/agent-list-view/view.ts:11`; plans 05 and 06 replace those views). Plan 05 must not re-add any removed helper; it imports `format.ts`/`state-text.ts`.

Relocate what the model-facing code needs, so that `result.ts` and `snapshot.ts` no longer import `agent-row.ts`:
- `plugins/run-agent/result.ts`: private `plural`, `statsText` and `finishSummary`, moved verbatim with the model wording (`12 tool calls`, `Done (…)`, `Failed: <error> (…)`; `successor-chain.test.ts:129` keeps asserting `Done (3 tool calls`), built on `formatTokens`/`formatDuration`/`elapsedOf` from `format.ts`; a private `cutChars(text, n)` (today's `truncate`, a character cut with `…`; `truncateCols` is wrong for model text, see §6) for the `Task:` and `Preview:` lines; `singleLine` from `format.ts`.
- `plugins/agent-status/snapshot.ts`: private `graceSecondsLeft` (moved verbatim) and a private `cutChars` for `lastLineOf`; `elapsedOf`, `formatElapsed` → `formatDuration`, `formatTokens` and `singleLine` from `format.ts`; a private `plural` (the `agent_status` text says `4 tool calls` and is model-facing, so not `formatToolUses`).
- `plugins/run-agent/model-text.ts` and `components/context-breakdown.ts`: `formatTokens` from `format.ts` (plan 06 deletes `context-breakdown.ts`).

After this step `agent-row.ts` is imported only by the old rows' users: `run-agent/tools.ts` (`agentRow`, until step 3 replaces it with `render.ts`), `progress-widget/model.ts` and `components/agent-list.ts` (`treeRow`), and the two views above. Plan 05's delete list (`stateIcon`, `finishSummary`, `progressText`, `truncate`, `chainLabel`, `attentionText`, `graceSecondsLeft`, `agentRow`, `treeRow`) then needs no relocation: nothing model-facing depends on it.

`test/components/agent-row.test.ts`: delete `"formats tokens and elapsed time compactly"` (covered by the format tests) and drop `formatElapsed` and `formatTokens` from its import list, or the file fails to compile; `agentRow`, `finishSummary`, `progressText`, `treeRow` and `truncate` stay imported, and the rest of the file stays until plan 05.

### Tests

`test/components/format.test.ts`:
- The token and duration cases live in `core/test/manager/format.test.ts` (step 0). Here only `"re-exports the core token and duration formatters"`: `formatTokens(12_345) === "12.3k"`, `formatDuration(62_000) === "1m 2s"`.
- `"pluralises tool uses and agents"`: `formatToolUses(1) === "1 tool use"`, `formatToolUses(0) === "0 tool uses"`, `formatToolUses(4) === "4 tool uses"`, `formatAgents(1) === "1 agent"`, `formatAgents(3) === "3 agents"`.
- `"formats context percent or nothing"`: `formatCtx(23.4) === "23% ctx"`, `formatCtx(undefined) === undefined`, `formatCtx(null) === undefined`.
- `"measures display width with wide, combining and ANSI-coloured text"`: `displayWidth("abc") === 3`, `displayWidth("日本") === 4`, `displayWidth("é") === 1`, `displayWidth("\x1b[31mab\x1b[0m") === 2`, `displayWidth("⠹ ✓ …") === 5`, `displayWidth("🙂") === 2`.
- `"truncates by columns with a trailing ellipsis"`: `truncateCols("Map the auth module", 8) === "Map the…"`, `truncateCols("日本語テキスト", 5) === "日本…"`, `truncateCols("short", 10) === "short"`, `truncateCols("x", 0) === ""`.
- `"pads by columns"`: `padEndCols("日本", 6) === "日本  "`, `padEndCols("abc", 2) === "abc"`.
- `"collapses whitespace and picks the first non-empty line"`: `singleLine(" a \n b ") === "a b"`, `firstLine("\n\n  x\ny") === "x"`, `firstLine("") === ""`.

`test/components/spinner.test.ts`: `"picks the frame from the wall clock"` (`spinnerFrame(0) === "⠋"`, `spinnerFrame(250) === "⠹"`, `spinnerFrame(1_000) === "⠋"`, `spinnerFrame(950) === "⠏"`).

`test/components/state-text.test.ts`: `"maps every state to its glyph, token, word and sentence"` (table from spec §2; `stateGlyph("running", 250) === "⠹"`, `stateGlyph("done", 0) === "✓"`, `stateSentence("stopped") === "was stopped"`, `stateWord("handoff") === "handed off"`, `stateToken("grace") === "warning"`).

## 3. The `activity` field

- `src/model/types.ts`, in `AgentRecord` after `attention`: `activity?: { kind: "tool" | "text"; text: string; at: number };`
- `src/plugins/run-agent/runner.ts`, `handleEvent`:
  - `tool_start` (today `runner.ts:512-514` drops the name): `deps.registry.update(id, { toolCalls: record.toolCalls + 1, activity: { kind: "tool", text: event.toolName, at: Date.now() } })`.
  - `assistant_message`: after the existing `live.*` bookkeeping, when `event.text.trim()` is non-empty: `deps.registry.update(id, { activity: { kind: "text", text: firstLine(event.text), at: Date.now() } })`. This adds one `agent:changed` per assistant message (today none); consumers throttle.
- Registry: `update` already bumps `version` and emits `agent:changed`; no change. Manifest: **not persisted** (`writeManifestFile` lists fields explicitly; `activity` is transient and meaningless after the session). Never cleared: rows check `state === "running"` before showing it.
- Tests, `test/plugins/run-agent/run-agent.test.ts`, new `it`s in `describe("run_agent batches")`: `"records the last tool name as activity on tool_start"` (`runtime.children[0].emit({ type: "tool_start", toolName: "grep" })` → `registry.get(id).activity` equals `{ kind: "tool", text: "grep", at: expect.any(Number) }` and `toolCalls === 1`), `"records the first line of an assistant message as text activity"` (emit `assistant_message` with text `"Looking at auth.\nMore"` → `{ kind: "text", text: "Looking at auth." }`; an empty text leaves `activity` untouched), `"emits agent:changed for activity"` (bus spy sees the record after the emit).

## 4. The `run_agent` block

### Rendering facts (pi 1.1.0, `tool-execution.js`)

`isPartial` starts `true` and becomes `false` only at `updateResult(final)`; a `Text` with empty text renders zero lines. So: `renderCall` draws the header **only while `state.isPartial`** (spinner phase) and returns `""` afterwards; `renderResult` draws the rows while partial and **header + rows** once final. No cross-call bookkeeping is needed. `execute` calls `ctx.update("", details)` right after `startBatch` so the rows exist during a `wait: true` run (plan 01 §D forwards `details` to partial renders).

### New file `src/plugins/run-agent/render.ts` (pure)

```ts
export type RunAgentDetails = { batchId?: string; ids: string[]; agents: { id: string; agent: string; description: string; model?: string }[] };
export type BlockInput = { params: RunAgentParams; result?: ToolResult<RunAgentDetails>; state: ToolRenderState; registry: Pick<AgentRegistry, "get" | "batch">; theme: ThemeLike; now: number };

export const BLOCK_WIDTH = 100;   // description budget; pi hard-cuts lines to the terminal width
export const renderRunningHeader = (params, theme, now): string;   // "⠹ Running 3 agents…"
export const renderBlock = (input: BlockInput): string;            // header + rows, or rows only while partial, or error header
```

Imports between `render.ts` and `tools.ts` are type-only in both directions for the shared types: `render.ts` has `import type { RunAgentParams } from "./tools.ts"`, and `tools.ts` imports `RunAgentDetails` as a type (`import { type RunAgentDetails, renderBlock, renderRunningHeader } from "./render.ts"`). The two render functions are the only runtime edge (tools → render), so `render.ts` never loads `tools.ts` at runtime and there is no cycle.

Header rules (`renderBlock`, final result): `state.isError && !result.details?.batchId` (plan 01 §D forwards pi's `isError` into `ToolRenderState`, and `fromPiResult` copies it, so `result.isError` agrees) → `theme.fg("error", "✗ No agents started: " + firstLine(result.text))`, plus, when `state.expanded`, every line of `result.text` indented by 3 spaces (no rows). Otherwise `n = details.agents.length`; `wait === true` → `${bold(n)} ${n === 1 ? "agent" : "agents"} finished`; `wait !== true` → `${bold(n)} background ${agent(s)} launched` + (any record of `registry.batch(batchId)` open → ` ` + dim(`(↓ to manage)`)). After a rebuild with no records the header has no hint. `renderRunningHeader`: `${fg("accent", spinnerFrame(now))} Running ${bold(n)} ${agent(s)}…` with `n = (params.agents ?? []).length`; `n === 0` (args still streaming) → `⠹ Running agents…`.

Rows, one per `details.agents` entry in order, connector `├─ `/`└─ ` (last), continuation `│  `/`   `:
- Record lookup: `registry.get(id)`, followed to `chainTerminal`; links = `chainLinks(registry, terminal)`; stats from `chainTotals(links)` (export it from `result.ts`).
- Line 1: `${connector}${bold(agent + chainSuffix)} ${fg("muted", "(" + description + ")")}` + (`model` ? `${fg("dim", SEP + model)}` : ""). `chainSuffix` = ` #${terminal.chainIndex}` when `> 1`. Width: with `head = connector + name + " ("` and `tail = ")" + SEP + model`, cut `singleLine(description)` with `truncateCols` to `BLOCK_WIDTH - displayWidth(head) - displayWidth(tail)`; if that budget is below 20, drop the model (`tail = ")"`) and recompute; never below 8. Without a record, `agent`/`description`/`model` come from `details.agents`.
- Line 2: `${continuation}${status}` where `status` by state (colours: whole line in the token unless stated):
  - no record: `fg("dim", "Status unavailable" + SEP + "/agents " + id)`.
  - `queued`: `fg("muted", "Queued")`.
  - attention set and state open: `fg("warning", "Needs input: " + singleLine(attention.title))`.
  - `running`, `turns === 0 && toolCalls === 0 && !activity`: `fg("muted", "Initializing…")`.
  - `running`, `wait !== true`: `fg("muted", "Running in the background")`.
  - `running`, `wait === true`: `fg("muted", ["Running", formatToolUses(toolCalls), tokens].join(SEP))` with `tokens = formatTokens(t) + " tokens"` omitted when `t === 0`.
  - `grace`: `fg("warning", "Stopping…")`.
  - `done`: `fg("success", "Done") + fg("dim", SEP + stats)`; `failed`: `fg("error", "Failed: " + firstLine(error ?? "unknown error"))`; `stopped`: `fg("muted", "Stopped" + SEP + stats)`; `handoff`: `fg("warning", "Handed off" + SEP + stats)`.
  - `stats` = `[formatToolUses(toolCalls), tokens?, formatDuration(elapsedOf(totals, now))].join(SEP)` over chain totals.
  - Closed with `worktree.cleanup`: append `fg("dim", SEP + suffix)`: `removed` → `worktree removed`, `branch kept` → `branch ${worktree.branch} kept`, `kept` → `worktree kept`.
  - Width: the plain status text is cut with `truncateCols` before colouring, to `BLOCK_WIDTH - 3 - displayWidth(worktree part)` (3 is the continuation), the same bound as line 1. In practice only `Failed: <first line of the error>` and `Needs input: <title>` reach it; `Failed: …` is thus cut to the block width like the completion line's error.

Exact strings (plainTheme, `now` fixed, 3 agents, `wait: false`, second agent done after 65 s with 4 tool uses and 12 345 tokens, third queued):

```
3 background agents launched (↓ to manage)
├─ explorer (Map the auth module) · fake/model:high
│  Initializing…
├─ worker (Fix the login redirect) · fake/model:medium
│  Done · 4 tool uses · 12.3k tokens · 1m 5s
└─ reviewer (Review the diff of PR 5) · fake/model:high
   Queued
```

### `tools.ts` changes

- `RunAgentDetails` moves to `render.ts` and gains `agents` (keep `ids`; `test/helpers/live.ts` reads `details.ids`). `execute` fills `agents` from `started.records` (`id, agent, description, model`), calls `ctx.update("", details)` before the `wait` branch, and returns the same text as today (`Started batch …: … End your turn now.` / `batchText`).
- `ToolDeps` gains `now?: () => number` (tests) and keeps `onRendered(batchId, invalidate)`.
- Spec: `renderShell: "self"`, `renderCall: (params, theme, state) => state.isPartial ? renderRunningHeader(params, theme, now()) : ""`, `renderResult: (result, state, theme) => { if (result.details?.batchId) deps.onRendered?.(result.details.batchId, state.invalidate); return renderBlock({ params: state.args as RunAgentParams, result, state, registry, theme, now: now() }); }`. `renderResult` gets no params argument; it reads them from `state.args`, which plan 01 §D fills from pi's `ToolRenderContext.args` (shared by the call and result renders of one call). `wait` is the only field read: `(state.args as RunAgentParams).wait`. No per-call map is kept, so there is nothing to evict, and the agent view (plan 06, same spec objects) works unchanged.
- The error header on an aborted `wait: true` call: pi replaces the result with its own abort error without `details`, so the block shows `✗ No agents started: …`; accepted (the agents were stopped by `onAbort` and their completion lines say `was stopped`). Noted in README (§9).

### Live updates (`run-agent/index.ts`)

Keep the `invalidators: Map<batchId, invalidate>` and the single pending timer (`index.ts:77-104`), throttled by `settings.renderThrottleMs` as today. Changes: stop at `batch:settled` instead of polling `isClosed`: `bus.on("batch:settled", ({ batchId }) => { safeInvalidate(batchId); invalidators.delete(batchId); })` (fires after worktree cleanup, `runner.ts:checkBatch` after `release`, so the final render shows the suffix and no hint). The `agent:changed` listener stays. Every stored `invalidate` is called through `safeInvalidate(batchId)` = `try { invalidators.get(batchId)?.() } catch { invalidators.delete(batchId) }`, both in `scheduleRender`'s loop and at `batch:settled`: a nested batch rendered in the agent view (plan 06) leaves an `invalidate` bound to the overlay's disposed component once the overlay closes, and one throwing call must not skip the other batches. try/catch rather than a map per spec instance, because the agent view reuses the main plugin's spec objects, so there is no per-view instance to scope a map to. Spinner: `spinnerFrame(Date.now())` at render time; the header animates only when something invalidates (each throttled `agent:changed`); no timer is added (spec §3 "never schedules its own timer"; deviation noted: during `wait: true` the frame moves with agent activity, not at 10 fps). Width: no width reaches the renderer; `BLOCK_WIDTH = 100` bounds the description and pi truncates longer lines (adapter `textComponent` → pi `Text`, which wraps; acceptable at ≥ 100 columns, wraps below).

### Tests: `test/plugins/run-agent/render.test.ts` (new)

Setup: `createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin])`, start a batch through `host.tool("run_agent").execute` with `update` recording details, `plainTheme`, `host.renderTool("run_agent", { call, result, state })` from plan 01 §D with `state` overrides, `now` injected via `deps.now` (export a `createRunAgentDeps`-free path: `runAgentTool(deps, description)` is exported; build it directly with `{ runner, registry, now: () => NOW }`).

- `"shows the spinner header with the agent count while partial"`: `renderCall` with `isPartial: true`, 3 agents, `NOW = 250` → `"⠹ Running 3 agents…"`; 1 agent → `"⠹ Running 1 agent…"`; `agents` undefined → `"⠹ Running agents…"`.
- `"renders nothing for the call once the result is final"`: `isPartial: false` → `""`.
- `"renders rows only while the result is partial"` (`wait: true`, after `update`): no header line, 3 rows.
- `"headers: launched with hint, launched without hint, finished"`: open batch → `3 background agents launched (↓ to manage)`; all closed → `3 background agents launched`; `wait: true` → `3 agents finished`; singular `1 background agent launched (↓ to manage)`.
- `"status lines per state"`: one assertion per row of the spec table: `Queued`, `Initializing…`, `Running in the background`, `Running · 4 tool uses · 12.3k tokens` (wait), `Running · 4 tool uses` (0 tokens), `Needs input: Run npm test?`, `Stopping…`, `Done · 4 tool uses · 12.3k tokens · 1m 5s`, `Failed: tests failed twice` (error `"tests failed twice\nstack"`), `Stopped · 0 tool uses · 3s`, `Handed off · 4 tool uses · 12.3k tokens · 1h 2m`; a failed record whose first error line is 200 characters → status line width ≤ 100, ending in `…`.
- `"appends the worktree outcome to closed rows"`: `worktree removed`, `branch pi-agents/x-1 kept`, `worktree kept`; nothing while open.
- `"renders a chain as one row with #n and summed stats"`: predecessor 2 tool uses + successor 3 → `explorer #2 (…)` and `Done · 5 tool uses · …`, duration from the first link's start.
- `"cuts the description to the width and drops the model first"`: 120-char description → line 1 width ≤ 100, ends with `…)`, no model; short description keeps ` · fake/model:high`.
- `"renders the error header and the full error when expanded"`: result `{ isError: true, text: "unknown agent(s): x. Available: explorer\nNothing was started." }` with `state.isError: true` (the fake's default state takes it from the result, plan 01 §D) → collapsed `✗ No agents started: unknown agent(s): x. Available: explorer` only; expanded adds `   unknown agent(s)…` and `   Nothing was started.`.
- `"falls back to Status unavailable after a rebuild without records"`: fresh registry → `├─ explorer (Map the auth module) · fake/model:high` / `│  Status unavailable · /agents explorer-abc`; header `3 background agents launched`.
- `"invalidates at most once per renderThrottleMs and stops at batch:settled"`: `renderThrottleMs: 50`, fake timers; three `agent:changed` in 10 ms → one `invalidate`; after `batch:settled` a further `agent:changed` of that batch → no call; the settle itself calls `invalidate` once (final frame).
- `"keeps invalidating other batches when one stored invalidate throws"`: two open batches, the first batch's `invalidate` throws → the second's is still called once per throttle window; the throwing entry is dropped (no further call).

Existing `test/plugins/run-agent/run-agent.test.ts` `"starts agents in the background…"` keeps asserting `result.text` contains `Started batch`; add `expect(result.details.agents).toHaveLength(3)`.

## 5. Completion lines

### Where

`run-agent/index.ts`, after the runner is created. Listener `bus.on("agent:closed", (record) => …)`, guarded first by `if (shuttingDown) return`. `shuttingDown` is a plugin-local `let` set as the first statement of run-agent's own `host.onSessionShutdown` handler in `index.ts` (the one that today runs `outbox.clear()` and then `` await runner.shutdown(`session ${reason}`) ``), so it is set before `runner.shutdown` closes the open agents as `failed` (`interrupted: session <reason>`, `runner.ts:911`). **Agents interrupted by a session switch (`/new`, `/resume`, `/reload`, quit) print no line**: otherwise each would append `✗ Agent "…" failed: interrupted: session new` at shutdown and replay it on resume. A worktree agent that closed before the shutdown and sits in `awaitingCleanup` still appends when its cleanup lands (step 3). The flag is never reset: pi builds a new extension instance per session.
1. `record.callerId !== MAIN_CALLER` → return (children print nothing).
2. `record.successorId` set → return (a continuing link; the chain prints at its end).
3. `record.worktree && record.worktree.cleanup === undefined` → wait: register the id in `awaitingCleanup: Set<string>`; a `bus.on("agent:changed")` listener appends when `awaitingCleanup.has(record.id) && record.worktree?.cleanup !== undefined` (the placer's `release` updates every link with `cleanup` through `registry.update`, `placement.ts:14-20`, before `checkBatch` emits `batch:settled`). Shutdown awaits pending removals (`runner.shutdown`), so the line still lands; if shutdown skips one (a `git worktree add` still running), the entry is never appended: accepted.
4. Otherwise append now.

`append(record)`: `host.appendEntry(CLOSED_ENTRY, closedEntryOf(record, chainLinks(registry, record)))`.

### Payload (`src/plugins/run-agent/completion.ts`, new)

```ts
export const CLOSED_ENTRY = "pi-subagents:agent-closed";
export type ClosedEntry = { v: 1; id: string; agent: string; description: string; state: "done" | "failed" | "stopped" | "handoff"; durationMs: number; error?: string; sessions?: number; worktree?: WorktreeCleanup; branch?: string };
export const closedEntryOf = (record: AgentRecord, links: AgentRecord[]): ClosedEntry;   // durationMs = endedAt - (links[0].startedAt ?? links[0].createdAt); sessions = links.length when > 1; error = firstLine(record.error) for failed; worktree/branch from record.worktree
export const renderClosedEntry = (data: unknown, theme: ThemeLike): string[] | undefined;   // undefined when data.v !== 1
```

Line (one string, whole line in one token): `${glyph} Agent "${truncateCols(singleLine(description), 60)}" ${sentence}${failed ? ": " + truncateCols(error, 120) : ""}` then details ` · `-joined: `formatDuration(durationMs)`; `${sessions} sessions` when set; worktree: `worktree removed` / `branch ${branch} kept` / `worktree kept`.

| state | text | token |
|---|---|---|
| done | `✓ Agent "Map the auth module" finished · 1m 5s` | `dim` |
| failed | `✗ Agent "Fix the login redirect" failed: tests failed twice · 2m 10s` | `error` |
| stopped | `■ Agent "Review the diff of PR 5" was stopped · 3m 2s` | `warning` |
| handoff | `↪ Agent "Map the auth module" handed off · 1h 2m · 2 sessions` | `warning` |

Registration at plugin enable (boot, before `session_start`): `host.registerEntryRenderer<ClosedEntry>(CLOSED_ENTRY, (data, _state, theme) => renderClosedEntry(data, theme))`. Resume renders from the entry alone; the registry is not consulted.

### Tests: `test/plugins/run-agent/completion.test.ts` (new)

- `"appends one dim line when a main-session agent finishes"`: finish child → `host.entries` has one `pi-subagents:agent-closed` with `v: 1`, `state: "done"`, `durationMs`; `host.renderEntry(CLOSED_ENTRY, data)` equals `["✓ Agent \"Map the auth module\" finished · 1m 5s"]` (fake clock).
- `"renders failed, stopped and handed off lines with their glyphs"`: three records → the table strings (plainTheme); with a coloured fake theme the token is `error`/`warning`.
- `"cuts the description at 60 and the error at 120 columns"`.
- `"prints nothing for children of agents"` (nested harness from `nesting.test.ts`: the grandchild closes → no entry).
- `"prints once at the end of a chain with the session count"` (successor-chain fixture: after link 1 hands off → no entry; after link 2 finishes → one entry `… finished · <chain duration> · 2 sessions`).
- `"waits for the worktree cleanup and names the outcome"` (worktree fixture: no entry at close; after `cleanup` → `… finished · 3s · worktree removed`; `branch kept` → `branch pi-agents/… kept`).
- `"hides entries of an unknown version"` (`renderEntry(CLOSED_ENTRY, { v: 2 })` → `undefined`).
- `"prints no line for agents interrupted by a session switch"` (start one agent, leave it running, `await host.shutdown("new")` → the record is `failed` with `interrupted: session new`, and `host.entries` has no `pi-subagents:agent-closed`).

## 6. The wake

### `outbox.ts`

```ts
export type OutboxItem = { batchId: string; text: string; agents: number };
type CallerChannel = { isBusy(): boolean; deliver(items: OutboxItem[]): void; onIdle(handler: () => void): void };
export type Outbox = { post(item: OutboxItem): void; pending(): number; clear(): OutboxItem[] };
```

`flush` delivers `held.splice(0)` as one array; the holding rules are unchanged (deliver at once when idle, else on the next idle, several batches together). `runner.ts` `checkBatch`: `callerOutbox(batch.callerId)?.post({ batchId: batch.id, text: batchText(batch.id), agents: terminals.length })`. Child outbox (`callerOutbox`): `deliver: (items) => void resume(callerId, (child) => child.wake(joinTexts(items)))` with `joinTexts = (items) => items.map((i) => i.text).join("\n\n---\n\n")` (exported from `outbox.ts`). `composeTask`'s `undelivered` keeps receiving texts: `runner.ts:346` becomes `undelivered: live.outbox?.clear().map((item) => item.text)`.

### `run-agent/index.ts`

```ts
const outbox = createOutbox({
  isBusy: () => !host.isIdle(),
  deliver: (items) => {
    const agents = items.reduce((sum, item) => sum + item.agents, 0);
    host.sendHiddenMessage(
      { customType: "pi-subagents:wake", text: joinTexts(items), details: { v: 1, batches: items.map((item) => item.batchId) } },
      `↳ ${formatAgents(agents)} finished`,
    );
  },
  onIdle: (handler) => host.onIdle(handler),
});
```

Idle: pi parks the hidden message and the visible user line `↳ 3 agents finished` starts the turn (`↳ 1 agent finished` singular; the count is chain terminals across the joined batches). The leading `↳` makes the line read as a system note: pi draws it in its user-message box, and it is replayed on resume, so without the glyph it would look as if the user had typed it. Busy: the hidden message joins the run as a follow-up and nothing visible appears. The batch text itself (`result.ts`) is unchanged; step 1 already made its helpers local (`statsText`, `finishSummary`, `cutChars`, a character cut because this is model text) and imports the rest from `format.ts`.

### `prompts/main-session.md`

Replace the "After starting a batch" section with:

```
# After starting a batch

- End your turn right after `run_agent` returns. You are woken once, when every agent of the batch is done, with all results in one message. That message is hidden from the user: they see only one short line per agent (`Agent "…" finished · 1m 5s`, or `failed: <reason>`) and, if you were idle, the line `↳ N agents finished`, which this extension sends to start your turn (the user did not type it). The agents' reports are not shown to the user: relay what matters (what was done or found, file paths, open points) in your reply.
- Do not poll, do not wait, and do not start the same work yourself.
- The user can keep talking to you while agents run. Answer them; the batch result arrives on its own.
```

The `run_agent` tool result text for the model stays `Started batch …: … You will be woken once when all agents are done. End your turn now.`

### Tests

- `run-agent.test.ts` `describe("outbox")`: `"delivers at once when idle and holds while busy"` and the others move from `post("text")` to `post({ batchId: "b-1", text: "text", agents: 1 })` and assert `deliver` received arrays.
- Every test asserting `host.sent` for a wake switches to the fake's `hidden` recorder (plan 01 §C): `run-agent.test.ts` (`"starts agents … wakes the caller once"`: `host.hidden` has one entry, `message.customType === "pi-subagents:wake"`, `message.text` contains `finished: 3 done`, `visible === "↳ 3 agents finished"`, `delivery === "nextTurn"`; `"defers the wake while the caller is mid-turn…"`: `delivery === "followUp"` when `host.idle = false`; `"merges batches that finish during one busy turn into a single wake"`: one entry, `details.batches` has two ids, `visible === "↳ 2 agents finished"` with one agent per batch; `"returns results directly and sends no wake when wait is true"`: `host.hidden` empty; `"marks running agents failed on shutdown and never wakes"`), `successor-chain.test.ts` (one wake, `visible === "↳ 1 agent finished"`), `stop-grace.test.ts`, `message-agent.test.ts`, `nesting.test.ts` (`host.hidden` stays empty for child batches), `worktree.test.ts`, `limits/limits.test.ts:118-139`, `agent-view/agent-view.test.ts:434`. `host.sent` stays for session-limits only.
- New: `"names a single finished agent in the singular"` (`visible === "↳ 1 agent finished"`).
- Live proof of the main prompt across a wake: plan 01 §C `core/test/adapter/wake.live.test.ts`; not duplicated here. `extensions/subagents/test/live/*.live.test.ts` `waitForWakes` (`test/helpers/live.ts`) switches to `host.hidden.length`.

## 7. `tools` service

`src/model/types.ts`: `export type ToolsService = { list(): AnyToolSpec[]; add(spec: AnyToolSpec): void }`; `ServiceMap` gains `tools: ToolsService`. An object rather than a shared array, so no plugin writes another plugin's array (finding 29). `run-agent/index.ts` provides it right after `services.provide("runner", …)`: `const specs: AnyToolSpec[] = [mainRunAgent, messageAgentTool(toolDeps)]; services.provide("tools", { list: () => [...specs], add: (spec) => { specs.push(spec); } });` where `mainRunAgent` is the spec `registerRunAgent` registers (the description re-registration replaces the entry in place: `specs[0] = spec`). `list()` returns a copy, so callers read it when they need the specs. `agent-status/index.ts`: `requires: ["agent-registry", "run-agent"]` and `services.require("tools").add(statusTool({ registry }))` after `host.registerTool`. Plan 06 passes `services.require("tools").list()` to `createTranscript({ tools })` each time the view opens; the specs render with the same `renderCall`/`renderResult` in the agent view (their `registry` is the main registry, so nested batches show live rows too). Test: `test/plugins/run-agent/run-agent.test.ts` `"exposes run_agent, message_agent and agent_status through the tools service"` (`list()` names in order; without agent-status only two; mutating the returned array does not change the next `list()`). `agent-status.test.ts` harnesses add `runAgentPlugin` (and `agentDefinitionsPlugin`) to their plugin lists.

## 8. Settings

No code change in `src/model/settings.ts` (`renderThrottleMs` 250, 0–10 000). `renderThrottleMs` now governs every agent surface: the `run_agent` block, the panel, the `/agents` list and the agent view. This plan does not edit the README "Other keys" sentence; plan 05 owns its final text and states this there. The completion lines are appended once and never redrawn.

## 9. README and ARCHITECTURE text

`extensions/subagents/README.md` "Use", replace the first bullet and add two after it (the widget/`/agents` bullets belong to plans 05 and 06):

- `Ask for work that splits well ("find every place we parse dates and review them"). The main session calls `run_agent` and ends its turn. The call shows a start block: `3 background agents launched (↓ to manage)` with one row per agent (`explorer (Map the auth module) · provider/id:thinking`) and a status line that updates while the batch runs: `Queued`, `Initializing…`, `Running in the background`, `Needs input: <title>`, then `Done · 4 tool uses · 12.3k tokens · 1m 5s`, `Failed: <reason>`, `Stopped …` or `Handed off …`. With `wait: true` the header reads `Running 3 agents…` and the rows count tool uses and tokens live; when the call returns it reads `3 agents finished`. The block stops updating when the batch is done; after `/reload` or a resume its rows say `Status unavailable · /agents <id>`.`
- `Each agent of the main session adds one dim line to the transcript when it closes: `✓ Agent "Map the auth module" finished · 1m 5s`, `✗ Agent "…" failed: <reason> · 2m 10s`, `■ Agent "…" was stopped · 3s`, `↪ Agent "…" handed off · 1h 2m`, with `2 sessions` for an agent that continued itself and `worktree removed`, `branch <branch> kept` or `worktree kept` for worktree agents (printed when the cleanup is done). Agents started by agents print nothing, and neither do agents interrupted by a session switch (`/new`, `/resume`, `/reload`, quitting). The lines are kept in the session file and shown again on resume.`
- `When the whole batch is done the main session is woken with every result in one message that is hidden from the transcript. If the main session was idle, a short line `↳ 3 agents finished` starts its turn; if it was busy, the results join the running turn and nothing new appears. The model is told that you saw only the one-line summaries and must relay what matters. An interrupted `wait: true` call shows `✗ No agents started` as its header: pi replaces the result with its abort error; the agents were stopped and their lines say so.`

Replace in the model bullet: "is shown in the start message, the progress row, `agent_status` and the agent's manifest" → "is shown in the start block, `agent_status`, the agent view header and the agent's manifest".

`ARCHITECTURE.md` "A run_agent call, end to end":

- Step 2: `Registry creates one record per agent (`queued`), writes `manifest.json`, emits `agent:changed`. The tool reports the batch through `update(text, details)` at once (`details.agents`: id, agent, description, model), returns ids and tells the model to end its turn (`wait: true` blocks until the batch settles instead). The block renders with `renderShell: "self"`: `renderCall` draws `⠹ Running N agents…` while pi's `isPartial` is set and nothing afterwards; `renderResult` draws the rows from the registry (chain terminals, chain totals) and, once final, the header (`N background agents launched (↓ to manage)` while any record is open, `N agents finished` for `wait`). The stored `invalidate` re-renders at most every `renderThrottleMs` after an `agent:changed` of the batch and once more at `batch:settled`; without a record (resume, `/reload`) a row reads `Status unavailable · /agents <id>`.`
- Step 8: `When every record of the batch is closed and every worktree cleanup is done, `batch:settled` fires and the batch text (one `## <id> (<agent>) - <state>` section per chain terminal; results inline up to `inlineResultChars`, otherwise path and preview) is posted to the caller's outbox with the batch id and its terminal count. Separately, every closed record whose caller is `main` and which has no successor appends a `pi-subagents:agent-closed` entry (`{ v: 1, id, agent, description, state, durationMs, error?, sessions?, worktree?, branch? }`; for a worktree agent once `worktree.cleanup` is known); the entry renderer registered at boot draws one line (`✓ Agent "…" finished · 1m 5s`) and resume redraws it from the entry alone. Nothing is appended once run-agent's session-shutdown handler has started, so agents interrupted by a session switch print no line.`
- Step 9: `Outbox: for the main session it holds items while pi is busy and flushes them on the next idle (or at once when idle) through `Host.sendHiddenMessage`: the joined texts as a `pi-subagents:wake` hidden message (`details.batches`) plus the visible line `↳ N agents finished` (terminals across the flushed batches) that starts the turn when the session was idle; while busy the hidden message joins the run as a follow-up. For an agent caller it re-acquires a slot and wakes that child with a follow-up prompt.`

"Status, views, notifications" (renamed `Status and views` by plan 03). Its final content after plans 03–06 is the numbered list below. Each plan writes only the bullets it owns, and plans 05 and 06 refer to this list (not to "the second bullet"):

1. `agent_status` (no owner, unchanged): `` `agent_status` reads in-memory records only; it never touches the agent. ``
2. Shared surfaces (plan 04, a new bullet inserted after bullet 1; it replaces nothing): `` Every surface reads the same clock, spinner (`components/spinner.ts`, frame from `Date.now()`), formatters (`components/format.ts`, which re-exports `formatTokens` and `formatDuration` from `core/manager/format.ts`) and state words (`components/state-text.ts`); the record's `activity` (last top-level tool name or first line of the last assistant text, set by the runner, not persisted) feeds the panel. The `tools` service (`{ list(), add(spec) }`, provided by `run-agent`; `agent-status` adds its spec) carries the three tool specs so the agent view renders nested calls with the main session's renderers. Re-render throttling is `renderThrottleMs` everywhere. ``
3. The agent panel (plan 05): plan 05 §7's paragraph (`` The agent panel (`agent-panel`) renders the registry in tree order … ``); it replaces today's widget bullet (`The progress widget and list view re-render …`).
4. The `/agents` list (plan 06): plan 06 §8's sentence (`` The `/agents` list re-renders on `agent:changed` … ``).
5. The agent view (plan 06): plan 06 §8's agent-view paragraph (`The agent view shares the list's overlay …`); it replaces today's agent-view bullet.

The notifications bullet (`Notifications (terminal escape sequence) fire for …`) is deleted by plan 03 together with the rename. Until plans 05 and 06 land, today's widget and agent-view bullets stay below bullet 2.

## 10. Order of work

Depends on plan 01 §C (`sendHiddenMessage`, `registerEntryRenderer`, fake `hidden`/`renderEntry`) and §D (`ToolRenderState`, `renderShell`, `update(text, details)`, fake `renderTool`). Nothing here needs §A, §B, §E–§H.

0. `core/manager/format.ts` (`formatTokens`, `formatDuration`; only `formatTokens` if plan 02 already created the file) + `core/test/manager/format.test.ts`; the footer imports `formatTokens` from it and drops its copy and its `"formats token counts"` case; `ARCHITECTURE.md` line 8 and the `STRUCTURE.md` `core/manager/` tree name the file. `npm run check`.
1. `format.ts` (re-exporting the core formatters), `spinner.ts`, `state-text.ts` + tests; trim `agent-row.ts`; move `plural`/`statsText`/`finishSummary` and a `cutChars` into `result.ts` and `graceSecondsLeft`, `plural` and a `cutChars` into `snapshot.ts`; repoint `model-text.ts`, `result.ts`, `snapshot.ts`, `context-breakdown.ts`; delete the agent-row format test and drop `formatElapsed`/`formatTokens` from `test/components/agent-row.test.ts`'s imports. `npm run check`.
2. `activity` (types, runner, tests). `npm run check`.
3. `render.ts`, `tools.ts` (`renderShell`, `update`, details `agents`, params from `state.args`), `index.ts` invalidation (`batch:settled`, `safeInvalidate`), `render.test.ts`. `npm run check`.
4. `completion.ts`, listener (with the `shuttingDown` guard) and renderer in `index.ts`, `completion.test.ts`. `npm run check`.
5. Outbox items, `sendHiddenMessage`, prompt text, test migration from `host.sent` to `host.hidden`, live helper. `npm run check`; then `npm run test:live` locally (existing suites, `waitForWakes` on `hidden`).
6. `tools` service (`{ list(), add() }`), agent-status `requires` and `add`, tests. README, ARCHITECTURE, STRUCTURE (`components/`: add `format.ts, spinner.ts, state-text.ts`; `run-agent/`: add `render.ts (block), completion.ts (closed lines)`). `npm run check`.

Manual checklist (`pi` in a git project, shipped agents): fullscreen TUI: start 3 agents with `wait: false`, watch the header switch from spinner to `launched (↓ to manage)`, rows through `Initializing…` → `Running in the background` → `Done …`, one dim line per agent, header losing the hint, the `↳ 3 agents finished` user line, the model's reply; `wait: true`: spinner header with live `Running · N tool uses · …` rows, then `N agents finished`; during `wait: true` the spinner header moves only on agent events (each throttled redraw), not at 10 fps: a declared deviation, so a spinner that pauses between agent events is expected, not a freeze; `/new` while an agent runs, then `/resume` the old session: no `✗ … interrupted` line; a worktree agent: suffix on the row and the line; stop an agent with `x` in `/agents`: `Stopping…` then `■ … was stopped`; `/reload` then scroll: rows read `Status unavailable · /agents <id>`, completion lines still there; `/resume` the session: same; a bad agent name: `✗ No agents started: …`, `Ctrl+O` shows the full error. `regular` tui mode (`tuiMode: "regular"` in pi settings): the block above the viewport redraws on each invalidation, which clears the scrollback (`pi-api-capabilities.md` Need 4). **Decision: accept, no age cutoff.** Updates are throttled and end at `batch:settled`; a cutoff would freeze visible blocks in fullscreen (the default) for a cost that only the non-default mode pays. Verify in regular mode that the block still settles correctly and that the completion lines and the user line appear.

Risks: pi's `isPartial` semantics change → the header would print twice; pinned by `conformance.test.ts` (plan 01 §D) and `render.test.ts`. The shared `Text` wrapping at narrow widths (`BLOCK_WIDTH` 100) → rows wrap below 100 columns; accepted for this plan, plan 05's panel is width-aware.
