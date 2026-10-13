# Plan 04: main transcript (run_agent block, completion lines, wake, shared modules)

Implements `plans/00-ux-spec.md` §2 and §3 (Surface A) on top of `plans/01-adapter-foundations.md` §C (`sendHiddenMessage`, `registerEntryRenderer`) and §D (`ToolRenderState`, `renderShell`, `update(text, details)`, `createTranscript({ tools })`). Owns the shared modules listed in `plans/research/shared-modules.md` for plan 04. Paths are relative to `extensions/subagents/` unless they start with `core/`.

## 1. Goal

1. `run_agent` renders as one self-shelled block: a spinner header while the tool runs, then `N background agents launched (↓ to manage)` or `N agents finished`, with one tree-connected row per agent whose status line updates live until the batch settles.
2. Every agent of the main session adds exactly one dim completion line when it closes (after worktree cleanup for worktree agents); the model never sees it; resume renders it again from the persisted entry.
3. The batch text reaches the model as a hidden message; when the session was idle a `3 agents finished` user line starts the turn.
4. One set of formatters (`format.ts`), one spinner (`spinner.ts`), one state vocabulary (`state-text.ts`), used by plans 05 and 06 as given.
5. The record gains `activity` so the panel can show `grep · 1m 5s`.
6. `renderThrottleMs` governs every surface; the `tools` service exposes the three tool specs for the agent view.
7. The model is told that the user saw only one-line summaries and must relay what matters.
8. No new setting, no new file on disk, no provider knowledge.

What the user sees, end to end (mockups: spec §3 "Mockups"): the model calls `run_agent`; the block appears with `⠹ Running 3 agents…` and rows at `Queued`/`Initializing…`; the tool returns and the header becomes `3 background agents launched (↓ to manage)`; rows move to `Running in the background`, `Needs input: Run npm test?`, then `Done · 4 tool uses · 12.3k tokens · 1m 5s`; under the block, as each agent closes, one dim line `✓ Agent "Map the auth module" finished · 1m 5s` is appended; when the last agent closes the header drops `(↓ to manage)`, the live updates stop, and, if the session is idle, a user-message box `3 agents finished` starts the turn (busy: nothing visible, the results join the run); the working indicator runs and the model's reply follows.

## 2. Shared modules (owner)

### `src/components/format.ts`

