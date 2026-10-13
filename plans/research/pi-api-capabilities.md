# pi 1.1.0: extension API capabilities for the Claude-Code-style UX

Date: 13 October 2026. Verified against the repo-local install (`node_modules/@earendil-works/*`, all 1.1.0).
It builds on `research/pi-extension-api.md` and `research/pi-sdk-sessions-cost.md`; where those notes and the dist
sources differ, this file follows the dist sources.

Path aliases:

- `$PCA` = `node_modules/@earendil-works/pi-coding-agent/dist`
- `$TUI` = `node_modules/@earendil-works/pi-tui/dist`
- `$CORE` = `node_modules/@earendil-works/pi-agent-core/dist`
- `types.d.ts` = `$PCA/core/extensions/types.d.ts`
- `IM` = `$PCA/modes/interactive/interactive-mode.js`

---

## Need 1: turn phases for a working indicator

### Facts

Extension events (`types.d.ts:1163-1203`, payloads `:720-860`). Handlers are awaited **before** pi's own TUI
listener sees the event (`$PCA/core/agent-session.js:748-750`: "Emit to extensions first, then notify public listeners").

```ts
interface AgentStartEvent { type: "agent_start" }                                    // :720
interface AgentEndEvent { type: "agent_end"; messages: AgentMessage[] }              // :724
interface AgentSettledEvent { type: "agent_settled"; aborted: boolean }              // :777
interface TurnStartEvent { type: "turn_start"; turnIndex: number; timestamp: number } // :798
interface TurnEndEvent extends BoundaryState { type: "turn_end"; turnIndex; message; toolResults; ... } // :804
interface MessageStartEvent { type: "message_start"; message: AgentMessage }         // :813
interface MessageUpdateEvent { type: "message_update"; message: AgentMessage;
                               assistantMessageEvent: AssistantMessageEvent }        // :818
interface MessageEndEvent { type: "message_end"; message: AgentMessage }
interface ToolExecutionStartEvent { type: "tool_execution_start"; toolCallId; toolName; args; parentToolCallId? } // :829
interface ToolExecutionUpdateEvent { ...; partialResult: any; parentToolCallId? }
interface ToolExecutionEndEvent { ...; result; isError; durationMs?; parentToolCallId? } // :848
// also: before_provider_request {payload} (:680), after_provider_response {status, headers} (:694),
// provider_stream_event, ui_prompt_start/ui_prompt_end {kind,title} (:784), tool_call (pre-exec, can block, :907)
```

