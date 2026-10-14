# Shared modules and ownership between the feature plans

Updated 2026-10-14 after the review (`plans/research/review-findings.md`), and again for the padding rules (`PAD`, `innerWidth`, `alignRight` move to `format.ts`, see `padding.md`).

The feature plans (02–06) are written in parallel. To fit together they use these module names and signatures exactly. The owning plan specifies the module in full (file, code, tests); the other plans only import it. If an owner needs to deviate, it says so in its plan and the README index records the change.

## `extensions/subagents/src/components/format.ts` (owner: plan 04)

```ts
export const SEP = " · ";
export const formatTokens = (n: number): string;        // 842, 12.3k, 1.2M (spec §2)
export const formatDuration = (ms: number): string;     // 3s, 1m 2s, 1h 2m
export const formatToolUses = (n: number): string;      // 1 tool use, 4 tool uses
export const formatAgents = (n: number): string;        // 1 agent, 3 agents
export const formatCtx = (percent: number | undefined): string | undefined; // "23% ctx" or undefined
export const displayWidth = (text: string): number;     // display columns (wide chars = 2, combining = 0, ANSI stripped)
export const truncateCols = (text: string, cols: number): string; // cut to cols with a trailing "…" (plain text only)
export const padEndCols = (text: string, cols: number): string;
export const PAD = " ";                                   // one-column left margin of every widget and overlay line (spec §2 "Padding and margins")
export const innerWidth = (width: number): number;      // Math.max(1, width - 2 * PAD.length): content width, the last column stays blank
export const alignRight = (left: string, right: string, cols: number): string | undefined;  // padEndCols(left, cols - displayWidth(right)) + right; undefined when displayWidth(left) + 2 + displayWidth(right) > cols
export const charWidth = (char: string): number;        // display columns of one code point (0, 1 or 2)
export const singleLine = (text: string): string;       // whitespace runs collapsed to one space, trimmed
export const firstLine = (text: string): string;        // first non-empty line, trimmed
export const elapsedOf = (record: { startedAt?: number; createdAt: number; endedAt?: number }, now: number): number;  // (endedAt ?? now) - (startedAt ?? createdAt)
export { formatDuration, formatTokens } from "../../../../core/manager/format.ts";   // re-exported, defined in core/manager
```

`formatTokens` and `formatDuration` live in `core/manager/format.ts` (owner: plan 04 step 0; pi-free, tested in `core/test/manager/format.test.ts`), which every extension may import (`ARCHITECTURE.md`); `components/format.ts` re-exports them. The footer (`extensions/footer/src/render.ts` drops its own `formatTokens`) and the working indicator (no `src/format.ts`) import from `core/manager/format.ts`. The copies in `components/agent-row.ts` go. Plans 05 and 06 import `singleLine`, `firstLine`, `elapsedOf` and the formatters from `components/format.ts` and define no local text helpers.

## `extensions/subagents/src/components/spinner.ts` (owner: plan 04)

```ts
export const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
export const spinnerFrame = (now: number): string;      // SPINNER_FRAMES[Math.floor(now / 100) % 10]
```

## `extensions/subagents/src/components/state-text.ts` (owner: plan 04)

```ts
import type { AgentState } from "../model/types";
export const stateGlyph = (state: AgentState, now: number): string;    // spinner frame for running
export const stateToken = (state: AgentState): ThemeToken;             // spec §2 table
export const stateWord = (state: AgentState): string;                  // rows/subtitle word: queued, running, stopping, done, failed, stopped, handed off
export const stateSentence = (state: AgentState): string;              // sentences: finished, failed, was stopped, handed off
```

## `extensions/subagents/src/components/refresh.ts` (owner: plan 05, replaces today's file)

```ts
export const createThrottle = (fn: () => void, ms: () => number): { call(): void; cancel(): void };  // keep today's semantics
export const watchAgents = (bus, options: {
  relevant: (record: AgentRecord) => boolean;
  tickMs: () => number | undefined;     // 100 while any relevant record is running/grace, 1000 while only queued/closed rows are shown, undefined for no ticker (spec §2)
  throttleMs: () => number;             // settings.renderThrottleMs
  onChange: () => void;
}): () => void;                          // unsubscribe
```

## `extensions/subagents/src/components/agent-row.ts` (owner: plan 05, rewritten)

