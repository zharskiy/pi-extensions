# Plan 01: adapter foundations for the Claude-alike UX

Platform work in `core/adapter` and `core/manager` that the extension plans (02+) build on. Decisions come from `plans/research/decisions.md` (D1–D7); pi facts from `plans/research/pi-api-capabilities.md`, re-checked against the dist sources cited below.

Reviewed 2026-10-14: findings 5, 6, 14, 24, 27, 31, 36 of `research/review-findings.md` applied; §I added. Padding (`research/padding.md`, plan 01 flags 1-2): entry renderers and `renderShell: "self"` blocks are indented by pi's `outputPad` and cut, never wrapped (§C `padLines`, §D `ToolRenderState.outputPad`). Revised 2026-10-14 (fourth pass): agents never ask the user, so the child UI context keeps only its denial defaults and `ChildPrompts` goes (§I.4, lands with plan 04).

Path aliases: `$PCA` = `node_modules/@earendil-works/pi-coding-agent/dist`, `$TUI` = `node_modules/@earendil-works/pi-tui/dist`, `$CORE` = `node_modules/@earendil-works/pi-agent-core/dist`, `types.d.ts` = `$PCA/core/extensions/types.d.ts`, `AS` = `$PCA/core/agent-session.js`, `IM` = `$PCA/modes/interactive/interactive-mode.js`.

Conventions for every capability below:

- Contract additions go into `core/adapter/contract.ts`; doc comments are part of the contract.
- The adapter stays the only pi importer; extensions see plain types only.
- Every `HostUi` addition is a no-op (or returns a no-op unsubscribe) outside a live `tui` context, like today's UI calls.
- Fakes in `core/test/helpers/fakes.ts` get a driver per capability so extension tests never touch pi.
- Run `npm run check` after each capability; the order of work is at the end.

---

## A. Turn phases (D6)

### Contract

```ts
/** What the main session is doing right now, derived from pi's turn events (see pi-phase.ts). */
export type Phase = "waiting" | "thinking" | "writing" | "toolArgs" | "tool" | "idle";

/** `toolName` is the most recently started top-level tool still running; `running` counts them. Both are 0/unset outside `tool`. */
export type PhaseDetail = { toolName?: string; running: number };

// Host additions
/** Fires on every phase or detail change. `idle` fires once per settled run, after the `onIdle` handlers. Nothing fires at session start. */
onPhase(handler: (phase: Phase, detail: PhaseDetail) => void): void;
/** Current phase; `idle` without a live session. */
phase(): { phase: Phase; detail: PhaseDetail };

// HostUi addition
/** Show or hide pi's working row (spinner + message); tui only. `false` clears the row at once; `true` shows it again at once while a run is active (pi's `isStreaming`), with the last `setWorkingMessage` text, and otherwise at the next `turn_start`. */
setWorkingVisible(visible: boolean): void;
```

`onAgentStart` and `onIdle` stay. `onPhase("idle")` and `onIdle` both come from `agent_settled`; the adapter runs `idleHandlers` first, then emits the phase (one place: the `agent_settled` subscription in `pi-adapter.ts`).

### Adapter

New file `core/adapter/pi-phase.ts` with a pure reducer, so the state machine is unit-testable without pi:

```ts
export type PhaseState = { phase: Phase; running: Map<string, string> }; // toolCallId -> toolName
export const initialPhase = (): PhaseState => ({ phase: "idle", running: new Map() });
export const reducePhase = (state: PhaseState, event: PhaseEvent): PhaseState; // returns the same object when nothing changed
export const detailOf = (state: PhaseState): PhaseDetail;
```

`PhaseEvent` is a narrow union the adapter builds from pi events (so the reducer never sees pi types):
`{ type: "agent_start" | "turn_start" | "agent_end" | "agent_settled" | "shutdown" }`, `{ type: "delta"; block: "text" | "thinking" | "toolcall"; edge: "start" | "delta" | "end" }`, `{ type: "message_end" }`, `{ type: "tool_start"; id; name }`, `{ type: "tool_end"; id }`.

State table (`running` = map of top-level tool calls in flight; the phase after each row is listed, `detail` is `{ toolName: last inserted name, running: size }` when size > 0, else `{ running: 0 }`):

| pi event (`pi.on`) | mapped event | guard | next phase | running |
|---|---|---|---|---|
| `agent_start` ($CORE/agent-loop.js:50, :68) | `agent_start` | — | `waiting` | cleared |
| `turn_start` (agent-loop.js:51, :113) | `turn_start` | — | `waiting` | cleared (tools of the previous turn are finished before `turn_end`, agent-loop.js:185-190) |
| `message_update` (agent-loop.js:290-305) | `delta` | only `event.message.role === "assistant"`; `assistantMessageEvent.type` ∈ `text_*`, `thinking_*`, `toolcall_*` | `text_start/delta` → `writing`; `thinking_start/delta` → `thinking`; `toolcall_start/delta` → `toolArgs`; any `*_end` → `waiting` | unchanged |
| `message_end` (agent-loop.js:307-320) | `message_end` | only assistant role | `waiting` | unchanged |
| `tool_execution_start` (types.d.ts:829) | `tool_start` | ignore when `parentToolCallId` is set (codemode nested calls, IM:2915) | `tool` | add `id → toolName` |
| `tool_execution_end` (types.d.ts:848) | `tool_end` | ignore when `parentToolCallId` is set; ignore unknown ids | size > 0 → `tool`, else `waiting` | delete `id` |
| `agent_end` (types.d.ts:724) | `agent_end` | — | `waiting` | cleared |
| `agent_settled` (types.d.ts:777) | `agent_settled` | — | `idle` | cleared |
| `session_shutdown` | `shutdown` | — | `idle`, no emit | cleared |

Edge cases, each a reducer test:

- Parallel tool calls: two `tool_start` then one `tool_end` → still `tool`, `running: 1`, `toolName` = the remaining call's name (map keeps insertion order; `toolName` is the last entry).
- Nested codemode calls: `tool_execution_start/end` with `parentToolCallId` change nothing; the outer `codemode` call keeps the phase at `tool` with `toolName: "codemode"`.
- `agent_start` repeating within one run (retry, overflow compaction, `agent_before_settle` continuation, AS:1395/1402; $CORE/agent-loop.js:68): `waiting` again; no `idle` in between, so the extension's clock keeps running (D6: clock from `agent_start` to `agent_settled`; the extension ignores repeated starts, as today).
- Follow-up queued while streaming: drained inside the same run (agent-loop.js:191-197) → `turn_start` → `waiting`; never `idle`.
- `turn_start` after tools: `tool_end` already brought the phase to `waiting`; `turn_start` clears a (defensively) non-empty map.
- Compaction: `session_compact` does not touch the phase. Auto-compaction and retry back-off between `agent_end` and `agent_settled` sit in `waiting` (pi shows its own compaction/retry indicator there, IM:2975-3044). A `/compact` while idle is invisible to the phase (stays `idle`; `isIdle()` is false meanwhile, AS:1053).
- Emission is deduplicated: handlers run only when `phase`, `toolName` or `running` changed (reducer returns the same object otherwise); the `agent_start` + `turn_start` pair at run start emits `waiting` once.
- `message_update` handlers are awaited per chunk (AS:748-750): the reducer must stay allocation-free on `delta` events when the phase is unchanged (return `state` as is).