`AssistantMessageEvent` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:581-634`): `start`,
`text_start|text_delta|text_end`, `thinking_start|thinking_delta|thinking_end`,
`toolcall_start|toolcall_delta|toolcall_end`, `done`, `error`. Every variant carries `partial: AssistantMessage`
(`done` carries `message`). Only the `*_start/_delta/_end` variants reach extensions as `message_update`;
`start` becomes `message_start`, `done/error` become `message_end` (`$CORE/agent-loop.js:281-332`).

Not available to extensions: `queue_update`, `compaction_start/end`, `auto_retry_start/end`. These are
`AgentSessionEvent`s only (seen by `session.subscribe`, not `pi.on`).

### When each event fires (`$CORE/agent-loop.js`)

- `agent_start` + `turn_start` at the start of a run (`:50-51`), then `message_start/end` for the user message.
- Request sent: `before_provider_request` (`$PCA/core/sdk.js:227`). Response headers: `after_provider_response`.
  Providers push `start` **after the HTTP response headers arrive**, before any content
  (`pi-ai/dist/api/anthropic-messages.js:443-444`, same in `openai-responses.js:138-139`). So assistant
  `message_start` does not mean "visible output"; time-to-first-token is between `message_start` and the first
  `*_start` delta.
- Each later turn: `turn_start` (`:113`), only after `prepareNextTurn` (compaction may run first).
- Tools: `tool_execution_start/update/end` per call; calls from one message may run in parallel.
  Codemode's nested calls carry `parentToolCallId`.
- `turn_end` after the tool results; `agent_end` when the loop exits.

### Phase mapping (recommended)

| Phase | Enter on | Leave on |
|---|---|---|
| (a) waiting for model | `turn_start`; also `tool_execution_end` when no tool is still running | first `message_update` with a `*_start`/`*_delta` |
| (b) streaming text | `message_update` `text_start`/`text_delta` | `text_end`, another block type, `message_end` |
| (c) streaming thinking | `thinking_start`/`thinking_delta` | `thinking_end` / `message_end` |
| (c') streaming a tool call (args) | `toolcall_start`/`toolcall_delta` (e.g. a large `write`) | `toolcall_end` |
| (d) tool executing | `tool_execution_start` with no `parentToolCallId` (keep a counter of running ids) | counter back to 0 on `tool_execution_end` |
| (e) idle | `agent_settled` | `agent_start` |

Gaps: retry back-off and auto-compaction between `agent_end` and `agent_settled` are invisible to extensions
(pi shows its own `RetryStatusIndicator`/`CompactionStatusIndicator` there). `session_before_compact` /
`session_compact` are visible. Keep `message_update` handlers cheap: they are awaited per token chunk.

### How pi's own TUI does it (`IM`)

- One "working" `StatusIndicator` (a pi-tui `Loader`) for the whole run; **no per-phase change**:
  ```js
  case "turn_start":                               // IM:2758
      if (this.workingVisible) { if (this.activeStatusIndicator?.kind !== "working") this.showWorkingStatusIndicator(); }
      else { this.clearStatusIndicator(); }
  case "agent_end":                                // IM:2953
      this.clearStatusIndicator("working"); ...
  case "agent_settled": await this.checkShutdownRequested();   // IM:2966
  ```
- `message_start` (assistant) creates an `AssistantMessageComponent` and `message_update` calls
  `updateContent(partial, true)` and creates `ToolExecutionComponent`s for streamed tool calls (`IM:2825-2870`).
  `tool_execution_start` with `parentToolCallId` is skipped (`IM:2915`: "Nested calls ... are shown inside their parent's row").
- Default message `"Working"`, hidden-thinking label `"Thinking..."` (`IM:271-272`). `setWorkingMessage(msg)`
  stores the message and updates a live indicator (`IM:2061-2066`), so setting it in a `turn_start` or
  `message_update` handler takes effect immediately and survives into the next indicator.
- **The default editor embeds the indicator in its top border**: `new CustomEditor(..., { embedWorkingStatus: true })`
  (`IM:400-404`); `isWorkingStatusEditor()` (`IM:93`) checks `editor.embedWorkingStatus === true`. Our
  `FramedEditor` calls `super(tui, theme, keybindings)` without options, so with our editor the indicator falls back to
  a separate row in `statusContainer` (`IM:1783-1794`).
- Indicator API (`types.d.ts:59-64, 84-97`): `setWorkingMessage(message?)`, `setWorkingVisible(boolean)`,
  `setWorkingIndicator({frames?, intervalMs?})` (`frames: []` hides it, frames are rendered verbatim),
  `setHiddenThinkingLabel(label?)`.
- Other terminal signals pi emits itself: OSC 9;4 progress on `turn_start`/`agent_end` when `showTerminalProgress`
  is on, and OSC 7501 program status `working/blocked/done/error/idle` (`$PCA/modes/interactive/program-status-reporter.js`).

### Follow-ups / steer and `agent_start`

- `pi.sendUserMessage(text, {deliverAs:"followUp"})` while streaming is queued (`agent-session.js:1848-1875` →
  `prompt(..., {streamingBehavior})`). The low-level loop drains follow-ups inside the **same** run: it emits
  `turn_start` again, not `agent_start` (`$CORE/agent-loop.js:191-197`).
- A message queued after the loop's last check (e.g. from an `agent_end` handler) restarts it with
  `agent.continue()` → `runAgentLoopContinue` → **a new `agent_start`** (`agent-session.js:1384-1395`, `:1446-1448`;
  `$CORE/agent-loop.js:68`). Retries, overflow compaction and `agent_before_settle {continue:true}` do the same.
  So `agent_start`/`agent_end` can repeat within one settled run; `agent_settled` fires once at the end.
- When idle, `sendUserMessage` starts a new run → `agent_start`.

### Already wrapped by our adapter

- Partly. `pi-adapter.ts` subscribes to `agent_start`, `turn_end`, `agent_settled`, `session_compact`.
  `pi-working.ts` wraps `setWorkingIndicator` and `setWorkingMessage`. No `turn_start`, `message_update`,
  `tool_execution_*`, `before_provider_request`, or `setWorkingVisible`/`setHiddenThinkingLabel`.

### Adapter additions needed

- `host.onPhase(handler: (phase: "waiting"|"thinking"|"writing"|"toolArgs"|"tool"|"idle", detail?: {toolName?: string; running: number}) => void)`
  computed inside the adapter from the events above (filter `message.role === "assistant"`, ignore `parentToolCallId`).
- Pass `{ embedWorkingStatus: true }` to `CustomEditor` in `FramedEditor` if the indicator should stay in the
  editor border (and check `FramedEditor.render` keeps the border line), or expose `setWorkingVisible`.

---

## Need 2: keyboard interception (e.g. ↓ on an empty editor opens a task overlay)

### Facts

Input path (`$TUI/tui.js:678-752`): every key goes first through **all input listeners** (`addInputListener`, i.e.
`ctx.ui.onTerminalInput`), in registration order, each may `{consume:true}` or rewrite `{data}`; then to the
**focused component's** `handleInput`. Listeners run even when an overlay or dialog has focus.

```ts
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined; // types.d.ts:54
onTerminalInput(handler: TerminalInputHandler): () => void;                                            // types.d.ts:80
setEditorComponent(factory: EditorFactory | undefined): void;                                          // :175
getEditorComponent(): EditorFactory | undefined;     // returns the *factory*, not the instance
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent; // :67
registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }): void; // :1209
```

`CustomEditor.handleInput` (`$PCA/modes/interactive/components/custom-editor.js:62-113`) order:
extension shortcuts (`onExtensionShortcut`, first, unconditional) → paste image → `app.interrupt` → `app.exit`
(only when empty) → history bindings → other `app.*` actions → `Editor.handleInput`.

Arrow handling in `Editor` (`$TUI/components/editor.js:746-772`):

```js
if (kb.matches(data, "tui.editor.cursorUp")) {
    if (this.isOnFirstVisualLine() && (this.isEditorEmpty() || this.historyIndex > -1 || this.state.cursorCol === 0))
        this.navigateHistory(-1);                       // ↑ = history
    else if (this.isOnFirstVisualLine()) this.moveToLineStart(); else this.moveCursor(-1, 0);
}
if (kb.matches(data, "tui.editor.cursorDown")) {
    if (this.historyIndex > -1 && this.isOnLastVisualLine()) this.navigateHistory(1);   // ↓ only while browsing history
    else if (this.isOnLastVisualLine()) this.moveToLineEnd();                            // ↓ on last line = no-op-ish
    else this.moveCursor(1, 0);
}
```

So **↓ on an empty editor is free** (`moveToLineEnd` on an empty line does nothing). `addToHistory` skips empty
text (`editor.js:308-311`), so an empty editor is never inside a history entry. ↑ on an empty editor is taken
(history). While autocomplete is open, `tui.select.up/down` go to the list (`editor.js:607`).

Arrow bindings already in use (`$PCA/core/keybindings.d.ts`, `$TUI/keybindings.d.ts`): `up`/`down` =
`tui.editor.cursorUp/Down` and `tui.select.up/down`; `ctrl+up`/`ctrl+down` = `tui.altScreen.previousPrompt/nextPrompt`;
`alt+up` = `app.message.dequeue`; `alt+left/right`, `ctrl+left/right` = word moves; `pageUp/pageDown` = editor and
alt-screen scrolling. Free in the editor: `shift+up/down`, `alt+down`, `ctrl+shift+…`-free combos.

Public editor state: `ctx.ui.getEditorText()` (empty check). On the instance (`$TUI/components/editor.d.ts`):
`getText()`, `getLines()`, `getCursor(): {line, col}`, `isShowingAutocomplete()`. `isEditorEmpty`,
`isOnLastVisualLine`, `historyIndex` are private.

Ways to intercept, best first:

1. **Override `handleInput` in our `FramedEditor`** (`core/adapter/pi-editor-frame.ts`, already a `CustomEditor`
   subclass installed via `setEditorComponent`). Fires only while the editor has focus:
   ```ts
   handleInput(data: string) {
     if (this.keys.matches(data, "tui.editor.cursorDown") && this.getText() === "" && !this.isShowingAutocomplete()) {
       this.frame.onEmptyDown?.(); return;
     }
     super.handleInput(data);
   }
   ```
   (`keybindings` is `private` in `CustomEditor`, so keep our own reference from the constructor.) Respects user
   rebinding of `tui.editor.cursorDown`. Caveat: only one custom editor can be active; `createEditorFrame` already
   backs off when another extension installed one.
2. `ctx.ui.onTerminalInput` + `matchesKey(data, Key.down)` + `ctx.ui.getEditorText() === ""`. Must also check that the
   editor is focused (`tui.getFocusedComponent()`, reachable through the widget-capture trick in `pi-editor-input.ts`),
   otherwise it fires inside overlays, dialogs and selectors. Return `{consume: true}`.
3. `pi.registerShortcut("down", …)`: **unsuitable.** `down` is not reserved (`$PCA/core/extensions/runner.js:9-28`),
   so it is accepted with a conflict warning, but it is matched first and always consumed (`IM:1755-1767`), which
   kills cursor-down and history-forward everywhere in the editor. Fine for free combos like `shift+down`.

Keybinding API: none for extensions. `keybindings.json` only resolves known `tui.*`/`app.*` ids; shortcuts are
fixed `KeyId`s. A `custom()` factory receives the `KeybindingsManager` (`matches(data, id)`, `getKeys(id)`), and
`getKeybindings()` from pi-tui gives the global one.

Key helpers (`$TUI/keys.d.ts`): `matchesKey(data, keyId)`, `parseKey(data)`, `isKeyRelease`, `isKeyRepeat`,
`decodePrintableKey`; `Key.up|down|left|right|enter|escape|tab|space|backspace|delete|home|end|pageUp|pageDown|f1..f12`,
symbol names, and `Key.ctrl(k)`, `Key.shift(k)`, `Key.alt(k)`, `Key.super(k)`, `Key.ctrlShift(k)`, … `KeyId` strings
look like `"shift+down"`.

### Already wrapped by our adapter

- `onTerminalInput` yes (`pi-editor-input.ts`, only for `tui.input.submit`). `setEditorComponent` yes
  (`pi-editor-frame.ts`, render/mouse only, no `handleInput`). `keyText`, `Key`/`matchesKey` (inside overlays,
  `pi-ui.ts:keyPress`). No `registerShortcut`.

### Adapter additions needed

- `EditorFrame.onKey?(key: KeyPress, state: {empty: boolean; autocomplete: boolean}) => boolean` (or a narrow
  `onEmptyDown`) handled in `FramedEditor.handleInput`; optionally `host.registerShortcut(keyId, handler)`.

---

## Need 3: overlays, widgets, status, footer, notify, title

### Facts

```ts
custom<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void)
            => (Component & { dispose?(): void }) | Promise<...>,
          options?: { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions);
                      onHandle?: (handle: OverlayHandle) => void }): Promise<T>;           // types.d.ts:121
