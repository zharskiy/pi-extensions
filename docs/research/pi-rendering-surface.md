# Replacing pi's transcript components: feasibility report

Describes pi 1.4.0 as installed on 2026-10-23.

Paths are abbreviated: `PCA` = `node_modules/@earendil-works/pi-coding-agent/dist`, `TUI` = `node_modules/@earendil-works/pi-tui/dist`.

## 1. Rendering APIs per component kind

All public extension rendering APIs live in `PCA/core/extensions/types.d.ts`.

**(a) User message rows: no hook exists.**
- `addMessageToChat` builds `new UserMessageComponent(text, markdownTheme, outputPad, transformers)` directly (`PCA/modes/interactive/interactive-mode.js:3148-3170`). Skill blocks use `SkillInvocationMessageComponent`.
- The component is a Markdown block with `userMessageText` on a `userMessageBg` background, wrapped in OSC 133 zone markers (`components/user-message.js:27-47`).
- The only public lever is `pi.registerMarkdownTransformer(fn)` (`types.d.ts:1252`). It rewrites the markdown string before render, with context `messageType: "user" | "assistant" | "assistant-thinking"`, `isStreaming` and `availableWidth` (`types.d.ts:~1157-1162`). Its contract is string to string, and it cannot change the background, the padding or the component (`components/markdown-transform.js:1-18`).
- `UserMessageComponent` and `AssistantMessageComponent` are exported from the package index (`PCA/index.d.ts:37`; CHANGELOG line 4685, "Exported all UI components for extensions").
- Extensions resolve `@earendil-works/pi-coding-agent` to pi's own dist through a jiti alias (`PCA/core/extensions/loader.js:55-66`). Patching `UserMessageComponent.prototype.rebuild/render` would therefore reach the instances pi creates. That works, but it is internals, not a contract.

**(b) Assistant text rows: no hook exists.**
- `message_start` creates `new AssistantMessageComponent(undefined, hideThinkingBlock, mdTheme, hiddenThinkingLabel, outputPad, transformers)`, and each `message_update` calls `updateContent(message, true)` (`interactive-mode.js:2796-2807`). History replay uses the same constructor (`interactive-mode.js:~3172-3176`).
- `updateContent` clears the container and rebuilds a `Markdown` per text block on every update (`components/assistant-message.js:69-88`).
- Public levers:
  - the markdown transformer (string only);
  - `outputPad`;
  - the `md*` theme tokens.
- Full replacement is possible only by overriding `AssistantMessageComponent.prototype.updateContent` (internal, and its signature is not documented).

**(c) Thinking block: label and visibility only.**
- Inside `AssistantMessageComponent`, the visible case is a Markdown block with `thinkingText` colour and italic. The hidden case is `Text(italic(fg("thinkingText", hiddenThinkingLabel)))`. Each run is wrapped in a `MouseRegion` whose left click toggles that run (`assistant-message.js:89-127`).
- `ctx.ui.setHiddenThinkingLabel(label?)` is public (`types.d.ts:99`). It has been stable since it was added (CHANGELOG 2963/2973).
- The `hideThinkingBlock` setting (docs/settings.md:19) is read at `interactive-mode.js:414`. `app.thinking.toggle` (Ctrl+T) flips it and persists the setting (`interactive-mode.js:3724-3728`).
- No extension API sets `hideThinkingBlock`. Restyling beyond label and colour requires the same prototype override as (b).