Wiring in `pi-adapter.ts` (`createPiHost`): `let phaseState = initialPhase()`; a local `apply(event)` runs the reducer, and when the object changed calls every `phaseHandlers` entry with `(phaseState.phase, detailOf(phaseState))`. Subscribe `pi.on("turn_start" | "message_update" | "message_end" | "tool_execution_start" | "tool_execution_end" | "agent_end")` (each also calls `capture(ctx)`), extend the existing `agent_start`, `agent_settled` and `session_shutdown` subscriptions (`agent_settled`: idle handlers, then `apply`; `session_shutdown`: reset before the handlers run, no emit). `host.phase()` reads `phaseState`.

`setWorkingVisible` goes into `core/adapter/pi-working.ts` next to `setWorkingMessage`: `tuiCtx()?.ui.setWorkingVisible(visible)` (types.d.ts:88; IM:1819-1829 stores the flag; `false` clears the working row at once; `true` calls `showWorkingStatusIndicator()` at once when `session.isStreaming` (`_isAgentRunActive`, AS:1049-1051, true for the whole run) and no working row is active; IM:2762 consults the flag on `turn_start`; IM:1921 resets it to true on session switch). So the extension toggling it per phase gets: hide → immediate, show → immediate within a run (a new row, so the spinner restarts; the same jitter Claude Code has). Corrected by plan 02 after reading IM:1819-1829; document this in the contract doc comment.

### Fakes

`FakeHost`: `phases: { phase: Phase; detail: PhaseDetail }[]` (recorded emissions), `currentPhase`, `onPhase(handler)`, `phase()`, driver `setPhase(phase, detail = { running: 0 })` (emits only on change), `workingVisibility: boolean[]` recording `ui.setWorkingVisible`. `settle()` additionally sets the phase to `idle` after the idle handlers (same order as the adapter); `agentStart()` sets `waiting`.

### Tests

- `core/test/adapter/pi-phase.test.ts` (new, pure): one `it` per table row and per edge case above, e.g. `"maps assistant deltas to writing, thinking and toolArgs and *_end back to waiting"`, `"keeps tool with the last running tool while parallel calls drain"`, `"ignores nested codemode calls"`, `"stays waiting across a repeated agent_start"`, `"returns the same state for a no-op delta"`, `"clears running tools on turn_start after an aborted tool"` (pi aborts the tool, emits `tool_execution_end` with `isError`, then `agent_end`; a `turn_start` that still finds a non-empty `running` map clears it and emits `waiting` with `running: 0`).
- `core/test/adapter/pi-adapter.test.ts`: `"emits phases from pi events and idle after the idle handlers"` (fire `agent_start`, `turn_start`, `message_update` with `role: "user"` (ignored) and assistant `text_delta`, `tool_execution_start` with and without `parentToolCallId`, `agent_settled`; assert the emitted sequence and that `seen` shows `idle` after `onIdle`), `"resets the phase on shutdown without emitting"`.
- `core/test/adapter/pi-working.test.ts`: `"forwards setWorkingVisible in tui only"`.
- `core/test/adapter/conformance.test.ts`: `"fires message_update only with assistantMessageEvent types the phase reducer knows"` (import `AssistantMessageEvent` type from pi-ai and assert the union members used by the reducer exist via a type-level `satisfies`).

### Architecture notes

ARCHITECTURE.md "Startup and the adapter": add "`onPhase` is computed by `pi-phase.ts` from `turn_start`, `message_update`, `message_end`, `tool_execution_*` (top-level only), `agent_end`, `agent_settled`; `idle` fires after `onIdle`." STRUCTURE.md: add `pi-phase.ts  # turn phase reducer (waiting/thinking/writing/toolArgs/tool/idle)`.

---

## B. Editor key hook and key capture (D2)

### Decision

One editor subclass (`HostEditor`, in `pi-editor-frame.ts`) handles the `←`-on-empty and `↓`-on-empty hooks and the capture mode in its `handleInput` override, instead of `onTerminalInput` + a focus check. Reason, in two lines: `handleInput` runs only while the editor is the focused component ($TUI/tui.js:678-752 routes input to `focusedComponent` after the listeners), so overlays and dialogs are excluded for free and no widget-capture trick is needed; and returning before `super.handleInput` keeps a consumed `Esc` away from `CustomEditor`'s `app.interrupt` dispatch ($PCA/modes/interactive/components/custom-editor.js:62-80), which an input listener could only achieve by consuming the key for every component.

### Contract

```ts
/** Keys the editor sees while a capture is installed. `up`/`down` follow pi's `tui.editor.cursorUp/Down` bindings. */
export type EditorKeyHandler = (key: KeyPress) => "consumed" | "release";

// HostUi additions
/**
 * Fires when `tui.editor.cursorLeft` is pressed in the focused editor while it is empty and no autocomplete is open
 * (an empty editor has the cursor at column 0 of its only line, so the key would be a no-op). The key is consumed. tui only. May be
 * called before the session starts; the hook becomes active at session start. Every extension of this package shares one editor;
 * the hook is silently inactive while an editor this package did not install is set. Returns an unsubscribe function.
 */
onEmptyEditorLeft(handler: () => void): () => void;
/**
 * Fires when `tui.editor.cursorDown` is pressed in the focused editor while it is empty, not browsing input history and no
 * autocomplete is open (an empty editor is never on a history entry, so the key would be a no-op). The key is consumed.
 * Same lifetime rules as `onEmptyEditorLeft`. Returns an unsubscribe function.
 */
onEmptyEditorDown(handler: () => void): () => void;
/**
 * Routes every key the focused editor receives to `handler` until it returns "release" or the returned function is
 * called. "consumed" swallows the key (it never reaches pi: no `app.interrupt` on Esc, no shortcuts, no text edit);
 * "release" ends the capture and lets the editor handle that same key normally. Keys never reach the handler while
 * an overlay or dialog has focus. At most one capture at a time: installing a second one releases the first.
 */
captureEditorKeys(handler: EditorKeyHandler): () => void;
```

`KeyPress` is unchanged; inside the editor `name` is computed with the editor's `KeybindingsManager` for `up`/`down` (`tui.editor.cursorUp`/`cursorDown`) and with `Key.*` for the rest (`escape`, `enter`, `space`, `tab`, page keys, `toggleTools` via `app.tools.expand`), `char` for one-character printable input.

### Adapter (`core/adapter/pi-editor-frame.ts`)