```

`OverlayOptions` (`$TUI/tui.d.ts:134-161`): `width` (cols or `"50%"`), `minWidth`, `maxHeight`, `anchor`
(`center|top-left|top-right|bottom-left|bottom-right|top-center|bottom-center|left-center|right-center`),
`offsetX/Y`, `row`, `col`, `margin` (number or `{top,right,bottom,left}`), `visible(w,h)`, `nonCapturing`.
`custom()` evaluates a function-form `overlayOptions` only once, when the overlay is shown (`IM:2357-2367`); only `visible(w,h)` runs every render. `OverlayHandle` (`:177-192`): `hide`, `setHidden`, `isHidden`,
`focus`, `unfocus({target})`, `isFocused`, `getBounds`.

Semantics (`IM:2324-2391`, `showExtensionCustom`):
- Non-overlay: the component **replaces the editor area** and gets focus; on `done()` the editor and its saved text
  come back.
- Overlay: `tui.showOverlay(component, options)`; focus moves to it unless `nonCapturing`. `done(result)` resolves the
  promise, calls `this.ui.hideOverlay()` and `dispose()`.
- **No built-in Escape handling**: the component must map Escape (`keybindings.matches(data, "tui.select.cancel")`)
  to `done()`.
- `done()` calls `hideOverlay()`, which pops the **topmost** overlay (`$TUI/tui.js:468-482`), not necessarily its
  own, and restores focus to the next visible overlay or the pre-focus.

List → detail → back: two options.
- One overlay whose component swaps its own view state (what `pi-ui.ts openOverlay` + `OverlayFactory` already does).
  Robust; recommended.
- Nested `ctx.ui.custom()` from inside the first overlay: the second stacks on top and takes focus; closing it (LIFO)
  returns focus to the first. Closing out of order hides the wrong overlay, so never close the outer one while the
  inner one is open.

Widgets (`types.d.ts:101-104`, `IM:1853-1886, 1933-1955`):
```ts
setWidget(key, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
setWidget(key, content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, options?): void;
```
Default placement `aboveEditor`; string arrays are capped at 10 lines (`MAX_WIDGET_LINES`), factories are not.
Re-setting a key disposes the old component. Widgets are laid out in normal flow (they push the editor),
never get keyboard focus from pi. In fullscreen mode a widget can receive mouse events and could grab focus by
returning `{focus: true}` from `handleMouse` (`$TUI/tui.d.ts:37-38`), but then it must hand focus back itself
(`tui.setFocus(editor)`). Not a supported pattern.

Typing while UI shows:
- capturing overlay or non-overlay `custom()`: keys go to it, the editor is frozen (text preserved);
- `nonCapturing: true` overlay: the editor keeps focus; `handle.focus()`/`unfocus()` toggles;
- widgets, status, footer: never take keys; the user keeps typing;
- `ctx.ui.onTerminalInput` listeners see every key regardless of focus.

Other UI:
- `setStatus(key, text|undefined)`: keyed text in the built-in footer (`footerData.getExtensionStatuses()` for custom footers).
- `setFooter(factory(tui, theme, footerData))` / `setFooter(undefined)`; `setHeader(factory)`.
- `notify(msg, "info"|"warning"|"error")`: **not a toast**. It appends a transcript line: `info` is a dim line that
  replaces the previous consecutive info line, `warning`/`error` add `Warning: …`/`Error: …` (`IM:2312-2322, 3107-3125, 3788-3797`). Not persisted.
- `setTitle(title)` → `terminal.setTitle` (`IM:2073`).

### Already wrapped by our adapter

- Yes: `custom` overlay at `width:"100%", maxHeight:"100%"` with our own key mapping (`pi-ui.ts openOverlay`),
  `setWidget` (always `belowEditor`, line-array renderer, `refresh()` via captured TUI), `setStatus`, `setFooter`
  (`pi-footer.ts`), `notify`, `select/confirm/input`. Not wrapped: `overlayOptions` other than full-screen,
  `onHandle`, `nonCapturing`, `placement: "aboveEditor"`, `setTitle`, `setHeader`.

### Adapter additions needed

- `openOverlay(factory, { anchor?, width?, maxHeight?, margin?, nonCapturing? })` and a returned handle
  (`focus/unfocus/setHidden`) for a "tasks" panel; `setWidget(key, render, { placement })`.

---

## Need 4: rendering in the main transcript

### (a) Tool call blocks

```ts
renderShell?: "default" | "self";                                                          // types.d.ts:464
renderCall?: (args, theme: Theme, context: ToolRenderContext<TState, Args>) => Component;   // :503
renderResult?: (result: AgentToolResult<TDetails>, options: { expanded: boolean; isPartial: boolean },
                theme: Theme, context: ToolRenderContext) => Component;                    // :505
interface ToolRenderContext<TState, TArgs> {                                               // :347-379
  args; toolCallId; invalidate: () => void; lastComponent: Component | undefined; state: TState; cwd: string;
  executionStarted: boolean; argsComplete: boolean; isPartial: boolean; expanded: boolean; showImages: boolean;
  isError: boolean; durationMs: number | undefined; outputPad: number;
}
registerToolRenderer(resolver: (toolName, next) => ToolRenderers | undefined): void;        // :1232
```

`ToolExecutionComponent` (`$PCA/modes/interactive/components/tool-execution.js`) re-runs **both** renderers in
`updateDisplay()`, which is called from `updateArgs` (streamed args), `markExecutionStarted`, `setArgsComplete`,
`updateResult(result, isPartial)` (every `onUpdate` → `tool_execution_update`, and the final result),
`setExpanded` (Ctrl+O `app.tools.expand`, or a left click on the block), and `invalidate()`:

```js
getRenderContext(lastComponent) { return { ..., invalidate: () => { this.invalidate(); this.ui.requestRender(); }, ... } } // :74-93
```

Live updates are possible two ways:
1. Call `context.invalidate()` (store it from the first render, e.g. in `context.state`) from a timer or on child
   events: renderers re-run with fresh `ToolRenderContext`. Works while running **and after the tool returned**
   (the component stays in the chat container) until the transcript is rebuilt (resume, `/tree`, theme reload),
   after which renderers see only `args` and the persisted `result.details`.
2. Return a component whose `render(width)` reads live state; any `tui.requestRender()` repaints it (`Box` re-renders
   children every frame and only caches identical output, `$TUI/components/box.js:83-127`). `Text` caches its text,
   so plain `Text` needs `setText` or approach 1.

The block background: `toolPendingBg` while `isPartial`, then `toolSuccessBg`/`toolErrorBg`; `renderShell: "self"`
drops the coloured `Box` so a one-line "Agent explorer: … (running · 3 tool uses · 12s)" is possible.
`durationMs` is only set on the final result.

Caveat for `regular` tuiMode: changing a line above the viewport forces a full redraw that clears the scrollback
(`$TUI/tui-main-screen.js:409`, "firstChanged < viewportTop"). Tick only while the block is likely on screen, or
put the live counter in a widget. Fullscreen (default) has no such cost.

Theme helpers: `theme.fg(ThemeColor, s)`, `bg(ThemeBg, s)`, `bold/italic/underline/inverse/strikethrough`,
`style(s, {fg,bg,...})` (Need 7). Components: `Text(text, padX, padY, bgFn?)`, `Container`, `Box`, `Spacer`,
`Markdown`, `TruncatedText` from pi-tui; `keyHint("app.tools.expand", "to expand")`, `truncateToVisualLines`,
`highlightCode`, `renderDiff` from pi-coding-agent.

### (b) Custom transcript entries and the wake message

```ts
appendEntry<T>(customType: string, data?: T): void;                                       // :1248, not sent to the LLM
registerEntryRenderer<T>(customType, (entry: CustomEntry<T>, { expanded }, theme) => Component | undefined): void; // :1230
sendMessage<T>(message: { customType; content: string | (TextContent|ImageContent)[]; display: boolean; details?: T },
               options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;   // :1234
registerMessageRenderer<T>(customType, (message: CustomMessage<T>, { expanded, outputPad }, theme) => Component | undefined): void; // :1226
sendUserMessage(content, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void; // :1243
registerMarkdownTransformer(transformer: (markdown, { messageType: "user"|"assistant"|"assistant-thinking", ... }) => string): void; // :1228
```

- "✓ explorer finished · 42s": `pi.appendEntry("subagents-done", data)` + `registerEntryRenderer`. Rendered live via
  `entry_appended` (`IM:2780-2784`; inserted **above** the streaming assistant message if one is in progress,
  `IM:3126-3144`) and on resume. `CustomEntryComponent` adds one `Spacer(1)` before it; returning `undefined` hides it.
  The model never sees it.
- `sendUserMessage` has **no display option**; it always renders a full user message (`UserMessageComponent`).
  A markdown transformer could restyle its text but not its box.
- **Hidden or compact wake**: `pi.sendMessage({customType:"subagents-wake", content, display:false|true, details},
  {triggerTurn:true, deliverAs:"followUp"})`. It is sent to the model as a user-role message (`$PCA/core/messages.js:89-96`)
  and persisted as a `custom_message` entry. `display:false` hides it; `display:true` renders via
  `CustomMessageComponent` → our `registerMessageRenderer` component (default: `[customType]` label in a
  `customMessageBg` box). Delivery (`agent-session.js:1782-1820`): streaming → `agent.followUp/steer` (same run);
  idle + `triggerTurn` → `_runAgentPrompt(message)` directly.
- **Caveat (important):** the idle path skips `prompt()`, so **no `input` and no `before_agent_start` event**
  (`before_agent_start` is emitted only at `agent-session.js:1591`). Our `setMainPrompt` replacement lives in
  `before_agent_start`. In such a run `_runSystemPromptOptions` stays unset, and from the second turn on
  `prepareNextTurn` rebuilds the prompt from `_baseSystemPromptOptions` (`agent-session.js:544-553`), i.e. the
  un-replaced prompt, which appends a system-prompt patch (model sees a different prompt; cache risk). Options:
  wake with `sendMessage` only while streaming and keep `sendUserMessage` when idle; or verify with `test:live`
  first. A follow-up queued during a `prompt()` run keeps that run's options.
- Also: calling `sendUserMessage`/`sendMessage` from an `agent_settled` handler is deferred until the settled emit
  finishes (`agent-session.js:1515-1518, 1804-1806`).

### (c) `setMessageRenderer`

There is no `ctx.ui.setMessageRenderer`. The real APIs are `pi.registerMessageRenderer` (custom messages),
`pi.registerEntryRenderer` (custom entries) and `pi.registerToolRenderer` (any tool, including built-in/MCP).

### Already wrapped by our adapter

- `pi-tools.ts toPiTool`: `renderCall(args, theme)` → string, `renderResult(result, {expanded, invalidate}, theme)`
  → string, both wrapped in a reused `Text`. It drops `ToolRenderContext` for calls (no `invalidate`, `state`,
  `toolCallId`, `isPartial`, `executionStarted`, `durationMs`), always uses `renderShell: "default"`, and its
  `onUpdate` sends `details: undefined`, so partial renders lose live details.
- `appendEntry` yes; `sendUserMessage` yes (idle → plain, streaming → `followUp`). No `sendMessage`,
  `registerMessageRenderer`, `registerEntryRenderer`, `registerToolRenderer`.

### Adapter additions needed

- Tool spec: `renderShell`, `renderCall(params, theme, ctx: {invalidate, expanded, isPartial, executionStarted, durationMs, toolCallId})`,
  and `update(text, details)` forwarding details.
- `host.appendEntry` + `host.registerEntryRenderer(customType, (data, {expanded}, theme) => string[] | undefined)`.
- `host.wake(text, {display: "hidden"|"compact", customType, details})` built on `sendMessage`, with the main-prompt
  caveat above solved first; `host.registerMessageRenderer`.

---

## Need 5: codemode

### Facts

- The tool lives in pi-coding-agent, not pi-codemode (`pi-codemode` is only the QuickJS sandbox, `CodemodeSandbox`).
  `$PCA/extensions/codemode/tool.js`: name `"codemode"`, `exposure: "model-only"`, registered with
  `defaultActive: false` (`index.js`), constrained-sampling grammar for raw JS.
- Parameters (`tool.js`): `Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) })`.
  Optional first line `// @options: {"max_output_tokens": …, "timeout_ms": …}`.
