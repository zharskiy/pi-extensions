# Plan 02: working-indicator shows work, not output

Implements decision D6 and spec `plans/00-ux-spec.md` §7 (Surface E). Builds on plan 01 §A (`Phase`, `PhaseDetail`, `Host.onPhase`, `Host.phase()`, `HostUi.setWorkingVisible`, fake `setPhase`/`workingVisibility`), taken as given. Path aliases as in plan 01: `IM` = `$PCA/modes/interactive/interactive-mode.js`, `AS` = `$PCA/core/agent-session.js`, `TUI` = `node_modules/@earendil-works/pi-tui/dist/tui.js`.

Reviewed 2026-10-14: findings 16, 18 applied.

## 1. Goal and behaviour

- The working row (spinner + message above the composer) is visible while the main session waits for the model, streams thinking, streams tool-call arguments or runs tools.
- It hides while assistant text streams (the text is the progress) and comes back the moment the text block ends.
- Idle: no row (pi clears it at `agent_end`), message back to pi's default.
- Message: `<Verb>… (<elapsed> · <key> to interrupt)`; during a tool phase `<Verb>… (<tool> · <elapsed> · <key> to interrupt)`, e.g. `Pondering… (bash · 1m 5s · esc to interrupt)`.
- `<elapsed>` uses the shared duration format (`12s`, `1m 5s`, `1h 2m`), no longer `75s`.
- The clock runs from the first `agent_start` of a run to `agent_settled`, across turns, follow-ups and repeated internal `agent_start`s.
- Verb picked at run start, rotated every `VERB_MS` (8000) as today. Spinner set once per session as today.
- `run_agent` with `wait: true` is a main-session tool: the row shows `run_agent` for the whole batch.
- Child sessions never change the phase, the message, the clock or the visibility.
- TUI only; in other modes the extension does nothing.

## 2. Design

### The mid-turn re-show question (answer first)

Plan 01 §A states that `setWorkingVisible(true)` only takes effect at the next `turn_start`. The pi source says otherwise: **a mid-run re-show is immediate.**

- `IM:1819-1829` `setWorkingVisible(visible)`: stores `workingVisible` (1820). `false` → `clearStatusIndicator("working")` and render (1821-1824). `true` → `if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") this.showWorkingStatusIndicator()` (1826-1827), then render.
- `AS:1049-1051`: `isStreaming` is `_isAgentRunActive`, set at the start of `_runAgentPrompt` (`AS:1388`) and cleared in `_emitAgentSettled` (`AS:686`) before extensions receive `agent_settled` (`AS:690`). It is true for the whole run: every turn, every tool execution, retries and post-run continuations.
- `IM:1813-1818` `showWorkingStatusIndicator` builds a new `WorkingStatusIndicator` from `this.workingMessage ?? "Working"` and the stored spinner options, so the re-shown row carries the message last written by `setWorkingMessage`.
- `IM:2758-2771` `turn_start`: shows the row when `workingVisible` and none is active, otherwise `clearStatusIndicator()`. This is the only other show path.
- `IM:2061-2066` `setWorkingMessage` and `IM:1831-1837` `setWorkingIndicator` never show the row: they store the value and update an active working indicator in place.
- `AS:748-750`: extensions get each agent event before IM's listener, so on any event our handler runs first.

Consequence: hide on entering `writing`, show on leaving it, through `setWorkingVisible` only. Leaving `writing` happens at `text_end`, `toolcall_start`, `message_end` or `agent_end`; the row returns at once, in the same turn, before the tool executes. Plan 01's doc comment on `setWorkingVisible` is wrong on this point; this plan fixes the comment (step 1 of §6) and changes nothing else in the contract.

Two hazards, both handled:

- `setWorkingVisible(true)` replaces any non-working indicator (`showStatusIndicator` disposes the active one, `IM:1783-1794`), e.g. compaction or retry. We call `true` only when leaving `writing`, which happens at the latest at `agent_end`. Compaction and retry indicators appear after `agent_end` (`IM:2970-3060`), and in that window the phase is `waiting` and nothing is emitted. So the show never overlaps them.
- On an abort while text streams, our `agent_end` show (phase `writing` → `waiting`) runs just before IM's `agent_end` clears the row (`IM:2957`). Renders are throttled through a `setTimeout` (`TUI:624-676`), so a show followed by a clear in one event dispatch never paints.