```ts
export const SEP = " · ";

export const formatTokens = (n: number): string =>
  n < 1_000 ? `${n}` : n < 1_000_000 ? `${(n / 1_000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

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

Notes: `truncateCols` takes plain text (no ANSI); callers colour after cutting. `charWidth` is exported so plan 05 can measure a prefix without re-scanning. Braille frames, `✓ ✗ ○ ◐ ■ ↪ ├ └ │ ─ …` are width 1. `singleLine`, `firstLine`, `elapsedOf` are additions to the shared-modules signature list (today's `singleLine`/`elapsedOf` live in `agent-row.ts`; `firstLine` is used by the status lines and completion lines). The `formatTokens` duplicate in `extensions/footer/src/render.ts` stays (separate extension; known duplicate).

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

Delete `SPINNER_FRAMES`, `STATE_ICONS`, `STATE_COLORS`, `formatTokens`, `formatElapsed`, `elapsedOf`, `singleLine`, `plural`. Keep (until plan 05 rewrites the file) `stateIcon(state, frame)` reimplemented as `state === "running" ? SPINNER_FRAMES[frame % 10] : stateGlyph(state, 0)`, `finishSummary`, `progressText`, `truncate`, `chainLabel`, `attentionText`, `graceSecondsLeft`, `agentRow`, `treeRow`, with `statsText` importing `formatTokens`/`formatDuration`/`elapsedOf` from `format.ts` and colours from `stateToken`. Plan 05 must not re-add any removed helper; it imports `format.ts`/`state-text.ts`. Repoint importers now: `plugins/run-agent/model-text.ts` (`formatTokens`), `plugins/run-agent/result.ts` (`singleLine`; `truncate` stays from agent-row until plan 05, then `truncateCols` is wrong for model text: keep a char cut; see §6), `plugins/agent-status/snapshot.ts` (`elapsedOf`, `formatElapsed`→`formatDuration`, `formatTokens`, `singleLine`; `plural` → local `formatToolUses`? no: `agent_status` text says `4 tool calls` and is model-facing; keep a local `plural` in `snapshot.ts`), `components/context-breakdown.ts` (`formatTokens`; plan 06 deletes the file). `test/components/agent-row.test.ts`: delete `"formats tokens and elapsed time compactly"` (covered below); the rest stays until plan 05.

### Tests

`test/components/format.test.ts`:
- `"formats tokens as 999, 1.0k, 12.3k, 1.2M"`: `formatTokens(999) === "999"`, `formatTokens(1000) === "1.0k"`, `formatTokens(12_345) === "12.3k"`, `formatTokens(1_234_567) === "1.2M"`, `formatTokens(0) === "0"`.
- `"formats durations as seconds, minutes and hours"`: `0 → "0s"`, `3_000 → "3s"`, `62_000 → "1m 2s"`, `75_000 → "1m 15s"`, `3_600_000 → "1h 0m"`, `3_720_000 → "1h 2m"`, `-5 → "0s"`.
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

Header rules (`renderBlock`, final result): `result.isError && !result.details?.batchId` → `theme.fg("error", "✗ No agents started: " + firstLine(result.text))`, plus, when `state.expanded`, every line of `result.text` indented by 3 spaces (no rows). Otherwise `n = details.agents.length`; `wait === true` → `${bold(n)} ${n === 1 ? "agent" : "agents"} finished`; `wait !== true` → `${bold(n)} background ${agent(s)} launched` + (any record of `registry.batch(batchId)` open → ` ` + dim(`(↓ to manage)`)). After a rebuild with no records the header has no hint. `renderRunningHeader`: `${fg("accent", spinnerFrame(now))} Running ${bold(n)} ${agent(s)}…` with `n = (params.agents ?? []).length`; `n === 0` (args still streaming) → `⠹ Running agents…`.

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
- Spec: `renderShell: "self"`, `renderCall: (params, theme, state) => state.isPartial ? renderRunningHeader(params, theme, now()) : ""`, `renderResult: (result, state, theme) => { if (result.details?.batchId) deps.onRendered?.(result.details.batchId, state.invalidate); return renderBlock({ params: lastParams, result, state, registry, theme, now: now() }); }`. `renderResult` has no params: `renderCall` stores `params` per `state.toolCallId` in a `Map` on the spec closure (`wait` is the only field read; evict the entry when the batch settles or on disable). In the agent view (plan 06, same spec objects) the same map works since pi passes a real `toolCallId`.
- The error header on an aborted `wait: true` call: pi replaces the result with its own abort error without `details`, so the block shows `✗ No agents started: …`; accepted (the agents were stopped by `onAbort` and their completion lines say `was stopped`). Noted in README (§9).

### Live updates (`run-agent/index.ts`)

Keep the `invalidators: Map<batchId, invalidate>` and the single pending timer (`index.ts:77-104`), throttled by `settings.renderThrottleMs` as today. Changes: stop at `batch:settled` instead of polling `isClosed`: `bus.on("batch:settled", ({ batchId }) => { invalidators.get(batchId)?.(); invalidators.delete(batchId); paramsByCall cleanup })` (fires after worktree cleanup, `runner.ts:checkBatch` after `release`, so the final render shows the suffix and no hint). The `agent:changed` listener stays. Spinner: `spinnerFrame(Date.now())` at render time; the header animates only when something invalidates (each throttled `agent:changed`); no timer is added (spec §3 "never schedules its own timer"; deviation noted: during `wait: true` the frame moves with agent activity, not at 10 fps). Width: no width reaches the renderer; `BLOCK_WIDTH = 100` bounds the description and pi truncates longer lines (adapter `textComponent` → pi `Text`, which wraps; acceptable at ≥ 100 columns, wraps below).

### Tests: `test/plugins/run-agent/render.test.ts` (new)

Setup: `createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin])`, start a batch through `host.tool("run_agent").execute` with `update` recording details, `plainTheme`, `host.renderTool("run_agent", { call, result, state })` from plan 01 §D with `state` overrides, `now` injected via `deps.now` (export a `createRunAgentDeps`-free path: `runAgentTool(deps, description)` is exported; build it directly with `{ runner, registry, now: () => NOW }`).

- `"shows the spinner header with the agent count while partial"`: `renderCall` with `isPartial: true`, 3 agents, `NOW = 250` → `"⠹ Running 3 agents…"`; 1 agent → `"⠹ Running 1 agent…"`; `agents` undefined → `"⠹ Running agents…"`.
- `"renders nothing for the call once the result is final"`: `isPartial: false` → `""`.
- `"renders rows only while the result is partial"` (`wait: true`, after `update`): no header line, 3 rows.
- `"headers: launched with hint, launched without hint, finished"`: open batch → `3 background agents launched (↓ to manage)`; all closed → `3 background agents launched`; `wait: true` → `3 agents finished`; singular `1 background agent launched (↓ to manage)`.
- `"status lines per state"`: one assertion per row of the spec table: `Queued`, `Initializing…`, `Running in the background`, `Running · 4 tool uses · 12.3k tokens` (wait), `Running · 4 tool uses` (0 tokens), `Needs input: Run npm test?`, `Stopping…`, `Done · 4 tool uses · 12.3k tokens · 1m 5s`, `Failed: tests failed twice` (error `"tests failed twice\nstack"`), `Stopped · 0 tool uses · 3s`, `Handed off · 4 tool uses · 12.3k tokens · 1h 2m`.
- `"appends the worktree outcome to closed rows"`: `worktree removed`, `branch pi-agents/x-1 kept`, `worktree kept`; nothing while open.
- `"renders a chain as one row with #n and summed stats"`: predecessor 2 tool uses + successor 3 → `explorer #2 (…)` and `Done · 5 tool uses · …`, duration from the first link's start.
- `"cuts the description to the width and drops the model first"`: 120-char description → line 1 width ≤ 100, ends with `…)`, no model; short description keeps ` · fake/model:high`.
- `"renders the error header and the full error when expanded"`: `isError` result `"unknown agent(s): x. Available: explorer\nNothing was started."` → collapsed `✗ No agents started: unknown agent(s): x. Available: explorer` only; expanded adds `   unknown agent(s)…` and `   Nothing was started.`.
- `"falls back to Status unavailable after a rebuild without records"`: fresh registry → `├─ explorer (Map the auth module) · fake/model:high` / `│  Status unavailable · /agents explorer-abc`; header `3 background agents launched`.
- `"invalidates at most once per renderThrottleMs and stops at batch:settled"`: `renderThrottleMs: 50`, fake timers; three `agent:changed` in 10 ms → one `invalidate`; after `batch:settled` a further `agent:changed` of that batch → no call; the settle itself calls `invalidate` once (final frame).

Existing `test/plugins/run-agent/run-agent.test.ts` `"starts agents in the background…"` keeps asserting `result.text` contains `Started batch`; add `expect(result.details.agents).toHaveLength(3)`.

## 5. Completion lines

### Where

`run-agent/index.ts`, after the runner is created. Listener `bus.on("agent:closed", (record) => …)`:
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
      `${formatAgents(agents)} finished`,
    );
  },
  onIdle: (handler) => host.onIdle(handler),
});
```

Idle: pi parks the hidden message and the visible user line `3 agents finished` starts the turn (`1 agent finished` singular; the count is chain terminals across the joined batches). Busy: the hidden message joins the run as a follow-up and nothing visible appears. The batch text itself (`result.ts`) is unchanged, except its imports: `singleLine` from `format.ts`, `truncate` stays a char cut (model text; keep it in `result.ts` as a local `cutChars` once plan 05 deletes `agent-row.ts`'s `truncate`; this plan leaves the import as is).

### `prompts/main-session.md`

Replace the "After starting a batch" section with:

```
# After starting a batch