- Result (`execute.js:363-470`):
  ```js
  return { content: [{ type: "text", text: `${ok ? "Script completed" : "Script failed"}\nWall time ${s} seconds\nOutput:\n` }, ...output],
           details: { calls: CodemodeNestedCall[], fullOutputPath? }, ...(modelUsage ? { usage } : {}), ...(ok ? {} : { isError: true }) };
  ```
  `output` = `text()`/`image()` items (several texts get `==> text N/M <==` headers), the `return` value, then
  console lines in one `<console_output>` block, then `Script error:\n…` on failure. `CodemodeNestedCall` =
  `{id, name, args (compact JSON), status: "running"|"ok"|"error"|"cancelled", durationMs?, error?, cost?}`.
  Live progress: `onUpdate({content: [], details: {calls}})` on every nested call start/end. Nested calls also emit
  `tool_execution_*` with `parentToolCallId`, and the final `toolResult` message carries `nestedCalls`.
- Renderer (`$PCA/extensions/codemode/renderer.js`, `codemodeRenderers`):
  ```js
  renderCall(args, theme, context) {
      const code = str(args?.code); const title = theme.fg("toolTitle", theme.bold("codemode"));
      const component = context.lastComponent ?? new Container(); component.clear();
      component.addChild(new Text(title, 0, 0));
      const highlighted = highlightCode(replaceTabs(code.replace(/\r/g, "").trimEnd()), "javascript").join("\n");
      component.addChild(context.expanded ? new Text(highlighted, 0, 0)
          : new VisualLinePreview({ text: highlighted, maxVisualLines: 10, keep: "start",
                                    formatHint: (hidden) => expandHint(theme, hidden, "lines") }));
  }
  renderResult(result, options, theme, context) {
      // calls: last 8 when collapsed ("... (N earlier calls, ctrl+o to expand)"), each
      // `${icon} ${toolTitle(name)} ${muted(args≤80)} ${dim(duration)} ${dim($cost)}`, icons …(warning) ✓(success) ✗(error) ⊘(muted);
      // "Model calls: $x" when >1 priced call; then the script output without the "Script completed…" header,
      // hidden while isPartial, 5 visual lines collapsed / full when expanded, "Full output: <path>" if truncated.
  }
  ```
  So in the main TUI: title + syntax-highlighted JS (10 visual lines collapsed, full with Ctrl+O), a live list of
  nested calls with status icons, then the output preview.