```ts
export type RowInput = { record: AgentRecord; depth: number; last: boolean; ancestorsContinue: boolean[]; openDescendants: number; selected: boolean };
export const renderRow = (input: RowInput, now: number, width: number, theme: ThemeLike, nameCols: number): string;   // spec §4 row grammar, one line
export const nameColumn = (rows: Pick<TreeRow, "record" | "openDescendants">[]): number;   // widest name (+ chain suffix + (+N)), capped at 24; plan 06 passes sections.flatMap((s) => s.rows)
```

`PAD` (one column) and `innerWidth` come from `format.ts`; `agent-row.ts` does not export `PAD`. Every panel, list and view line starts with `PAD` and ends before the last column (spec §2 "Padding and margins").

Bridge (plan 05 creates, plan 06 deletes): before rewriting `agent-row.ts`, plan 05 renames today's file (as plan 04 left it) to `components/legacy-row.ts`, unchanged, for `components/agent-list.ts`, `plugins/agent-list-view/view.ts` and `plugins/agent-view/view.ts` until plan 06 deletes all of them. Landing 05 and 06 in one PR skips the bridge.

## `extensions/subagents/src/components/tree.ts` (owner: plan 05)

```ts
export type TreeRow = { record: AgentRecord; depth: number; last: boolean; ancestorsContinue: boolean[]; openDescendants: number };
export const treeOrder = (records: AgentRecord[], roots?: (r: AgentRecord) => boolean): TreeRow[];  // callers first, children under their caller, siblings by createdAt; a child whose caller is absent renders at depth 0; plan 06's list calls it per section (open roots; each closed root's subtree)
```

## `extensions/subagents/src/components/request-block.ts` (owner: plan 06, new)

```ts
export const requestLines = (payload: unknown | undefined, open: boolean, expanded: boolean, width: number, theme: ThemeLike): string[];  // spec §6 "Request": one dim line at PAD collapsed, or that line plus the pretty-printed request at PAD + 2, wrapped at innerWidth(width) - 2, plus one blank line
export const requestLineCount = (payload: unknown): number;   // JSON.stringify(payload, null, 2).split("\n").length; 0 for undefined or when stringify fails
```

Only the agent view uses it; listed here because it is the one new component of plan 06 and reads `SessionRecord.prompt.providerPayload` from the contract.

## Record fields (owner: plan 04, in `model/types.ts` and the runner)

```ts
activity?: { kind: "tool" | "text"; text: string; at: number };   // last top-level tool name, or first line of the last assistant text
```

The runner sets it on `tool_start` (kind `tool`, `text` = tool name) and on each assistant message (kind `text`). `agent:changed` is emitted on each change (throttled by consumers, not by the runner).

## Settings (`model/settings.ts`)

| key | owner | default |
|---|---|---|
| `doneLingerMs` (new) | plan 05 | 10000 |
| `failedLingerMs` (default change) | plan 05 | 30000 |
| `agentsHintMs` (new) | plan 05 | 30000 |
| `lingerMs` (meaning: list view) | plan 06 | 30000 |
| `renderThrottleMs` (scope: everything) | plan 04 | 250 |
| `notifications` (removed) | plan 03 | — |

## Cross-plan contracts

- Plan 04 registers the `run_agent` tool renderers and the completion-line entry renderer, and exposes the `ToolSpec`s through the `tools` service so plan 06's agent view can pass them to `createTranscript({ tools })`. The service is an object provided by `run-agent`: `tools: { list(): AnyToolSpec[]; add(spec: AnyToolSpec): void }`; `agent-status` calls `add`; plan 06 reads `services.has("tools") ? services.require("tools").list() : []`. The `run_agent` spec also answers `pendingResult` for nested calls still executing.
- Plan 05 provides `agentList`-style access to the panel's selection? No: the panel and the list are independent; both read `registry.list()`.
- `agentView.open`: plan 05 adds `export type AgentViewOrigin = "list" | "panel" | "command"` and `open(id: string, options?: { from: AgentViewOrigin }): Promise<void>` to `model/types.ts` and calls `agentView.open(id, { from: "panel" })` on `Enter`; plan 06 makes `options` required and implements the `from` semantics.
- Plan 03 removes `extensions/subagents/src/plugins/notifications/` and the `notifications` setting; plan 05 removes `progress-widget/` and adds the temporary `components/legacy-row.ts`; plan 06 removes `legacy-row.ts`, `mode-store.ts`, `context-breakdown.ts`, `system-prompt-block.ts`, `collapsible.ts` and the message box.