1. Shared mutable `EditorHooks = { frame?: EditorFrame; emptyLeft: Set<() => void>; emptyDown: Set<() => void>; capture?: EditorKeyHandler }`, one per `createUi` call.
2. Rename `FramedEditor` → `HostEditor(tui, theme, keybindings, hooks)`; keep its own `keys = keybindings` reference (the `CustomEditor` field is `private`, custom-editor.d.ts:11). `render`/`handleMouse` read `hooks.frame` live; with no frame they call `super` directly (frame optional).
3. `handleInput(data)` order:
   1. `hooks.capture` set → `key = editorKeyPress(data, this.keys)`; `"consumed"` → return; `"release"` → `hooks.capture = undefined`, fall through.
   2. `this.keys.matches(data, "tui.editor.cursorLeft") && this.getText() === "" && !this.isShowingAutocomplete()` ($TUI/components/editor.js:777-780 would otherwise call `moveCursor(0, -1)`, a no-op at column 0 of an empty editor; `←` has no history or autocomplete behaviour) and `hooks.emptyLeft.size > 0` → call each handler, return.
   3. Same for `tui.editor.cursorDown` and `hooks.emptyDown`, and only while pi-tui's TS-private `historyIndex` is -1 (not browsing history; $TUI/components/editor.js:760-771 moves forward in history only while `historyIndex > -1`, otherwise `↓` on an empty editor is a no-op `moveToLineEnd()`). Neither hook fires while a jump target or a bracketed paste is pending.
   4. `super.handleInput(data)`.
4. `createEditorHooks(tuiCtx)` returns `{ setEditorFrame, onEmptyEditorLeft, onEmptyEditorDown, captureEditorKeys, sync, release }`. pi loads every extension with its own module cache (jiti, `moduleCache: false`), so module state is per extension; the editor state (`frame`, `emptyLeft`, `emptyDown`, `capture`, `installed: EditorFactory | undefined`) is one record on `globalThis` under `Symbol.for("pi-extensions.editor-hooks.v2")` (v2 since `emptyDown` was added; a v1 record left by an older copy is ignored) (the `pi-scope.ts` pattern), shared by every adapter copy. Each `createEditorHooks` call also remembers which frame, handlers and capture it registered itself.
   - `ensureInstalled()`: `ctx = tuiCtx()`; no ctx → nothing; `active = ctx.ui.getEditorComponent()` (IM:2084); `active && active !== shared.installed` → nothing (an editor this package did not install; back off silently); `!active` → `shared.installed = (tui, theme, kb) => new HostEditor(tui, theme, kb, shared)`, `ctx.ui.setEditorComponent(shared.installed)` (IM:2083; pi copies text, border colour, autocomplete and the app action handlers onto the new instance, IM:2255-2290).
   - `releaseIfUnused()`: when the shared record has no frame, no empty-left or empty-down handler and no capture and `shared.installed` is the active factory → `ctx.ui.setEditorComponent(undefined)`, `shared.installed = undefined`.
   - `setEditorFrame(frame)`: frame → `shared.frame = frame`, `ensureInstalled()`; undefined → clears the shared frame if this copy set it, `releaseIfUnused()`. The instance reads `shared.frame` on every render, so the composer may call it at any time.
   - `onEmptyEditorLeft(handler)`, `onEmptyEditorDown(handler)` and `captureEditorKeys(handler)`: always store the handler in the shared record (extensions register while they load, before any session exists), then `ensureInstalled()`; the remover deletes it and calls `releaseIfUnused()`.
   - `sync()`: called from the adapter's `session_start` handler right after the ctx is captured; `ensureInstalled()` when the shared record holds a frame or a hook.
   - `release()`: called from the adapter's `session_shutdown` handler after the extension's own shutdown handlers; drops this copy's frame, handlers and capture from the shared record and calls `releaseIfUnused()`, so a `/reload` or session switch (both re-create the extensions) leaves no stale hook behind.
5. `pi-ui.ts`: replace `setEditorFrame: createEditorFrame(tuiCtx)` with `...createEditorHooks(tuiCtx)`; move `keyPress` to an exported `editorKeyPress(data, keys)` variant (same table, `up`/`down` via `keys.matches`).

Semantics the extension plan relies on (D2): the panel installs a capture when it selects a row; `↑`/`↓`/`Enter`/`x`/`Esc` return `"consumed"`; any other key returns `"release"` (clear the selection; the key is then typed). While the capture is active the editor still has focus and keeps rendering its cursor; pi's `onExtensionShortcut`, `app.*` actions and history bindings are all behind `super.handleInput`, so they are suppressed only for consumed keys.

### Fakes

`FakeHost`: `emptyLeftHandlers` and `emptyDownHandlers: Set<() => void>`, `editorCapture?: EditorKeyHandler`, drivers `pressEmptyLeft()` and `pressEmptyDown()` (call handlers, return whether any ran) and `pressEditorKey(key: KeyPress): "consumed" | "release" | "editor"` (routes to the capture, clears it on `"release"`, returns `"editor"` when no capture; a `left` or `down` that is not consumed reaches the matching empty-editor hooks). `foreignEditor: true` makes both registrations no-ops, like `setEditorFrame` today.

### Tests (`core/test/adapter/pi-editor-frame.test.ts`, extend the existing fake ctx with a `keybindings` stub whose `matches(data, id)` maps `"\x1b[D"` → `cursorLeft`, `"\x1b[B"` → `cursorDown`, `"\x1b[A"` → `cursorUp`)

- keep: narrower render, min width, scrolled, mouse shift, foreign editor back-off, outside tui.
- replace "reinstalls … on undefined" with `"installs the editor once and removes it when the frame is cleared and no hook remains"` (`sets` is 1 after frame + hook; 1 after `setEditorFrame(undefined)` while the hook remains; 2 after the hook unsubscribes, factory undefined).
- `"renders the plain editor when only a key hook installed the editor"` (no frame → `render` equals `CustomEditor` output).
- `"fires the empty-left hook only for cursorLeft on an empty editor without autocomplete and consumes the key"` (text "a" with the cursor at the end → `←` moves the cursor as usual, not fired; empty → fired once, `getCursor()` unchanged).
- `"routes keys to the capture, swallows consumed ones and lets a released key reach the editor"` (capture returns consumed for Esc: `onEscape` spy not called; returns release for "a": text becomes "a", capture gone).
- `"keeps up and down bound to pi's editor keybindings"` (a stub manager that maps `tui.editor.cursorDown` to `ctrl+n` only: the capture sees `name: "down"` for `ctrl+n` and `name: "other"` for the raw arrow sequence).
- `"installs at most one capture"`.
- `core/test/adapter/pi-ui.test.ts`: `"editorKeyPress names up and down through the keybindings manager"`.

### Architecture notes

ARCHITECTURE.md "Composer" paragraph and "Startup and the adapter": "`pi-editor-frame.ts` installs one `HostEditor` subclass when the composer frame or a subagents key hook (`onEmptyEditorLeft`, `onEmptyEditorDown`, `captureEditorKeys`) is used; the frame is optional; keys reach the hooks only while the editor has focus." STRUCTURE.md: `pi-editor-frame.ts  # editor subclass: optional EditorFrame, empty-←/↓ hooks, key capture`.

---

## C. Transcript entries and the wake (D1)

### Verdict on the wake

Investigated (AS = `$PCA/core/agent-session.js`):