Trade-off: each toggle creates a new indicator, so the spinner restarts at frame 0, and the editor shifts by the row's height when the row hides (unless pi's `clearOnShrink` placeholder holds the space, `IM:1806-1810`). Claude Code has the same jitter (research Topic A, A1). Embedding the row in the composer would remove it, but that is out of scope (D7).

### State (closure in `createWorkingIndicator`)

```ts
type Run = { startedAt: number; interruptKey: string; verb: string; nextVerbAt: number; timer: ReturnType<typeof setInterval> };
let run: Run | undefined;          // undefined = no run (idle, or not tui)
let phase: Phase = "idle";         // last phase seen while a run is active
let toolName: string | undefined;  // detail.toolName, set only in "tool"
let hidden = false;                // last value we passed to setWorkingVisible was false
```

### Handlers

| Source | Action |
|---|---|
| `onSessionStart` | `setWorkingIndicator(spinner)` (unchanged) |
| `onAgentStart` | return outside `tui`. Return if `run` is set: a repeated `agent_start` keeps the clock, verb and key (today's `start()` restarts them, which contradicts spec §7). Otherwise start the run: `startedAt = Date.now()`, `interruptKey = keyText("app.interrupt")` (read once), random verb, `nextVerbAt = VERB_MS`. Seed `phase`/`toolName` from `host.phase()`, reading `idle` as `waiting` because the adapter may emit `waiting` before or after the start handlers. Write the message, start an unref'd `setInterval(tick, TICK_MS)`. |
| `onPhase(next, detail)` | `next === "idle"` → `end()`. No `run` → ignore (phases before a run, or outside tui). Otherwise set `phase = next`, `toolName = next === "tool" ? detail.toolName : undefined`, write the message, then `applyVisibility()`. |
| `tick` | rotate the verb when `elapsed >= nextVerbAt` (`nextVerbAt = elapsed + VERB_MS`), write the message. |
| `onSessionShutdown` | `stop()`: clear the interval, `run = undefined`, `setWorkingMessage(undefined)`. Visibility is left alone: pi resets `workingVisible = true` itself before a session is invalidated (`IM:366-368` → `resetExtensionUI`, `IM:1921`) and on `/reload` (`IM:5366`). A `setWorkingVisible(true)` while the old run is still streaming could put a stale row back. |

- `applyVisibility()`: `const visible = phase !== "writing"`. If `visible === !hidden`, return. Otherwise `setWorkingVisible(visible)` and `hidden = !visible`. Only real transitions call pi, so a run without text never calls `setWorkingVisible`.
- Order on a phase change: write the message first, then show. `showWorkingStatusIndicator` reads `workingMessage` (`IM:1817`), so the returning row already shows the tool name and the current time.
- `end()` (on `idle`): when `hidden`, `setWorkingVisible(true)` and `hidden = false`. The run is no longer streaming at settle (`AS:686`), so this only restores pi's default flag; without it the next run's `turn_start` would clear the row (`IM:2767-2768`). In practice the adapter has already emitted `waiting` at `agent_end`, so `hidden` is false; the restore is defensive. Then `stop()`, `phase = "idle"`, `toolName = undefined`.
- The extension no longer subscribes to `onIdle`: `onPhase("idle")` comes from the same `agent_settled` after the idle handlers (plan 01), so there is one source of truth.

### Tick while hidden: keep it running

The interval runs from run start to `end()`/shutdown, including while hidden. Reasons:

1. `setWorkingMessage` on a hidden row only assigns a field (`IM:2062-2065`), with no render.
2. One timer lifecycle per run, with no pause and resume bookkeeping, and verb rotation stays on the run clock.
3. The stored message is always current, so the row is right whichever path re-shows it (our show or pi's `turn_start`).

The cost is at most one field write per second during text streaming.

### Message grammar

```ts
export const workingMessage = (verb: string, elapsedMs: number, interruptKey: string, toolName?: string) =>
  `${verb}… (${toolName ? `${toolName} · ` : ""}${formatDuration(elapsedMs)} · ${interruptKey} to interrupt)`;
```

The tool name appears only in `tool`, and it is `detail.toolName`: the most recently started top-level tool still running (plan 01 reducer). `toolArgs` has no name (spec §7: "same").

`formatDuration` is the shared format from spec §2, imported from `core/manager/format.ts` (plan 01 §I item 3), the one copy subagents re-exports and footer uses too. Extensions may import `core/manager` (ARCHITECTURE.md line 9); `test/architecture.test.ts` forbids only extension-to-extension imports, adapter imports other than `contract.ts` (and `pi-adapter.ts` from `src/index.ts`) and cross-plugin imports, so no duplicate is needed. Output: `0s`…`59s`, `1m 0s`…`59m 59s`, `1h 0m`…; seconds floored, negatives clamped to `0s` (the algorithm of today's `formatElapsed` in `subagents/src/components/agent-row.ts:37-51`). If plan 02 lands before plan 04, plan 02 creates `core/manager/format.ts` with `formatDuration` only, and plan 04 adds `formatTokens`.

### Clock across repeated `agent_start`s

A run is `run !== undefined`. `agent_start` repeats inside one run (retry, overflow compaction, `agent_before_settle` continuation, AS:1395/1402) without an `idle` in between, so the guard in `onAgentStart` keeps the clock. A wake-triggered run starts after the previous run settled: the adapter emits `idle` inside `agent_settled`, and pi defers a prompt issued there until the settled handlers ran. So the wake's `agent_start` sees `run === undefined` and starts a fresh clock and verb, in phase `waiting`.

### Children cannot affect it

Statement for README and ARCHITECTURE: the indicator reads only the main session's `Host` events (`onSessionStart`, `onAgentStart`, `onPhase`, `onSessionShutdown`).

- Child sessions are separate pi `AgentSession`s. Their events reach only the runtime listener in `core/adapter/pi-child.ts` (registry updates), never the main session's `pi.on` subscriptions from which `onPhase` is computed.
- Our extensions do not boot inside a child (`createPiExtension` returns early in the child scope).
- The child UI context's `setWorkingMessage`/`setWorkingVisible`/`setWorkingIndicator` are no-ops (`pi-child.ts:101-103`).
- `boot` gets the runtime but `index.ts` passes only `host` to `createWorkingIndicator`, and the extension subscribes to no bus or channel.

The test (`ignores child sessions, channels and other host events`) proves it at the extension boundary. It drives every kind of child or agent activity the fakes can produce (fake child `tool_start`, `turn`, `finish` with `settled`, a `BUSY_CHANNEL` publish, `turnEnd`, `compact`) while the fake host's phase stays `tool`. It asserts that no message, no visibility call and no phase change happened, then that the next tick still shows the main tool.

## 3. File-by-file changes

### `core/adapter/contract.ts` (doc comment only)

Replace plan 01's `setWorkingVisible` comment with:
`/** Show or hide pi's working row; tui only. Hiding is immediate. Showing is immediate while a run is active, otherwise pi applies it at the next turn_start. The flag persists until set again; pi resets it to true on session switch and reload. */`

### `core/manager/format.ts` (only if plan 04 has not landed)

```ts
export const formatDuration = (ms: number): string; // 3s, 1m 2s, 1h 2m (spec §2)
```

The body is today's `formatElapsed` (`Math.max(0, Math.floor(ms / 1000))`, then the under-a-minute and under-an-hour branches). Pi-free; plan 04 later adds `formatTokens` to the same file. If plan 04 landed first, the file exists and this step is skipped.

### `core/test/manager/format.test.ts` (only if plan 02 creates `format.ts`)

`formats durations like the shared formatter`: `3000 → "3s"`, `75000 → "1m 15s"`, `3600000 → "1h 0m"`, `3725000 → "1h 2m"`.

### `extensions/working-indicator/src/working-indicator.ts`

- Keep `SPINNER`, `SPINNERS`, `spinner`, `VERBS`, `VERB_MS`, `TICK_MS`, `INTERRUPT_BINDING`, `pickVerb`.
- `workingMessage(verb, elapsedMs, interruptKey, toolName?)` as in §2, importing `formatDuration` from `core/manager/format.ts` (relative path `../../../core/manager/format.ts`).
- `createWorkingIndicator(host: Host): void`, with the state and handlers of §2. Internal functions: `message()` (builds the message from `run`, `phase` and `toolName`), `write()` (`setWorkingMessage(message())`), `tick()`, `applyVisibility()`, `begin()` (replaces `start`), `stop()`, `end()`. Import `Phase` from the contract. Remove the `onIdle` subscription. Follow the repository style (no loops, blank lines around `if` blocks, no comments).

### `extensions/working-indicator/src/index.ts`

No change. Wiring stays `createWorkingIndicator(host)`: the runtime is deliberately not passed (see "Children cannot affect it").

### `extensions/working-indicator/README.md`

Replace "What it does" with:

- At session start the working indicator becomes the configured spinner, drawn in the theme's accent colour; pi keeps it for the whole session.
- While a prompt runs (from agent start until the run settles, across all its model calls and tool runs), the working line shows a verb, the time since the prompt started (`12s`, `1m 5s`) and the interrupt hint (from pi's `app.interrupt` keybinding). While a tool runs, the tool's name comes first: `Percolating… (bash · 1m 5s · esc to interrupt)`. The time advances every second; the verb changes every 8 seconds.
- The line shows while pi waits for the model, while the model thinks or writes a tool call, and while tools run. It hides while the assistant's answer text streams in, and comes back as soon as the text stops.
- When the run settles the line disappears and the message goes back to pi's default.
- Only the main session drives it; subagents never show, hide or change it.
- Active only in `tui` mode; in other modes it does nothing.

Update the example to `⠹ Percolating… (bash · 12s · esc to interrupt)`. In "Layout", add that the duration format comes from `core/manager/format.ts`, shared with subagents and footer.

### `extensions/working-indicator/test/working-indicator.test.ts`

Helper: `message(verb, elapsed: string, tool?: string)` = `` `${verb}… (${tool ? `${tool} · ` : ""}${elapsed} · <app.interrupt> to interrupt)` ``. `setup(mode)` unchanged. Fake timers and `pickIndex(0)` as today.

Keep (assertions updated to the string elapsed form):
1. `applies the spinner at session start`.
2. `shows the first message on agent start without re-setting the spinner`: `[message(V0, "0s")]`.
3. `advances the elapsed seconds every tick`: `"3s"`.
4. `picks a new verb every VERB_MS`: `"7s"` V0, `"8s"` V1, `"16s"` V2.
5. `keeps counting across turns of one run`.
6. `clears the message and stops ticking when the run settles`: `[message(V0,"0s"), undefined]` after `settle()` and 3 ticks.
7. `clears the message on shutdown`.
8. `leaves the message alone when no run is active`: also `workingVisibility` is `[]`.
9. `restarts the clock on the next run`.

Change:

10. `formats the verb, the elapsed time, the tool and the interrupt key`: `workingMessage("Musing", 12_345, "esc")` → `"Musing… (12s · esc to interrupt)"`; `workingMessage("Musing", 65_000, "esc", "bash")` → `"Musing… (bash · 1m 5s · esc to interrupt)"`.
11. `nothing outside tui` (was `does nothing outside tui mode`): `setup("print")`, `agentStart()`, `setPhase("writing")`, `setPhase("tool", { toolName: "bash", running: 1 })`, 3 ticks → `workingMessages` and `workingVisibility` both `[]`.

Add:

12. `formats elapsed times with the shared duration format`: `workingMessage("Musing", 45_000, "esc")` → `"Musing… (45s · esc to interrupt)"`, `workingMessage("Musing", 3_723_000, "esc")` → `"Musing… (1h 2m · esc to interrupt)"`. The formatter's own cases live in `core/test/manager/format.test.ts`.
13. `switches to minutes after one minute`: 65 ticks → `message(V0, "1m 5s")`; never contains `"65s"`.
14. `hides while the assistant writes text and shows again when a tool starts`: `agentStart`, `setPhase("writing")` → `workingVisibility` `[false]`; `setPhase("tool", { toolName: "bash", running: 1 })` → `[false, true]`, last message `message(V0, "0s", "bash")`.
15. `writes the fresh message before showing the row again`: spy on `host.ui.setWorkingMessage` and `host.ui.setWorkingVisible`; after `writing` then `tool`, the last message call's `invocationCallOrder` is lower than the `setWorkingVisible(true)` call's.
16. `shows again when the text ends without a tool`: `writing` → `waiting` → `[false, true]`, message without a tool name.
17. `keeps the row for thinking, tool arguments and tools`: `waiting`, `thinking`, `toolArgs`, `tool`, `waiting` → `workingVisibility` `[]`.
18. `names the running tool`: `setPhase("tool", { toolName: "bash", running: 1 })`, one tick → `message(V0, "1s", "bash")`; `setPhase("tool", { toolName: "grep", running: 2 })` → `"grep"`; `setPhase("waiting")` → no tool name, written at once (no tick needed).
19. `shows run_agent for a waiting batch`: `setPhase("tool", { toolName: "run_agent", running: 1 })`, 65 ticks → `message(V0, "1m 5s", "run_agent")`.
20. `keeps ticking while hidden`: `writing`, 3 ticks → last message `message(V0, "3s")`, `workingVisibility` still `[false]`.
21. `keeps the clock across a repeated agent_start`: spy `host.ui.keyText`; `agentStart`, 5 ticks, `pickIndex(3)`, `agentStart` → last message `message(V0, "5s")`, no `"0s"` after the first message, `keyText` called once.
22. `ignores phases before a run starts`: `setPhase("writing")`, `setPhase("tool", …)` with no `agentStart` → `workingMessages` and `workingVisibility` `[]`.
23. `restores the row flag and clears the message on settle`: `agentStart`, `writing`, `settle()` → `workingVisibility` `[false, true]`, last message `undefined`, no message after 3 ticks.
24. `leaves visibility to pi on shutdown`: `agentStart`, `writing`, `await shutdown()` → `workingVisibility` `[false]`, last message `undefined`, no further messages after 3 ticks.
25. `ignores child sessions, channels and other host events`: `createFakeRuntime()`, `const child = await runtime.spawn(spec)` (a minimal `SpawnSpec` literal), `agentStart`, `setPhase("tool", { toolName: "run_agent", running: 1 })`. Record the lengths of `workingMessages`, `workingVisibility` and `phases`. Then `child.emit({ type: "tool_start", toolName: "bash" })`, `child.turn({ tokens: 10 })`, `child.finish("done")`, `host.emit(BUSY_CHANNEL, { source: "subagents", busy: false })` (from `core/manager/channels.ts`; plan 01 §G renames the value, not the constant), `host.turnEnd({ tokens: 10, window: 100 })`, `host.compact()`. Assert the three lengths are unchanged and `host.phase()` is still `tool`/`run_agent`; one tick → `message(V0, "1s", "run_agent")`.

### `ARCHITECTURE.md`

Replace the "Working-indicator" section with §4. `STRUCTURE.md`: the working-indicator `src/` line is unchanged; if plan 02 creates `core/manager/format.ts`, add it to the `core/manager` list (`format.ts  # shared duration (and later token) formatters`).

## 4. ARCHITECTURE.md "Working-indicator" (final text)

```markdown
## Working-indicator

- Active only in `tui` mode. On session start it sets `HostUi.setWorkingIndicator` to the `SPINNER` frames once; pi keeps them for the whole session, so they are not re-set per run (that would restart the animation). The adapter (`pi-working.ts`) paints them with the theme's accent colour, and the working calls are no-ops outside `tui`.
- The clock counts the current prompt (one agent run), not a turn. The first `Host.onAgentStart` of a run (skipped outside `tui`, so no interval runs in other modes) records the start, reads pi's `app.interrupt` key once through `HostUi.keyText`, and picks a random verb. Repeated `agent_start`s inside the run (retry, compaction, continuation) are ignored. An unref'd interval rewrites `HostUi.setWorkingMessage` every `TICK_MS`, even while the row is hidden, as `<verb>… (<tool> · <elapsed> · <key> to interrupt)`, picking a new verb every `VERB_MS`. `<tool> · ` appears only in phase `tool` (the most recent top-level tool still running), and `<elapsed>` uses `formatDuration` from `core/manager/format.ts`, the duration format shared with subagents (`12s`, `1m 5s`).
- Visibility follows `Host.onPhase`: entering `writing` calls `HostUi.setWorkingVisible(false)`, and leaving it writes the message and then calls `setWorkingVisible(true)`. pi re-shows the row at once while a run is active (`isStreaming`), so the row returns as soon as assistant text stops, in the same turn. Only transitions call pi, so a run without text never toggles it. `onPhase("idle")` (after the `onIdle` handlers of `agent_settled`) stops the interval, restores pi's visibility flag if it was hidden, and restores pi's default message. Shutdown stops the interval and clears the message; pi resets the flag itself on session switch and reload.
- Only the main session drives it: phases come from the main session's pi events, child sessions run in their own `AgentSession` with no-op working UI, and the extension subscribes to no bus or channel. Nothing is persisted.
```

## 5. Edge cases

| Case | Phases (from plan 01 reducer) | What the user sees / what we do |
|---|---|---|
| Text, tool call, text in one assistant message | `writing` → `waiting` (text_end) → `toolArgs` → `waiting` → `writing` | Row hides, returns at `text_end` (immediate, IM:1826), stays for the tool-call stream, hides at the second text. Three `setWorkingVisible` calls; each show creates a new indicator (spinner restarts, one-row layout shift). |
| Text, then the tool runs in the same turn | `writing` → `waiting` (message_end) → `tool` | Row returns at `message_end`, before the tool starts, already showing the current time; at `tool_execution_start` the message gains the tool name. No wait for the next `turn_start`. |
| `toolArgs` for a large `write` | `toolArgs` for seconds | Row stays visible with no tool name (spec §7: the name appears only in `tool`); pi streams the call's arguments above it. |
| Run with no text (thinking + tools only) | never `writing` | `setWorkingVisible` is never called; identical to today apart from the tool name and the duration format. |
| Esc while text streams | `writing` → `waiting` (message_end or agent_end) → `idle` (`agent_settled {aborted}`) | Our show runs in the extension pass of the event, IM's `agent_end` clears the row (IM:2957) in the same dispatch, and renders are timer-throttled (TUI:659-676), so nothing flashes. `end()` clears the message. |
| Settle while still `hidden` (defensive) | `writing` → `idle` | `end()` calls `setWorkingVisible(true)`. The run is not streaming (AS:686), so it only stores the flag and the next run's `turn_start` shows the row (IM:2762-2765). |
| Session shutdown mid-run (`/new`, `/resume`, quit) | adapter resets to `idle` without emitting | `stop()`: interval cleared, message cleared, visibility untouched (pi resets it, IM:366-368, 1921). The new session's instance starts empty. |
| Compaction or retry between `agent_end` and `agent_settled` | `waiting`, no emission | We call nothing, so pi's compaction/retry indicator stays (a `setWorkingVisible(true)` there would replace it, IM:1783-1794). A continuation's `turn_start` brings the working row back with the clock still running. |
| Repeated `agent_start` in one run | `waiting` (deduplicated) | Clock, verb and key kept (guard on `run`). |
| `run_agent` with `wait: true` | `tool` / `run_agent` for the whole batch | `Verb… (run_agent · 1m 5s · esc to interrupt)`. Child activity inside the batch changes nothing. |
| `run_agent` with `wait: false`, later wake | `tool` → … → `idle`; the wake starts a new run | Row gone after settle while agents run (the panel shows them). The wake's run gets a fresh clock and verb in `waiting`. |
| Parallel tools | `tool`, `running: 2` → `1` | Name = most recent still running; changes are written at once, not at the next tick. |
| Nested codemode calls | outer `tool` / `codemode` | Shows `codemode`; nested calls are ignored by the reducer. |
| Non-tui modes | phases still emitted | No run ever starts, so `onPhase` returns early; no UI calls (they would be no-ops anyway). |

## 6. Order of work

Precondition: plan 01 §A has landed (`Phase`, `onPhase`, `phase()`, `setWorkingVisible`, fake `setPhase`/`phases`/`workingVisibility`, `agentStart()` → `waiting`, `settle()` → `idle` after idle handlers).

1. `core/adapter/contract.ts`: correct the `setWorkingVisible` doc comment (§3).
2. `core/manager/format.ts` with `formatDuration` and `core/test/manager/format.test.ts`, only if plan 04 has not created them yet; otherwise nothing.
3. `src/working-indicator.ts`: `workingMessage` with tool and duration, then the state, handlers and visibility of §2; drop `onIdle`.
4. Tests 1-25 in `test/working-indicator.test.ts`.
5. `README.md`, `ARCHITECTURE.md` (§4), `STRUCTURE.md`.
6. `npm run check` (typecheck, biome, unit tests). Optional manual check in tui: a prompt that writes a sentence and then runs `bash` (the row hides during the sentence and returns with `bash` before the command output), and Esc during text (no stray row).
