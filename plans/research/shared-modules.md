# Shared modules and ownership between the feature plans

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
```

The duplicate `formatTokens` in `extensions/footer/src/render.ts` stays where it is (footer is a separate extension and may not import subagents); plan 04 notes it as a known duplicate. The one in `components/agent-row.ts` goes.

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
export const nameColumn = (records: AgentRecord[]): number;   // widest visible name (+ chain suffix + (+N)), capped at 24
```

## `extensions/subagents/src/components/tree.ts` (owner: plan 05)

```ts
export type TreeRow = { record: AgentRecord; depth: number; last: boolean; ancestorsContinue: boolean[]; openDescendants: number };
export const treeOrder = (records: AgentRecord[], roots?: (r: AgentRecord) => boolean): TreeRow[];  // callers first, children under their caller, siblings by createdAt; a child whose caller is absent renders at depth 0
```

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

- Plan 04 registers the `run_agent` tool renderers and the completion-line entry renderer, and exposes the `ToolSpec`s through the `tools` service (`run-agent` plugin) so plan 06's agent view can pass them to `createTranscript({ tools })`.
- Plan 05 provides `agentList`-style access to the panel's selection? No: the panel and the list are independent; both read `registry.list()`.
- Plan 06 keeps the `agentView.open(id, { from: "list" | "panel" | "command" })` service; plan 05 calls `agentView.open(id, { from: "panel" })` on `Enter`.
- Plan 03 removes `extensions/subagents/src/plugins/notifications/` and the `notifications` setting; plan 05 removes `progress-widget/`; plan 06 removes `mode-store.ts`, `context-breakdown.ts`, `system-prompt-block.ts`, `collapsible.ts` and the message box.