- Reuse: `codemodeRenderers`, `VisualLinePreview`, `createCodemodeToolDefinition` are **not exported**.
  Exported (`$PCA/index.d.ts:29-37`): `createCodemodeExtension`, `createToolSearchExtension`, type `CodemodeToolDetails`,
  `ToolExecutionComponent`, `AssistantMessageComponent`, `CustomMessageComponent`, `UserMessageComponent`,
  `keyHint`, `keyText`, `truncateToVisualLines`, `renderDiff`, `highlightCode(code, lang?) => string[]`,
  `getLanguageFromPath`, `getMarkdownTheme`, `Theme`. pi-tui exports `Text`, `Markdown`, `Box`, `Container`,
  `Spacer`, `TruncatedText`; there is no `CodeBlock` component (Markdown renders fenced code with `highlightCode`).
  To get codemode's renderers without importing internals, run the exported factory against a stub:
  ```ts
  let def: ToolDefinition | undefined;
  createCodemodeExtension()({ registerTool: (d: ToolDefinition) => { def = d; } } as unknown as ExtensionAPI);
  // def.renderCall / def.renderResult never touch pi; pass `def` to new ToolExecutionComponent("codemode", …)
  ```
  The same works for `tool_search`. Our child-transcript `createTranscriptPane` (`pi-ui.ts`) only maps the eight
  built-in tool factories, so codemode calls in agent views currently fall back to `formatToolCallWithArgs`.