- `pi.sendMessage` → `sendCustomMessage` (AS:1782). Branches: `deliverAs: "nextTurn"` → `_pendingNextTurnMessages.push` (AS:1792-1794); streaming and `triggerTurn !== false` → `agent.followUp`/`steer` (AS:1795-1800); idle and `triggerTurn` → `_runAgentPrompt(appMessage)` directly (AS:1802-1808, deferred while `agent_settled` is being emitted, AS:1804-1806).
- `before_agent_start` is emitted only inside `prompt()` (AS:1591, `emitBeforeAgentStart`), which then sets `_runSystemPromptOptions = result.systemPromptOptions` (AS:1627) and prepends the section patch for the transcript (AS:1626-1629). `_runAgentPrompt` resets `_runSystemPromptOptions` to undefined when the run ends (AS:1409).
- In a run started by the idle `sendMessage` path nothing sets `_runSystemPromptOptions`. Turn 1 reuses the system message already in the transcript (the replaced prompt from the previous `prompt()` run; the provider gets the current system message, `$CORE/agent-loop.js:222`, `agent.js:33`). From turn 2 on, `prepareNextTurnWithContext` (AS:540-553) builds from `_runSystemPromptOptions ?? _baseSystemPromptOptions` = base (pi's default `customPrompt`, AS:1276-1292), and `_preparePromptAndToolLoadout` (AS:1303-1309) diffs the transcript's sections against the default ones → a reverting system patch is persisted and sent. The next user `prompt()` replaces again → another patch. **So `sendMessage({display:false}, {triggerTurn:true}) while idle does bypass the main-prompt replacement from the second turn of that run on, with a cache-breaking prompt flip-flop in the transcript.** The research caveat is confirmed.
- No other API sets the run options: `_baseSystemPromptOptions.customPrompt` comes from the resource loader (AS:1276-1281), not reachable through `ExtensionAPI`; `BeforeAgentStartEventResult.systemPrompt` (types.d.ts) is the same emission point; `context`/`context_with_system` handlers (types.d.ts, `ContextEventResult`) could rewrite the wire but not the persisted patch, so the transcript and `ctx.getSystemPrompt()` would still flip; `agent_before_settle`/`turn_end` boundaries accept hidden `custom_message` drafts with `continue: true` (types.d.ts `BoundaryResult`) but only exist while a run is active.
- Safe paths that exist: (1) while a run is active, `sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` is drained inside the same `_runAgentPrompt` (agent-loop.js:191-197), so `_runSystemPromptOptions` from the user's `prompt()` stays in force; (2) when idle, `sendMessage(..., { deliverAs: "nextTurn" })` parks the hidden message, and the next `prompt()` (via `sendUserMessage`) runs `before_agent_start` and injects it right after the user message (AS:1611-1614).

Note (pi 1.2.0): the limitation above is pi 1.1.0 behaviour. Since 1.2.0, an idle `sendMessage(..., { triggerTurn: true })` starts its run through `_startRun({ messageType: "custom" })`, which emits `before_agent_start` and sets `_runSystemPromptOptions` for the whole run, so a custom-message run keeps the replaced main prompt. The decision below stands as the wake's design; it is no longer forced by the prompt.

**Decision**: hidden content always travels as a `display: false` custom message; a visible user-role line is sent only when idle, because starting a run from idle is only safe through `prompt()`. The visible line is short and chosen by the extension (UX spec), so the wake stops looking like a pasted batch. The markdown-transformer fallback from D1 is not needed and not implemented (it is global and can only restyle, not shorten reliably). Revised (pi 1.2.0): pi now emits `before_agent_start` for a custom message that starts a run, so the idle wake is fully hidden: the hidden message starts the run itself (`triggerTurn: true`) and the visible line and the `visible` parameter are gone.

### Contract

```ts
/** A message for the model that the user does not see. `details` is persisted with the custom_message entry. */
export type HiddenMessage = { customType: string; text: string; details?: unknown };

// Host addition
/**
 * Delivers `message` to the model without rendering it. While a run is active it is queued as a hidden follow-up of
 * that run. When idle it is parked for the next turn and `visible` (a short user-role line, rendered as a user
 * message) starts that turn, so the main prompt replacement (`setMainPrompt`) applies. `visible` is required: without
 * a live session nothing is sent.
 */
sendHiddenMessage(message: HiddenMessage, visible: string): void;
/** Register a renderer for custom entries (`appendEntry`). `undefined` hides the entry. The adapter indents every line by pi's `outputPad` and cuts it at `width - 2 * outputPad` with `…` (never wraps). */
registerEntryRenderer<T>(customType: string, render: (data: T, state: { expanded: boolean }, theme: ThemeLike) => string[] | undefined): void;
```

`sendUserMessage` stays for session-limits.

### Adapter (`pi-adapter.ts`)

`sendHiddenMessage(message)` (as revised for pi 1.2.0):
1. `ctx = state.ctx`; none → return.
2. `custom = { customType, content: message.text, display: false, details: message.details }`.
3. `!ctx.isIdle()` → `pi.sendMessage(custom, { deliverAs: "followUp", triggerTurn: true })` (AS:1795-1797). Done.
4. idle → `pi.sendMessage(custom, { triggerTurn: true })`, which starts a run with `before_agent_start`; held messages (pi busy without a run) go out once idle, all but the first as `nextTurn` and the first with `triggerTurn`, so they share one run. Originally: `pi.sendMessage(custom, { deliverAs: "nextTurn" })` (AS:1792-1794) then `pi.sendUserMessage(visible)` (AS:1848 → `prompt()` AS:1517; `before_agent_start` AS:1591; next-turn injection AS:1611-1614). Both calls from an `agent_settled` handler are deferred by pi in order (AS:1518-1521 for the prompt; the `nextTurn` push is synchronous), so the outbox flushing on `onIdle` keeps working.

`registerEntryRenderer(customType, render)`: `pi.registerEntryRenderer(customType, (entry, { expanded }, theme) => { const lines = render(entry.data, { expanded }, themeLike(theme)); return lines ? padLines(lines, pi.getSettings().outputPad ?? 1) : undefined; })` (types.d.ts `registerEntryRenderer`, `EntryRenderer`; rendered live by IM:2776-2781 → `addCustomEntryToChat` IM:3126-3144, inserted above a streaming assistant message, and on resume; `CustomEntryComponent` adds the spacer and catches renderer errors, `$PCA/modes/interactive/components/custom-entry.js:36-57`). Register at boot (before `session_start`), since pi builds one extension instance per session.

Padding (spec §2 "Padding and margins"; `plans/research/padding.md` A): pi gives an entry component no padding (`CustomEntryComponent` adds `Spacer(1)` and the renderer's component unpadded, `custom-entry.js:52-55`) and `EntryRenderOptions` carries no `outputPad` (`types.d.ts:1142-1144`), so the adapter reads the setting through `pi.getSettings().outputPad` (`types.d.ts:1262`) at render time. `padLines(lines, outputPad)` (new, `pi-ui.ts`, shared with §D) is a component whose `render(width)` returns `lines.map((line) => " ".repeat(outputPad) + truncateToWidth(line, Math.max(1, width - 2 * outputPad), "…"))` (pi-tui's ANSI-aware cut): the text starts at column `outputPad`, the last `outputPad` columns stay blank, nothing wraps. A `Text(…, 0, 0)` would start at column 0 and wrap long lines back to column 0. pi's spacer puts one blank line before every entry, so consecutive entries are one blank line apart.

`main-prompt.ts` is unchanged.

### Fakes

`FakeHost`: `hidden: { message: HiddenMessage; delivery: "followUp" | "run" }[]` (delivery from `host.idle`), `entryRenderers: Map<string, render>`, helper `renderEntry(customType, data, expanded = false)` for tests. `sendHiddenMessage` ignores calls when stale, like `sendUserMessage`.

### Tests

- `core/test/adapter/pi-adapter.test.ts` (fake pi gains `sendMessage` and `registerEntryRenderer` recorders): `"sends a hidden follow-up while busy"` (one `sendMessage` call with `{ deliverAs: "followUp", triggerTurn: true }`, no `sendUserMessage`), `"starts a run with the hidden message when idle and sends no user message"` (one `sendMessage` with `{ triggerTurn: true }`), `"starts one run for several held messages, the first one triggering it"`, `"sends nothing without a live session"`, `"renders entry lines indented by outputPad and cut at width - 2 * outputPad, and hides on undefined"` (fake `getSettings()` returns `outputPad: 1`: a 100-character line at width 40 renders as one line, starting with one space, `visibleWidth` 39, ending with `…`; with `outputPad: 0`, no leading space and width 40; `undefined` from the renderer → no component).
- `core/test/adapter/conformance.test.ts`: `"keeps the sendMessage delivery options the wake relies on"` (type-level: `Parameters<ExtensionAPI["sendMessage"]>[1]` accepts `{ deliverAs: "nextTurn" }`, `{ triggerTurn: true }` and `{ deliverAs: "followUp"; triggerTurn: true }`).
- Live proof, `core/test/adapter/wake.live.test.ts` (new; `vitest.live.config.ts` `include` gains `"core/test/adapter/**/*.live.test.ts"`; CI never runs it): build a main-like session the way `pi-child.ts` does (`DefaultResourceLoader` with `extensionFactories: [{ name: "wake", factory }]`, `createAgentSession`, `bindExtensions({ mode: "print", uiContext })`, outside `childScope` so `createPiExtension` boots), where `factory = createPiExtension(boot, { root, namespace: "wake-test" })` and `boot` calls `host.setMainPrompt("WAKE-TEST-PROMPT <uuid>")`, registers a trivial `noop` tool and keeps `host`; a second inline factory records every `before_provider_request` payload. Steps: `session.prompt("Call noop twice, then reply ok")`; wait for `agent_settled`; `host.sendHiddenMessage({ customType: "wake-test", text: "Call noop once more, then reply done" })`; wait for settle. Assert: every recorded payload's system prompt is identical and contains the marker; the session file has exactly one `role: "system"` message entry with `sections` after the first user message and none after the wake; the wake entry is `custom_message` with `display: false`; the session has exactly one user message and at least two assistant messages after the wake. Report cost with `reportCost`. Name: `"keeps the replaced main prompt across a hidden wake-triggered run"`.

### Architecture notes

ARCHITECTURE.md "Startup and the adapter": replace the `sendUserMessage` bullet with: "`sendUserMessage` delivers immediately when idle, otherwise as a follow-up. `sendHiddenMessage` sends a `display: false` custom message: a follow-up of the active run, or, when idle, a message that starts the run itself (`triggerTurn`; pi 1.2.0 emits `before_agent_start` for it). `registerEntryRenderer` renders `appendEntry` entries, each line indented by pi's `outputPad` and cut at `width - 2 * outputPad`." Add to "Subagents › A run_agent call": step 9 says the outbox uses `sendHiddenMessage` (extension plan).

---

## D. Richer tool rendering and the transcript pane (D1, D4)

### Contract

```ts
/** Render-time facts pi passes to tool renderers (ToolRenderContext in pi). */
export type ToolRenderState = {
  toolCallId: string;
  expanded: boolean;
  /** True while the call streams or the result is partial. */
  isPartial: boolean;
  executionStarted: boolean;
  isError: boolean;
  /** The call's arguments as pi parsed them (pi's `ToolRenderContext.args`, shared by the call and result renders of one call); the tool's params type, `unknown` here because the state is not generic. */
  args: unknown;
  /** Set only on the final result. */
  durationMs?: number;
  /** pi's horizontal transcript padding (`ToolRenderContext.outputPad`, 0 or 1, default 1). A `renderShell: "self"` block is not padded by pi; the adapter applies it (below), the renderer may read it. */
  outputPad: number;
  /** Re-render this call later (safe after the tool returned, until the transcript is rebuilt). */
  invalidate(): void;
};

export type ToolSpec<P, D> = {
  …existing fields…
  /** "self" drops pi's coloured box so the renderer owns the whole row. Default "default". */
  renderShell?: "default" | "self";
  execute(params: P, ctx: { signal?: AbortSignal; toolCallId?: string; update(text: string, details?: D): void }): Promise<ToolResult<D>>;
  pendingResult?(toolCallId: string, owner: string | undefined): ToolResult<D> | undefined;
  renderCall?(params: P, theme: ThemeLike, state: ToolRenderState): string;
  renderResult?(result: ToolResult<D>, state: ToolRenderState, theme: ThemeLike): string;
};

// OverlayApi change
createTranscript(options?: { tools?: AnyToolSpec[]; owner?: string }): TranscriptPane;
```

Backwards compatibility: existing `renderCall(params, theme)` ignores the third argument; existing `renderResult(result, { expanded, invalidate }, theme)` keeps working because `ToolRenderState` is a superset; `update(text)` keeps working (`details` optional). `AnyToolSpec` unchanged.

### Adapter

`core/adapter/pi-tools.ts` (`toPiTool`):
- `renderShell: spec.renderShell`.
- `renderState(context: ToolRenderContext): ToolRenderState` picks `toolCallId, expanded, isPartial, executionStarted, isError, args, durationMs, outputPad, invalidate` from pi's context (`outputPad` at types.d.ts:377-378, "Renderers with `renderShell: \"self\"` apply it themselves") (`$PCA/modes/interactive/components/tool-execution.js:74-93`; types.d.ts:347-379 `ToolRenderContext`, `args` at :349, `isError` at :371). `isError` is forwarded as is, so renderers can test `state.isError`.
- `fromPiResult` also copies `isError` (`...(result.isError ? { isError: true } : {})`, mirroring `toPiResult`), so the `ToolResult` a `renderResult` receives carries it and agrees with `state.isError`.
- `renderCall: (args, theme, context) => textComponent(context.lastComponent, spec.renderCall(args, themeLike(theme), renderState(context)))`; when `spec.renderShell === "self"`, both renderers return `padLines(text.split("\n"), context.outputPad)` instead (§C; an empty text stays zero lines): pi pads only its `Box` shell (`tool-execution.js:208-211`), so without this a self block would draw at column 0 and reach the last column. Lines are cut at `width - 2 * outputPad`, never wrapped, so tree rows keep their connectors.
- `renderResult: (result, options, theme, context) => textComponent(context.lastComponent, spec.renderResult(fromPiResult(result), renderState(context), themeLike(theme)))` (`options.expanded/isPartial` equal the context's, tool-execution.js:242).
- `execute`'s `update: (text, details) => onUpdate?.({ content: [{ type: "text", text }], details })` so partial renders see live details (IM:2936-2941 → `updateResult(partial, true)`).

`core/adapter/pi-ui.ts`:
- `capturePiRenderers(factories: Record<string, () => ExtensionFactory>): Record<string, ToolRenderers>` runs each exported factory (`createCodemodeExtension()`, `createToolSearchExtension()`, `$PCA/extensions/codemode/index.js:17-30`, `$PCA/extensions/tool-search/index.js:9-13`) against a stub `{ registerTool: (definition) => { captured = definition; } } as unknown as ExtensionAPI`; the factories only call `registerTool` with a definition whose pi callbacks are closures (`getSettings`, `getAllTools`, `appendEntry`) used at execute time, never at construction. Keep `{ renderShell, renderCall, renderResult }` (`ToolRenderers`, exported from `$PCA/index.d.ts:8`; `ToolExecutionComponent` accepts `ToolRenderers | ToolDefinition`, tool-execution.d.ts). Failure mode: a factory that throws or registers nothing yields no entry → that tool keeps pi's generic fallback (`formatToolExecution`, tool-execution.js:311-322), exactly today's display. Memoise at module level, computed on first use.
- `createTranscriptPane(tui, cwd, options: { tools?: AnyToolSpec[]; piRenderers?: Record<string, ToolRenderers> } = {})`: `definitionFor(name)` order: built-in factory → `options.tools` spec by name (`toPiTool(spec)`, renderers only) → `piRenderers[name]` (default `capturePiRenderers({ codemode: createCodemodeExtension, tool_search: createToolSearchExtension })`) → `undefined`. Nested `run_agent`/`message_agent`/`agent_status` calls inside an agent therefore render with the same `renderCall`/`renderResult` as the main session (D4), receiving a real `ToolRenderState` from pi's component. A call with no result in the file is marked started; on each render the pane asks the spec's `pendingResult(toolCallId, arguments)` and, the first time it answers, feeds it to the component as `updateResult(partial, true)`, so a call still executing draws its partial block (pi writes no partial results to session files). The persisted result replaces it on a later `sync`.
- `openOverlay`: `createTranscript: (options) => createTranscriptPane(tui, cwd, { tools: options?.tools })`.
- Codemode result entries in a child session file carry `details.calls` (`$PCA/extensions/codemode/execute.js:363-470`), which `updateResult(item.raw)` already passes through, so the nested call list renders.

### Fakes

`FakeHost.tool(name)` returns the spec unchanged; add `renderTool(name, { call?, result?, state? })` helper that invokes `renderCall`/`renderResult` with a default `ToolRenderState` (`{ toolCallId: "call-1", expanded: false, isPartial: false, executionStarted: true, isError: result?.isError ?? false, args: call, outputPad: 1, invalidate }`, i.e. `args` carries the `call` params and `isError` comes from the given result; `state` overrides any field) and `plainTheme`, so extension tests render tool rows without pi. Fake overlay APIs built by extension tests (`agent-view.test.ts:50`) get `createTranscript(options)`; the fake runtime is unchanged.

### Tests

- `core/test/adapter/pi-tools.test.ts` (new): `"passes the render state to renderCall and renderResult"` (pi-style context object → spec receives `toolCallId`, `durationMs`, `isError`, `invalidate` identity), `"passes the call arguments as state.args to renderCall and renderResult"` (context `args: { wait: true }` → both renderers see it), `"copies isError into the result renderResult receives"` (pi result with `isError: true` → `result.isError` and `state.isError` both true), `"forwards update details"`, `"keeps string-only renderers working"` (spec with the old signatures), `"sets renderShell"`, `"passes outputPad and pads self-shell lines by it"` (context `outputPad: 1`, `renderShell: "self"`: `state.outputPad === 1`; the component's lines at width 40 start with one space, are at most 39 columns wide, and a long line is cut with `…`, not wrapped; `outputPad: 0` → column 0, at most 40; a default-shell spec still gets the plain `Text`).
- `core/test/adapter/pi-ui.test.ts`: `"captures codemode and tool_search renderers from pi's factories"` (`capturePiRenderers` with the real exports → both have `renderCall`; `tool_search` has none, so entry absent or renderers undefined → fallback), `"falls back to the generic display when a factory throws"` (stub factory `() => { throw }`), `"renders a codemode call with pi's renderer in the transcript pane"` (sync an assistant item with a `codemode` call and a tool item with `details.calls: [{ id, name: "grep", args: "{}", status: "ok", durationMs: 12 }]`; snapshot the visible text with the existing APC/SGR strippers: contains `codemode`, the highlighted `tools.grep` line and `✓ grep`), `"renders custom specs passed to createTranscript with their own renderers"` (`tools: [spec]` whose `renderCall` returns `"RUN-AGENT-ROW"`), `"keeps the raw fallback for unknown tools"`.
- `core/test/adapter/conformance.test.ts`: `"exports the codemode and tool_search factories as ExtensionFactory producers"` and `"ToolRenderContext carries the fields the contract forwards"` (type-level).

### Architecture notes

ARCHITECTURE.md "Startup and the adapter": "`ToolSpec` renderers receive `ToolRenderState` (pi's render context) and may set `renderShell: "self"` (the adapter then indents each line by pi's `outputPad` and cuts it, since pi pads only its own box); `update(text, details)` forwards details to partial renders." "Status, views": "The agent view transcript renders built-in tools with pi's definitions, `codemode`/`tool_search` with renderers captured from pi's exported extension factories (generic fallback if capture fails), and the subagents tools with the specs passed to `createTranscript({ tools })`."

---

## E. Overlay and widget options

- Overlay list → view → back: **no change.** `openOverlay(factory)` shows one `ctx.ui.custom` overlay (`pi-ui.ts:353-401`); the returned `ViewComponent` can hold an internal "current view" and delegate `render`/`handleKey`/`handleWheel`/`dispose` to it, and `OverlayApi.createTranscript/createScroll/createInput` can be called any number of times for sub-views (the agent view already recreates its transcript, `agent-view/view.ts:194`). `Esc` mapping stays the view's job (pi has no built-in escape handling in `custom`, IM:2324-2391). Nested `custom()` is not needed.
- Widget: keep `belowEditor` only; **no `tickMs`.** The panel plugin keeps its own unref'd `setTimeout` chain (100 ms while a spinner is on screen, 1000 ms otherwise; plan 05 §2.3), cleared on disable, and calls `WidgetHandle.refresh()`; while the main agent works pi re-renders every 80 ms anyway (`$TUI/components/loader.js:2-3`). Simplest, nothing to add to the contract.
- Footer `N agents` pill: `HostUi.setStatus(key, host.ui.style("accent", "2 agents"))` is enough: pi stores it per key (IM:1772-1775), the footer extension renders statuses sorted by key in the status line (`extensions/footer/src/render.ts:152-160`), and pi's default footer shows it too. No contract change.

Tests: none new (document the "no change" in the extension plans).

---

## F. Dialog events, key listener, idle (D5)

### Contract

```ts
export type DialogKind = "select" | "confirm" | "input" | "editor" | "custom";
export type DialogEvent = { phase: "start" | "end"; kind: DialogKind; title?: string };

// Host addition
/** pi's ui_prompt_start/ui_prompt_end: one outer dialog at a time, nested dialogs are folded into it. Overlays opened with openOverlay report kind "custom". */
onDialog(handler: (event: DialogEvent) => void): void;

// HostUi addition
/** Calls `listener` on every keyboard input chunk (mouse reports and key-release events excluded) without consuming it. tui only. Returns an unsubscribe function. */
onKeyPress(listener: () => void): () => void;
```

### Adapter

- `pi-adapter.ts`: `pi.on("ui_prompt_start" | "ui_prompt_end", (event, ctx) => { capture(ctx); dialogHandlers.forEach(h => h({ phase, kind: event.kind, title: event.title })) })` (types.d.ts `UIPromptStartEvent`/`UIPromptEndEvent`; emitted by `$PCA/core/extensions/runner.js:359-399` around `select/confirm/input/editor/custom`, depth-counted so only the outermost dialog emits, delivered on a microtask). Child sessions never reach the main runner's dialogs: their UI context resolves `confirm`/`select`/`input` to the denial defaults (§I.4), so every `onDialog` event is a main-session dialog. `openOverlay` uses `ctx.ui.custom` → `kind: "custom"`; the notifications extension must skip that kind (extension plan).
- `pi-ui.ts` `onKeyPress(listener)`: `tuiCtx()?.ui.onTerminalInput((data) => { if (!isKeyRelease(data) && !data.startsWith("\x1b[<") && !data.startsWith("\x1b[M")) listener(); return undefined; }) ?? (() => {})` (`onTerminalInput` types.d.ts:82, listeners run for every input regardless of focus, $TUI/tui.js:683-697; `isKeyRelease` exported from pi-tui `index.d.ts:23`; SGR mouse reports start with `\x1b[<`, legacy X10 mouse reports with `\x1b[M`). Never returns `{ consume }`.
- `onIdle` fires once per settled run: `_emitAgentSettled` runs once in `_runAgentPrompt`'s `finally` (AS:1409-1412, :684-704); prompts issued from settled handlers are deferred and get their own later settle (AS:1518-1521, :1804-1806). Confirmed, no change; `Host.isIdle()` stays `ctx.isIdle()`.

### Fakes

`FakeHost`: `onDialog(handler)`, driver `dialog(phase, kind, title?)`; `keyListeners: Set<() => void>`, driver `pressKey()`; `onKeyPress` returns a remover.

### Tests

- `pi-adapter.test.ts`: `"forwards dialog start and end with kind and title"`.
- `pi-ui.test.ts`: `"onKeyPress calls the listener for keys, skips SGR and X10 mouse reports and key releases, and never consumes"` (fake ctx `onTerminalInput` recorder as in `pi-editor-input.test.ts`), `"onKeyPress is a no-op outside tui"`.
- `conformance.test.ts`: `"names the dialog kinds the contract forwards"` (type-level: `DialogKind` equals pi's `UIPromptKind`, via `const kinds: UIPromptKind[] = [...] satisfies DialogKind[]`), and `"emits ui_prompt events around every blocking dialog"` by binding a child session the way `pi-child.test.ts` does, calling `ctx.ui.confirm` from an inline extension and asserting one `ui_prompt_start`/`ui_prompt_end` pair with `kind: "confirm"` and the title (the runner wraps the UI context at `runner.js:359-367` and emits on a microtask, `:396-399`).

### Architecture notes

ARCHITECTURE.md "Startup and the adapter": "`onDialog` is pi's `ui_prompt_start/end` (outermost dialog only; overlays are `custom`). `HostUi.onKeyPress` observes terminal input without consuming it."

---

## G. Busy channel rename (D5)

`core/manager/channels.ts:3`: `export const BUSY_CHANNEL = "pi:busy";` — payload `{ source, busy }` and `parseBusySignal` unchanged.

References to the old name (grep `session-limits:busy` and `BUSY_CHANNEL` over `core/`, `extensions/`, `*.md`):

| file | change |
|---|---|
| `core/manager/channels.ts:3` | the constant |
| `core/test/manager/channels.test.ts` | uses the parser only; add `expect(BUSY_CHANNEL).toBe("pi:busy")` |
| `extensions/session-limits/src/limits.ts:4,327` | imports the constant; no change |
| `extensions/session-limits/test/limits.test.ts:5,87,436,455-456` | imports the constant; no change |
| `extensions/session-limits/README.md:42-43` | literal `session-limits:busy` → `pi:busy` |
| `extensions/subagents/src/plugins/agent-registry/index.ts:1,19` | imports the constant; no change |
| `extensions/subagents/test/plugins/agent-registry/agent-registry.test.ts:4,36` | constant; no change |
| `extensions/subagents/README.md:44` | literal → `pi:busy` and "the busy channel (`pi:busy`, consumed by session-limits and notifications)" |
| `README.md:56` | literal → `pi:busy` |
| `ARCHITECTURE.md:8,103` | literal → `pi:busy` |
| `plans/research/*.md` | historical, leave |

Third-party publishers using the literal name break; note it in the session-limits README under a "Changed" line.

Tests: `channels.test.ts` as above. Size S.

---

## H. Theme

Needs from D1–D4: panel rows use `accent`, `muted`, `dim`, `success`, `warning`, `error` plus `bold`; the agent view header the same; codemode and tool_search render with pi's own renderers against pi's `Theme`, outside `ThemeLike`; `renderShell: "self"` rows draw no background. All of this is already in `ThemeToken` (`accent | muted | dim | success | warning | error | text`) and `ThemeLike` (`fg`, `bold`).

**Decision: no change to `ThemeLike`.** `bg` and `italic` are not added; `plainTheme` in the fakes stays. If a later plan needs a background it adds `bg(token: "selected", text)` then, with pi's `selectedBg`.

---

## I. Additions requested by later plans

Contract and `core/manager` changes that later plans need. Each lands with its owning plan, not with §A–§H.

1. **`terminalNotify(message, channel)`** (owner: plan 03). `HostUi.terminalNotify(message: string, channel: "auto" | "bell")` replaces `terminalNotify(title, body)`, and the pure builder becomes `notificationSequence(message, channel, env)`. `auto` writes OSC 9 `<message>` (OSC 777 `notify;pi;<message>` on rxvt) **without** a leading BEL; `bell` writes BEL only. Decision: no BEL on `auto`, because the idle notification fires after ordinary replies too and a bell on every reply is noise; users who want the bell choose `bell`.

2. **`ChoiceRule`** (owner: plan 03). `core/manager/settings.ts` `parseSettings` gains `ChoiceRule { type: "choice"; values: string[] }`; a value outside `values` fails with `<file>: <key> must be one of "auto", "bell", "off"` (the listed values quoted, comma-separated).

3. **Shared formatters in `core/manager/format.ts`** (owner: plan 04 step 0; review finding 18). Pi-free module exporting `formatTokens(n)` and `formatDuration(ms)`, tested in `core/test/manager/format.test.ts`. Users: subagents re-exports both from `extensions/subagents/src/components/format.ts`; footer imports `formatTokens` and drops its own copy; working-indicator imports `formatDuration`. Extensions may import `core/manager` (ARCHITECTURE.md "Layers and dependency rules"), so this removes the duplicates without breaking "extensions never import each other". If plan 02 lands first it creates the file with `formatDuration` (and its test), and plan 04 adds `formatTokens`.

4. **Child UI: children bind no UI context** (owner: plan 04, same change as its "Agents never ask" deletions, because `run-agent/runner.ts` passes `prompts` today and the build must stay green). Agents never ask the user (spec §2 "Agents never ask"; `research/subagent-input.md`). The child binds no `uiContext`, exactly as pi's print mode does (`node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js:53`, `await session.bindExtensions({ mode: ..., commandContextActions: ... })` with no `uiContext`); `bindExtensions` (`dist/core/agent-session.js:2598-2601`) sets `_extensionUIContext` only `if (bindings.uiContext !== undefined)`, so the runner keeps pi's `noOpUIContext` (`dist/core/extensions/runner.js:132-157`: `select` and `input` resolve `undefined`, `confirm` resolves `false`, `notify` does nothing) and `ctx.hasUI` is `false` (`runner.js:404-406`, `626-628`). Extensions take their documented headless branch and give honest block reasons, and no `ui_prompt_*` event fires in a child. The call is `session.bindExtensions({ mode: "print" })` (the option is `mode`, not a UI option; the package is `@earendil-works/pi-coding-agent`).
   - `core/adapter/contract.ts`: delete `export type ChildPrompts` (`confirm`, `select`, `input`, `notify`) and the `prompts?: ChildPrompts` field of `SpawnSpec`.
   - `core/adapter/pi-child.ts`: delete `silentUi` and `childUiContext` (and the `Theme` / `ExtensionUIContext` imports they alone use, and `ChildPrompts` from the contract import); the spawn call becomes `session.bindExtensions({ mode: "print" })` (today `{ mode: "print", uiContext: childUiContext(ctx.ui.theme, spec.prompts) }`). The child loses the parent's `ctx.ui.theme` and gets pi's global theme from `noOpUIContext`; no child consumer of the theme exists.
   - `core/test/adapter/pi-child.test.ts`: drop the `ChildPrompts` import; delete the three `childUiContext` tests (`"forwards the four dialogs to the prompts and returns their results"`, `"denies everything without prompts"`, `"uses the given theme and keeps the rest harmless"`); add one spawn test, `"binds the child's extensions without a UI context"`: the fake session returned by `scriptedSession` (near `pi-child.test.ts:301`, whose `bindExtensions` takes no arguments today) records its argument; after `spawn`, `bindExtensions` was called once with `{ mode: "print" }` and the argument has no `uiContext` key. The denial values themselves are pi's and are not re-tested here.
   - ARCHITECTURE.md "A run_agent call, end to end", step 4: replace "UI is silent except `confirm/select/input/notify`, which are forwarded to the main UI through one serial queue and mark the record with `attention`." with "binds no UI, like pi's print mode: dialogs resolve to their denials (`confirm` false, `select` and `input` undefined), `notify` does nothing, `ctx.hasUI` is false; only the main session is interactive, and an agent that needs a decision reports it in its result."

---

## Order of work

```
G (S) ─┐
H (–) ─┤ independent, any time
A (M) ─┼─► working-indicator plan
F (S) ─┼─► notifications plan (needs G + F; A optional)
B (M) ─┼─► agent panel plan (needs B + D + E)
D (M) ─┼─► run_agent rendering + agent view plans (needs D; C for the wake)
C (M, + live test L) ──► run_agent wake plan
E (–) confirmations only
```

Dependencies inside this plan: B touches `pi-ui.ts` (`keyPress` → `editorKeyPress`) and D touches `pi-ui.ts` (`createTranscriptPane`, `openOverlay`) — do B before D or rebase carefully; A, C, F all add `pi.on` subscriptions and fake-pi recorders in `pi-adapter.test.ts` — do them in the order A, F, C so the fake pi grows once. Suggested sequence: G → A → F → B → D → C (unit) → C (live, needs `PI_LIVE_MODEL` and credentials, run locally before merging C). §I items are not in this sequence: each lands with its owning plan (I.1 and I.2 with plan 03, I.3 with plan 04, or with plan 02 if it lands first; I.4 with plan 04 step 3).

Sizes: A M (reducer + wiring + fakes + tests), B M (subclass rework + tests), C M unit + L for the live harness, D M, E none, F S, G S, H none. Each step ends with `npm run check`; C's live step ends with `npm run test:live`.

---

## Risks

- **Wake prompt drift (C)**: a future pi change could route `nextTurn` messages differently. pi 1.2.0 now emits `before_agent_start` for custom messages that start a run (`messageType: "custom"`), which keeps the replaced prompt for such runs too. Mitigation: the live test asserts byte-identical system prompts and the absence of a reverting patch; `conformance.test.ts` checks that the installed pi is inside the caret range `package.json` declares, and the `sendMessage` option types.
- **`message_update` cost (A)**: the handler is awaited per token chunk. Mitigation: the reducer returns the same object for no-op deltas and the adapter emits only on change; the reducer test asserts identity.
- **Working row jitter (A)**: every re-show creates a new row (spinner restarts, the editor shifts one line when the row hides). Mitigation: the extension toggles only on `writing` boundaries (plan 02), which is the same jitter Claude Code accepts; `setWorkingVisible(true)` must never run while pi's compaction or retry indicator is active (it would replace it): plan 02 shows only on phase changes, which do not happen between `agent_end` and `agent_settled`.
- **Editor subclass conflicts (B)**: an editor this package did not install disables frame and hooks (the composer and subagents share one `HostEditor` through the `globalThis` record). Mitigation: unchanged back-off semantics, hooks return no-op removers, and the composer/panel plans degrade gracefully (panel without keyboard selection).
- **Esc capture swallowing interrupts (B)**: a buggy extension capture could keep `Esc` from aborting a run. Mitigation: the capture only exists while a row is selected (extension plan), `"release"` on any other key, and the remover is called on disable; test "lets a released key reach the editor".
- **Codemode renderer capture breaks on a pi upgrade (D)**: the stub assumes the factory only calls `registerTool`. Mitigation: try/catch with fallback to the generic display, a conformance test that runs the real factories against the stub, and the conformance check that the installed pi is inside the declared version range.
- **Dialog events include overlays (F)**: `openOverlay` emits `kind: "custom"`, which would make the notifications extension nag about `/agents`. Mitigation: `kind` is forwarded and the contract doc says so; the notifications plan filters it.
- **Channel rename breaks external publishers (G)**: third-party extensions publishing `session-limits:busy`. Mitigation: README "Changed" note; the payload and parser are untouched, so a one-line rename on their side suffices.