**(d) Tool call and tool result rows: cleanly replaceable for all tools.**
- `pi.registerToolRenderer((toolName, next) => ToolRenderers | undefined)` (`types.d.ts:1256`, type at `:521-526`; docs/extensions.md:303-305).
- The resolvers wrap `withBuiltInRenderers(toolName, def)` (`interactive-mode.js:1705-1706`; `core/extensions/runner.js:542-546`; `core/tools/renderers/index.js:17-45`). It therefore covers built-ins (read, bash, powershell, edit, write, grep, find, ls), extension tools, MCP tools and not-yet-registered tools.
- It was added in 1.0.x (CHANGELOG 287/296) and is documented as public.
- Contract:
  - `renderCall(args, theme, ctx) => Component`
  - `renderResult(result, {expanded, isPartial}, theme, ctx) => Component` (`types.d.ts:516-518`)
  - `ctx` = `ToolRenderContext`: `args`, `toolCallId`, `invalidate`, `lastComponent` (reuse), `state`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`, `durationMs`, `outputPad` (`types.d.ts:~350-378`; built at `components/tool-execution.js:74-93`)
  - `renderShell: "self"` removes pi's coloured Box (`types.d.ts:469`; `tool-execution.js:196-201`)
- What pi still owns:
  - It wraps each call and result component in a `MouseRegion` whose click toggles `expanded` (`tool-execution.js:112-118`).
  - Image blocks are appended by pi.
  - A renderer that throws falls back to pi's text.
- Repo gap: the repo's adapter does not wrap `registerToolRenderer` today. It only uses `renderCall`/`renderResult` on its own `ToolSpec`s (`core/adapter/pi-tools.ts:198-250`), so built-in tool rows cannot be restyled through `Host` yet.

**(e) Custom entries and messages: cleanly replaceable.**
- `registerEntryRenderer(type, (entry, {expanded}, theme) => Component | undefined)` and `registerMessageRenderer(type, (message, {expanded, outputPad}, theme) => Component | undefined)` (`types.d.ts:1169-1170, 1250, 1254`). Both are old and stable (CHANGELOG 4859/5183).
- An entry gets a `Spacer(1)` plus your component (`components/custom-entry.js:37-55`).
- A message without a renderer falls back to a `customMessageBg` box labelled `[customType]` (`components/custom-message.js:23-70`).

## 2. Mouse support

Yes, but only in fullscreen mode.
- `tuiMode` defaults to `"fullscreen"` since 1.0.0 (docs/settings.md:97; CHANGELOG 328/345).
- In fullscreen pi-tui enables SGR tracking: `\x1b[?1000h\x1b[?1002h…?1006h` (`TUI/tui-alt-screen.js:16-18, 96, 194`). Regular mode leaves the mouse to the terminal (docs/tui.md:56-62).

How a component receives a click:
- It implements the optional `handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined` on `Component` (`TUI/tui.d.ts:78`).
- The event carries `type` (`press|release|move|drag|click|wheel`), `button`, local `x`/`y`, `screenX`/`screenY`, `width`/`height`, modifiers and `clickCount` (`tui.d.ts:10-31`).
- The result can set `handled`, `capture`, `focus` and `render` (`tui.d.ts:33-46`).
- `Container.handleMouse` routes the click by child height from the last render (`TUI/tui.js:116-148`).
- `MouseRegion(child, handler)` wraps any component (`TUI/components/mouse-region.d.ts`; public export at `TUI/index.d.ts:12`).
- Nothing extra has to be enabled. Pi already uses this for thinking-run toggles and tool expand toggles.
- The repo already handles clicks in overlays (`core/adapter/pi-ui.ts:173-186`) and in its transcript pane (`core/adapter/pi-transcript.ts:246-262`).

Caveats:
- No click in regular mode.
- Extensions are not told the `tuiMode`; it appears nowhere in `types.d.ts`.
- Docs require a keyboard path for every interaction.

Keyboard alternatives:
- `app.tools.expand` (Ctrl+O) is surfaced through `getToolsExpanded()/setToolsExpanded()` (`types.d.ts:~195-198`).
- Ctrl+T toggles thinking.

## 3. Render scheduling during streaming

- It is throttled. `requestRender()` coalesces into one pending flag, then `scheduleRender()` with `setTimeout(max(0, MIN_RENDER_INTERVAL_MS - elapsed))`. `static MIN_RENDER_INTERVAL_MS = 16` gives about 60 fps (`TUI/tui.js:189-193, 658-668, 693-712`).
- `requestRender(true)` and user input take an immediate `nextTick` path (`tui.js:669-686`).
- Pi calls `requestRender()` on every `message_update` (`interactive-mode.js:2827`). The component state (`updateContent`) is rebuilt on every chunk, but terminal output happens at most once per 16 ms.
- Could an extension debounce its rendered text? Yes, if it owns the component. A component's `render(width)` can return cached lines and refresh its text on a timer, calling `invalidate()` and then the injected `tui.requestRender()`.
- Today that is possible only for tool rows, entries, widgets and overlays. Tool renderers can reuse `ctx.lastComponent` and call `ctx.invalidate()`.
- For assistant text it requires the prototype override from 1(b).

## 4. "Thinking..." and the streaming indicator

**The string itself:**
- `"Thinking..."` is `defaultHiddenThinkingLabel` (`interactive-mode.js:272`), with the constructor default at `assistant-message.js:21`.
- It shows only for a collapsed thinking run: `hideThinkingBlock` is true, or the user clicked the run closed.
- When thinking is visible, pi shows the thinking text itself (italic, `thinkingText`).

**The working line during streaming:**
- It is a separate `WorkingStatusIndicator` with message `defaultWorkingMessage = "Working"` plus the interrupt hint (`interactive-mode.js:271, 1813-1817, 1922`; `components/status-indicator.js:22-25`).

**Overrides, all public:**
- `ctx.ui.setHiddenThinkingLabel(label?)` (`types.d.ts:99`). It is restored on reload (`interactive-mode.js:1924`).
  - `""` is accepted because the code uses `label ?? default` (`interactive-mode.js:1838-1846`).
  - But `italic(fg(...""))` still contains ANSI codes, so `Text` (which only skips blank text, `TUI/components/text.js:47`) draws an empty line rather than nothing.
- `ctx.ui.setWorkingMessage(msg?)`, `setWorkingVisible(false)` and `setWorkingIndicator({frames: []})` (`types.d.ts:86-97`).

**Repo support:**
- The repo wraps the three working calls in `core/adapter/pi-working.ts:4-30`.
- It does not wrap `setHiddenThinkingLabel`.
- Removing the thinking row entirely is possible only by replacing the component, or by the user setting `hideThinkingBlock` (which then shows the label).

## 5. Colours and accent tokens

**Where pi's colours come from:**
- Pi's components colour through the global `theme` (`modes/interactive/theme/theme.js`).
- Token names are defined in `theme/theme-tokens.js:16-91` and are customisable per theme.

**How the repo maps them:**
- `ThemeToken` (`core/adapter/contract.ts:10-24`) is mapped in `PI_COLORS` (`core/adapter/pi-tools.ts:37-60`):

| Repo token | Pi token |
|---|---|
| accent / muted / dim / success / warning / error / text | same name |
| comment | `syntaxComment` |
| keyword | `syntaxKeyword` |
| function | `syntaxFunction` |
| string | `syntaxString` |
| number | `syntaxNumber` |
| type | `syntaxType` |
| heading | `mdHeading` |

- `ThemeLike` exposes only `fg` and `bold` plus metrics. There is no `bg` and no italic.

**Blue- and purple-like tokens in the default dark theme** (`theme/dark.json`):
- Purple/violet:
  - `accent` = violet `okhsl(295 50% 67%)`
  - `borderAccent` (295)
  - `mdCode`, `mdListBullet`, `syntaxType` and `customMessageLabel` = violet
  - `thinkingMedium` (263) and `thinkingHigh` (295)
- Blue:
  - `mdLink` and `syntaxKeyword` = blue `okhsl(232 54% 67%)`
  - `border` (231)
  - `thinkingLow` (232)
- Cyan: `syntaxVariable` (202).
- Background slots: `selectedBg`/`userMessageBg` = `blueBg`, and `customMessageBg` = violet 24%.

**What that means for new components:**
- Today blue is reachable as the repo's `keyword` token and violet as `accent` or `type`.
- Cleaner role tokens would be new `ThemeToken`s, for example `link`→`mdLink`, `border`→`border`, `borderAccent`→`borderAccent`, plus a `bg` role for `userMessageBg`/`selectedBg`.
- The hues depend on the user's theme; `light.json` differs.

## 6. Rows this repo already renders

| Source | API | Returns |
|---|---|---|
| questionnaire call/result (`extensions/questionnaire/src/questionnaire.ts:128-129`, `summary.ts:14-40`) | `ToolSpec.renderCall/renderResult` | `string` (multi-line via `\n`) |
| context snapshot (`extensions/context/src/context.ts:30-38`, `render.ts:125`) | `Host.registerEntryRenderer` | `string[]` (adapter cuts to width, `pi-entries.ts:6-18`) |
| run_agent (`subagents/.../run-agent/tools.ts:206, 258-273`; `render.ts:287-297`) | `renderShell:"box"`, `renderCall: ""`, `renderResult`, `renderTone` | `(width) => string` (cached per width) |
| message_agent (`tools.ts:313-324`) | box, error-only result | `string` |
| agent_status (`agent-status/index.ts:60`), handoff (`handoff-tool.ts:60`) | `renderCall` | `string` |
| agent panel (`agent-panel/index.ts:36, 77`) | `HostUi.setWidget` | `(width, theme) => string[]` |
| handoff seed message (`core/adapter/pi-adapter.ts:72-74`) | `sendMessage display:true`, no renderer | pi's default `[customType]` box |
| agent-view transcript overlay (`core/adapter/pi-transcript.ts:165-197`) | builds pi's `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent` and `CustomMessageComponent` directly | pi components |

- The shared shape is `ToolRender = string | (width) => string` (`contract.ts:50`) or `string[]` with a width (`contract.ts:262`).
- A shared row component could therefore be a pi-free `(width, theme, state) => string[]` living in `core/manager`, adapted to each case: tool row, entry, widget, and the overlay transcript.
- The agent-view overlay would have to switch from pi's message components to the shared rows to look consistent.

## Feasibility verdict

| Component | Verdict |
|---|---|
| Tool call/result rows, built-in and extension tools | **Replaceable cleanly** via `registerToolRenderer` + `renderShell:"self"`. Needs a new `Host` method in `core/adapter`. |
| Custom entries / custom messages | **Replaceable cleanly** (`registerEntryRenderer` / `registerMessageRenderer`). |
| Working line ("Working…") | **Replaceable cleanly** (`setWorkingVisible(false)` + own widget, or message and indicator). |
| Thinking label | **Restylable cleanly** (`setHiddenThinkingLabel`). Full thinking block: **internals only**. |
| Assistant text | **Text transform only, cleanly.** Full component: **internals only** (prototype override of the exported `AssistantMessageComponent.updateContent`). |
| User message | **Text transform only, cleanly.** Background, frame or layout: **internals only** (prototype override of `UserMessageComponent.rebuild`/`render`). |

## Upgrade-risk points

1. Prototype overrides depend on undocumented members: `updateContent(message, isStreaming)`, `rebuild`, the constructor argument order (6 positional args), `contentContainer`, and `thinkingVisibilityOverrides`. Any refactor breaks them silently. The `markdownTransformers` argument was added recently.
2. The positional construction in `interactive-mode.js` (2796, 3148-3176) may change. Pi may also add or rename message roles, as with skill blocks and `bashExecution`.
3. `ToolRenderContext` gains fields over time; `durationMs` and `outputPad` are recent. Pi also wraps renderers in a click `MouseRegion` and image handling. Renderers relying on `lastComponent` reuse must tolerate pi changing when it recreates components.
4. The default `tuiMode` changed to fullscreen in 1.0.0. Mouse behaviour (regular vs fullscreen) and the `MouseRegion` semantics are young (CHANGELOG 883, 925-961), so expect changes.
5. Theme tokens are added over time (`scrollbar*`, `searchMatch*`, `thinkingMax`). Repo mappings to existing tokens are safe; a token rename would break the `satisfies` check in `pi-tools.ts:52` at compile time, which is good.
6. `MIN_RENDER_INTERVAL_MS` (16) is a static that may be retuned; nothing should depend on its value.
7. The release cadence is roughly weekly with frequent "Breaking Changes" sections (CHANGELOG 115, 250, 539, 601, 800). None of these touched the renderer APIs. Keep all pi-internal patching in a single `core/adapter` module with a conformance test in `core/test/adapter`, so a pi bump fails loudly.