- `tool_search` (`$PCA/extensions/tool-search/tool.js`): params `{query: string, limit?: number}` (default 8),
  result text `"No matching tools found."` or `"Loaded N tools. They are available from your next call:\n- name: first description line"`,
  `details: {loaded: string[]}`. **No custom renderer**, so pi shows the generic fallback: bold `tool_search` +
  muted `query="…" limit=…` (80 chars collapsed, `key: value` lines expanded), then the first 10 output lines with an
  expand hint (`tool-execution.js:96-114`, `core/tools/render-utils.js:60-79`).

### Already wrapped by our adapter

- `pi-child.ts` loads `createCodemodeExtension()`/`createToolSearchExtension()` into children. Rendering: no.

### Adapter additions needed

- Extend `toolDefinitionFactories` in `createTranscriptPane` with `codemode` and `tool_search` definitions captured
  through the stub above, so agent views render codemode exactly like the main transcript.

---

## Need 6: idle detection and notifications

### Facts

- `agent_settled {aborted}` (`types.d.ts:777`): "Fired after an agent run has fully settled and no automatic retry,
  compaction, or queued continuation will run." Emitted once per `_runAgentPrompt`, in `finally`, after
  follow-ups/steers, retries, compaction recovery and `agent_before_settle` continuations are drained
  (`agent-session.js:1378-1412, 684-704`). Prompts started from a settled handler are deferred and produce their own
  later `agent_settled`.