- End your turn right after `run_agent` returns. You are woken once, when every agent of the batch is done, with all results in one message. That message is hidden from the user: they see only one short line per agent (`Agent "…" finished · 1m 5s`, or `failed: <reason>`) and, if you were idle, a line that says how many agents finished. The agents' reports are not shown to the user: relay what matters (what was done or found, file paths, open points) in your reply.
- Do not poll, do not wait, and do not start the same work yourself.
- The user can keep talking to you while agents run. Answer them; the batch result arrives on its own.
```

The `run_agent` tool result text for the model stays `Started batch …: … You will be woken once when all agents are done. End your turn now.`

### Tests

- `run-agent.test.ts` `describe("outbox")`: `"delivers at once when idle and holds while busy"` and the others move from `post("text")` to `post({ batchId: "b-1", text: "text", agents: 1 })` and assert `deliver` received arrays.
- Every test asserting `host.sent` for a wake switches to the fake's `hidden` recorder (plan 01 §C): `run-agent.test.ts` (`"starts agents … wakes the caller once"`: `host.hidden` has one entry, `message.customType === "pi-subagents:wake"`, `message.text` contains `finished: 3 done`, `visible === "3 agents finished"`, `delivery === "nextTurn"`; `"defers the wake while the caller is mid-turn…"`: `delivery === "followUp"` when `host.idle = false`; `"merges batches that finish during one busy turn into a single wake"`: one entry, `details.batches` has two ids, `visible === "2 agents finished"` with one agent per batch; `"returns results directly and sends no wake when wait is true"`: `host.hidden` empty; `"marks running agents failed on shutdown and never wakes"`), `successor-chain.test.ts` (one wake, `visible === "1 agent finished"`), `stop-grace.test.ts`, `message-agent.test.ts`, `nesting.test.ts` (`host.hidden` stays empty for child batches), `worktree.test.ts`, `limits/limits.test.ts:118-139`, `agent-view/agent-view.test.ts:434`. `host.sent` stays for session-limits only.
- New: `"names a single finished agent in the singular"`.
- Live proof of the main prompt across a wake: plan 01 §C `core/test/adapter/wake.live.test.ts`; not duplicated here. `extensions/subagents/test/live/*.live.test.ts` `waitForWakes` (`test/helpers/live.ts`) switches to `host.hidden.length`.

## 7. `tools` service

`src/model/types.ts` `ServiceMap` gains `tools: AnyToolSpec[]`. `run-agent/index.ts` provides it right after `services.provide("runner", …)`: `const tools: AnyToolSpec[] = [mainRunAgent, messageAgentTool(toolDeps)]; services.provide("tools", tools);` where `mainRunAgent` is the spec `registerRunAgent` registers (the description re-registration replaces the array entry in place: `tools[0] = spec`). `agent-status/index.ts`: `requires: ["agent-registry", "run-agent"]` and `services.require("tools").push(statusTool({ registry }))` after `host.registerTool`. Plan 06 passes `services.require("tools")` to `createTranscript({ tools })`; the specs render with the same `renderCall`/`renderResult` in the agent view (their `registry` is the main registry, so nested batches show live rows too). Test: `test/plugins/run-agent/run-agent.test.ts` `"exposes run_agent, message_agent and agent_status through the tools service"` (names in order; without agent-status only two). `agent-status.test.ts` harnesses add `runAgentPlugin` (and `agentDefinitionsPlugin`) to their plugin lists.

## 8. Settings

No code change in `src/model/settings.ts` (`renderThrottleMs` 250, 0–10 000). README "Other keys" sentence becomes: `` `renderThrottleMs` (250; minimum time between redraws of every agent surface: the `run_agent` block, the panel, the `/agents` list and the agent view) ``. The completion lines are appended once and never redrawn.

## 9. README and ARCHITECTURE text

`extensions/subagents/README.md` "Use", replace the first bullet and add two after it (the widget/`/agents` bullets belong to plans 05 and 06):

- `Ask for work that splits well ("find every place we parse dates and review them"). The main session calls `run_agent` and ends its turn. The call shows a start block: `3 background agents launched (↓ to manage)` with one row per agent (`explorer (Map the auth module) · provider/id:thinking`) and a status line that updates while the batch runs: `Queued`, `Initializing…`, `Running in the background`, `Needs input: <title>`, then `Done · 4 tool uses · 12.3k tokens · 1m 5s`, `Failed: <reason>`, `Stopped …` or `Handed off …`. With `wait: true` the header reads `Running 3 agents…` and the rows count tool uses and tokens live; when the call returns it reads `3 agents finished`. The block stops updating when the batch is done; after `/reload` or a resume its rows say `Status unavailable · /agents <id>`.`
- `Each agent of the main session adds one dim line to the transcript when it closes: `✓ Agent "Map the auth module" finished · 1m 5s`, `✗ Agent "…" failed: <reason> · 2m 10s`, `■ Agent "…" was stopped · 3s`, `↪ Agent "…" handed off · 1h 2m`, with `2 sessions` for an agent that continued itself and `worktree removed`, `branch <branch> kept` or `worktree kept` for worktree agents (printed when the cleanup is done). Agents started by agents print nothing. The lines are kept in the session file and shown again on resume.`
- `When the whole batch is done the main session is woken with every result in one message that is hidden from the transcript. If the main session was idle, a short line `3 agents finished` starts its turn; if it was busy, the results join the running turn and nothing new appears. The model is told that you saw only the one-line summaries and must relay what matters. An interrupted `wait: true` call shows `✗ No agents started` as its header: pi replaces the result with its abort error; the agents were stopped and their lines say so.`

Replace in the model bullet: "is shown in the start message, the progress row, `agent_status` and the agent's manifest" → "is shown in the start block, `agent_status`, the agent view header and the agent's manifest".

`ARCHITECTURE.md` "A run_agent call, end to end":

- Step 2: `Registry creates one record per agent (`queued`), writes `manifest.json`, emits `agent:changed`. The tool reports the batch through `update(text, details)` at once (`details.agents`: id, agent, description, model), returns ids and tells the model to end its turn (`wait: true` blocks until the batch settles instead). The block renders with `renderShell: "self"`: `renderCall` draws `⠹ Running N agents…` while pi's `isPartial` is set and nothing afterwards; `renderResult` draws the rows from the registry (chain terminals, chain totals) and, once final, the header (`N background agents launched (↓ to manage)` while any record is open, `N agents finished` for `wait`). The stored `invalidate` re-renders at most every `renderThrottleMs` after an `agent:changed` of the batch and once more at `batch:settled`; without a record (resume, `/reload`) a row reads `Status unavailable · /agents <id>`.`
- Step 8: `When every record of the batch is closed and every worktree cleanup is done, `batch:settled` fires and the batch text (one `## <id> (<agent>) - <state>` section per chain terminal; results inline up to `inlineResultChars`, otherwise path and preview) is posted to the caller's outbox with the batch id and its terminal count. Separately, every closed record whose caller is `main` and which has no successor appends a `pi-subagents:agent-closed` entry (`{ v: 1, id, agent, description, state, durationMs, error?, sessions?, worktree?, branch? }`; for a worktree agent once `worktree.cleanup` is known); the entry renderer registered at boot draws one line (`✓ Agent "…" finished · 1m 5s`) and resume redraws it from the entry alone.`
- Step 9: `Outbox: for the main session it holds items while pi is busy and flushes them on the next idle (or at once when idle) through `Host.sendHiddenMessage`: the joined texts as a `pi-subagents:wake` hidden message (`details.batches`) plus the visible line `N agents finished` (terminals across the flushed batches) that starts the turn when the session was idle; while busy the hidden message joins the run as a follow-up. For an agent caller it re-acquires a slot and wakes that child with a follow-up prompt.`

"Status, views, notifications", replace the widget sentence with: `Every surface reads the same clock, spinner (`components/spinner.ts`, frame from `Date.now()`), formatters (`components/format.ts`) and state words (`components/state-text.ts`); the record's `activity` (last top-level tool name or first line of the last assistant text, set by the runner, not persisted) feeds the panel. The `tools` service (`run-agent`, appended by `agent-status`) carries the three tool specs so the agent view renders nested calls with the main session's renderers. Re-render throttling is `renderThrottleMs` everywhere.`

## 10. Order of work

Depends on plan 01 §C (`sendHiddenMessage`, `registerEntryRenderer`, fake `hidden`/`renderEntry`) and §D (`ToolRenderState`, `renderShell`, `update(text, details)`, fake `renderTool`). Nothing here needs §A, §B, §E–§H.

1. `format.ts`, `spinner.ts`, `state-text.ts` + tests; trim `agent-row.ts`; repoint `model-text.ts`, `result.ts`, `snapshot.ts`, `context-breakdown.ts`; delete the agent-row format test. `npm run check`.
2. `activity` (types, runner, tests). `npm run check`.
3. `render.ts`, `tools.ts` (`renderShell`, `update`, details `agents`, params map), `index.ts` invalidation (`batch:settled`), `render.test.ts`. `npm run check`.
4. `completion.ts`, listener and renderer in `index.ts`, `completion.test.ts`. `npm run check`.
5. Outbox items, `sendHiddenMessage`, prompt text, test migration from `host.sent` to `host.hidden`, live helper. `npm run check`; then `npm run test:live` locally (existing suites, `waitForWakes` on `hidden`).
6. `tools` service, agent-status `requires`, tests. README, ARCHITECTURE, STRUCTURE (`components/`: add `format.ts, spinner.ts, state-text.ts`; `run-agent/`: add `render.ts (block), completion.ts (closed lines)`). `npm run check`.

Manual checklist (`pi` in a git project, shipped agents): fullscreen TUI: start 3 agents with `wait: false`, watch the header switch from spinner to `launched (↓ to manage)`, rows through `Initializing…` → `Running in the background` → `Done …`, one dim line per agent, header losing the hint, the `3 agents finished` user line, the model's reply; `wait: true`: spinner header with live `Running · N tool uses · …` rows, then `N agents finished`; a worktree agent: suffix on the row and the line; stop an agent with `x` in `/agents`: `Stopping…` then `■ … was stopped`; `/reload` then scroll: rows read `Status unavailable · /agents <id>`, completion lines still there; `/resume` the session: same; a bad agent name: `✗ No agents started: …`, `Ctrl+O` shows the full error. `regular` tui mode (`tuiMode: "regular"` in pi settings): the block above the viewport redraws on each invalidation, which clears the scrollback (`pi-api-capabilities.md` Need 4). **Decision: accept, no age cutoff.** Updates are throttled and end at `batch:settled`; a cutoff would freeze visible blocks in fullscreen (the default) for a cost that only the non-default mode pays. Verify in regular mode that the block still settles correctly and that the completion lines and the user line appear.

Risks: pi's `isPartial` semantics change → the header would print twice; pinned by `conformance.test.ts` (plan 01 §D) and `render.test.ts`. The shared `Text` wrapping at narrow widths (`BLOCK_WIDTH` 100) → rows wrap below 100 columns; accepted for this plan, plan 05's panel is width-aware.