- `agent_end`: per low-level loop exit; can repeat inside one settled run (Need 1). `turn_end`: per assistant
  response (after its tools).
- `ctx.isIdle()`, `ctx.hasPendingMessages()` are available on the context.
- Child sessions: each `createAgentSession` has its own `ExtensionRunner` and `_eventListeners`
  (`agent-session.js:650-654`). Child events reach only the child's extensions and `session.subscribe` listeners
  (`pi-child.ts:305-340`); nothing leaks into the parent's `pi.on` handlers, and our extension factory returns early
  inside a child (`insideChildSession()`). `agent_settled` does fire for children, seen via `session.subscribe`.
- Terminal focus: **not exposed.** Fullscreen mode enables `?1004h` focus reporting with mouse mode
  (`$TUI/tui-alt-screen.js:16-19`), but the alt-screen viewport listener is registered in the constructor (first in
  the listener set, `:105`) and consumes `\x1b[I`/`\x1b[O` (`:476-501`), so `onTerminalInput` never sees them.
  Regular mode does not enable focus reporting. Workaround (unsupported, works in both modes): a second
  `process.stdin.on("data")` listener (pi-tui itself uses `process.stdin.on("data")`, `$TUI/terminal.js:202`) that
  looks for `\x1b[I`/`\x1b[O`; in regular mode also write `\x1b[?1004h` and consume the two sequences in an
  `onTerminalInput` listener so the editor does not receive them; write `\x1b[?1004l` on shutdown.
- pi's own notifications: **no bell or desktop-notification setting.** It has `showTerminalProgress` (OSC 9;4
  progress, `settings-manager.d.ts:36`) and always reports OSC 7501 program status (`working`, `blocked` during
  dialogs, `done`/`error`/`idle` after `agent_settled`) via `ProgramStatusReporter`. `tui.terminal.setProgramStatus`,
  `setProgress`, `setTitle`, `write` exist on `Terminal`.

### Already wrapped by our adapter

- `agent_settled` → `host.onIdle`; `isIdle`; `terminalNotify` writes BEL + OSC 9 / OSC 777 (`pi-ui.ts`).
  No focus tracking.

### Adapter additions needed

- `host.ui.terminalFocused(): boolean | undefined` built on the stdin workaround (undefined when unknown), so
  notifications can be skipped while the terminal is focused.

---

## Need 7: timers, render throttling, theme colours

### Facts

- `tui.requestRender(force = false)` (`$TUI/tui.js:624-675`): coalesces requests and renders at most every
  `MIN_RENDER_INTERVAL_MS = 16` ms; `force` resets render state and redraws immediately. Key input triggers an
  immediate render.
- Nothing re-renders on an interval by itself. Widgets, footers and tool blocks re-render whenever **anything**
  requests a render: while the main agent works, the working `Loader` ticks every 80 ms (`$TUI/components/loader.js:2-3`,
  `setInterval`) and streaming deltas render too, so widgets refresh "for free". While idle, a ticking clock needs its
  own `setInterval` → `tui.requestRender()` (clear it in `dispose()` and on `session_shutdown`). 1 s is enough for
  elapsed-seconds counters.
- Theme (`$PCA/modes/interactive/theme/theme.d.ts`): `ctx.ui.theme` or the `theme` passed to factories/renderers.
  `fg(color: ThemeColor, text)`, `bg(color: ThemeBg, text)`, `bold`, `italic`, `underline`, `inverse`,
  `strikethrough`, `style(text, {fg, bg, bold, …})`, `getThinkingBorderColor(level)`, `colors`, `appearance`.
  `ThemeColor` includes `accent, border, borderAccent, borderMuted, success, error, warning, muted, dim, text,
  thinkingText, userMessageText, customMessageText, customMessageLabel, toolTitle, toolOutput, md*, toolDiff*,
  syntax*, thinkingOff…thinkingMax, bashMode, scrollbarTrack/Thumb, searchMatchText`; `ThemeBg` is
  `selectedBg, searchMatchBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg`.

### Already wrapped by our adapter

- `ThemeLike` exposes only `fg(token, text)` and `bold(text)`; `HostUi.style(token, text)`; widget/footer
  `refresh()` → `tui.requestRender()`.

### Adapter additions needed

- `ThemeLike.bg` (for `toolPendingBg`/`customMessageBg`), `italic`; a `host.ui.every(ms, fn)` or widget option
  `tickMs` that owns the interval and clears it on dispose/shutdown.
