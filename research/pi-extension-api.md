# pi 1.1.0 extension and TUI API: research for the subagents extension

Date: 10 October 2026. Sources: the local 1.1.0 install only. Path aliases used below:

- `$PCA` = `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`
- `$TUI` = `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-tui`
- `types.d.ts` = `$PCA/dist/core/extensions/types.d.ts` (1732 lines). This is the real contract. The prose docs are short and point to it (`docs/extensions.md:88`).

## Executive summary

1. **Possible:** register LLM tools (TypeBox params, streaming `onUpdate`, `AbortSignal`, custom `renderCall`/`renderResult`), commands with argument completion, global shortcuts, CLI flags, and 35 lifecycle events. Many of these events can block or modify what they receive.
2. **Possible:** run agents. Pi ships a `subagent` example that spawns `pi --mode json -p --no-session` child processes (`$PCA/examples/extensions/subagent/index.ts`). Two other routes exist. RPC mode (`pi --mode rpc`, with `RpcClient`) supports steer, follow-up, abort and state queries on a long-lived child. The SDK (`createAgentSession`) runs a child in-process.
3. **Possible:** background agents. A tool can return at once and later wake the caller with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`.
4. **Possible:** an exact record of the system prompt. Every session persists a leading `role: "system"` message with named `sections` and full `toolsAdded` schemas, and later changes are appended as patches (`docs/session-format.md:80`). `before_agent_start` exposes the structured `systemPromptOptions` (tools, guidelines, skills, sections), and each handler sees the changes made by earlier handlers. `before_provider_request` exposes the raw provider payload.
5. **Possible:** a full-screen, scrollable agent view, as an overlay: `ctx.ui.custom(factory, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } })`. Fullscreen is the default `tuiMode`, and in it `ScrollView`, mouse input and `MouseRegion` work. Pi's own transcript components are exported and reusable: `AssistantMessageComponent`, `ToolExecutionComponent`, `UserMessageComponent`, `CustomMessageComponent`, `Markdown`, `Loader`, `DynamicBorder`.
6. **Possible:** persistent footer content via `ctx.ui.setStatus(key, text)`, or a full footer replacement via `ctx.ui.setFooter(factory)`. Also widgets above or below the editor (`setWidget`), which suit a progress component.
7. **NOT available:** a generic collapsible component. Neither pi-tui nor pi-coding-agent exports one. Expand and collapse in pi is a single global toggle (`Ctrl+O`, `app.tools.expand`) passed to renderers as `expanded`. We must write our own collapsible component.
8. **NOT available:** a "usage" session entry or any direct way to add to the built-in session cost. The built-in footer counts assistant messages, `toolResult.usage`, `usage` entries (written only by pi's cache warmer), and compaction or branch-summary usage. Child spending is counted only if (a) a tool result returns `usage`, or (b) we replace the footer. A background agent's tool call has already returned, so (a) does not cover it.
9. **NOT available:** per-extension settings. `pi.getSettings()` returns a fixed typed `Settings` with no extension namespace, so we need our own config file. Example extensions use `~/.pi/agent/<name>.json` and `.pi/<name>.json`. Pi also has no API to switch the main transcript to another "screen". Session switching (`newSession`, `switchSession`) is available only from command handlers.
10. **Unstable:** the API changes often. The changelog has 48 "Breaking Changes" sections, and 1.0.0 shipped on 2026-10-01. This confirms the handoff's rule that all pi calls go through one adapter.

---

## 1. Extension anatomy

### Loading and locations

- Factory signature (`types.d.ts:1494`):
  ```ts
  export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
  ```
  The module's default export is the factory (`docs/extensions.md:15-30`). Pi awaits an async factory before startup continues (`extensions.md:56`). Pi loads TypeScript through `jiti`, so no build step is needed (`extensions.md:38`).
- Discovery locations (`docs/configuration.md:21,34`; `extensions.md:46`):
  - `~/.pi/agent/extensions/`
  - project `.pi/extensions/` (loaded only after project trust)
  - `settings.json` `"extensions": [...]`, which resolves from the agent dir or `.pi` (`docs/settings.md:146-160`)
  - `pi -e <path>` / `--extension` (`docs/cli.md:194`)
  - packages (section 9)
- Files a directory scan picks up (`$PCA/dist/core/extensions/loader.js:588-630`):
  - a direct `*.ts` or `*.js` file
  - `<dir>/index.ts` or `<dir>/index.js`
  - `<dir>/package.json` with a `"pi": { "extensions": [...] }` manifest
  - "No recursion beyond one level."
- Lifecycle rules:
  - Do not start processes, sockets, watchers or timers in the factory. Start them in `session_start` or in a tool or command.
  - Clean up in an idempotent `session_shutdown` (`extensions.md:58-60`).
  - Reload replaces the runtime, so code after `await ctx.reload()` must not reuse old state (`extensions.md:50`).
  - A stale extension instance throws through `assertActive()` (`types.d.ts:1592-1595`).
- Modes: the extension loads in `tui`, `rpc`, `json` and `print` modes.
  - Guard terminal UI with `ctx.mode === "tui"`.
  - Use `ctx.hasUI` to check for dialog support (`extensions.md:248-251`; `types.d.ts:212-219`).
  - This matters because our child processes run in json or rpc mode and load the same extension.

### All events (`types.d.ts:1163-1203`, payloads at `types.d.ts:522-1015`)

The "Result / effect" column shows what a handler may return. "notify" means the return value is ignored.

| Event | Payload | Result / effect |
|---|---|---|
| `project_trust` | `cwd` | `{trusted: "yes" \| "no" \| "undecided", remember?}`. Only user-level and CLI extensions receive it. |
| `resources_discover` | `cwd, reason: startup\|reload` | `{skillPaths?, promptPaths?, themePaths?}` adds resources |
| `session_start` | `reason: startup\|reload\|new\|resume\|fork, previousSessionFile?` | notify |
| `session_info_changed` | `name` | notify |
| `session_before_switch` | `reason: new\|resume, targetSessionFile?` | `{cancel?}` |
| `session_before_fork` | `entryId, position` | `{cancel?, skipConversationRestore?}` |
| `session_before_compact` | `preparation, branchEntries, customInstructions?, reason: manual\|threshold\|overflow, willRetry, signal` | `{cancel?, compaction?}` replaces the compaction |
| `session_compact` | `compactionEntry, fromExtension, reason, willRetry` | notify |
| `session_compact_failed` | `reason, errorMessage?, aborted, willRetry, fromExtension` | notify |
| `session_shutdown` | `reason: quit\|reload\|new\|resume\|fork, targetSessionFile?` | notify; clean up here |
| `session_before_tree` | `preparation, signal` | `{cancel?, summary?, customInstructions?, replaceInstructions?, label?}` |
| `session_tree` | `newLeafId, oldLeafId, summaryEntry?, fromExtension?` | notify |
| `mcp_servers_change` | `servers` | notify |
| `context` | `messages` (no system messages) | `{messages?}`. Transforms the request without persisting; pi restores the prompt and tools afterwards (`types.d.ts:659-669`). |
| `context_with_system` | `messages` (full transcript, including system messages) | `{messages?}`. The handler owns the prompt and tool declarations for that request (`types.d.ts:670-678`). |
| `cache_warming_decision` | `warmCost, missCost, continuationProbability, action` | `{action?: "warm"\|"stop"}`; the last handler wins |
| `before_provider_request` | `payload: unknown` | a return value replaces the payload |
| `before_provider_headers` | `headers` | mutate in place; `null` deletes a header |
| `after_provider_response` | `status, headers` | notify |
| `provider_stream_event` | `provider, api, model, data` | notify; read-only, awaited in order (`extensions.md:107-111`) |
| `before_agent_start` | `prompt, images?, readonly systemPrompt, systemPromptOptions` (mutable) | `{message?, systemPrompt?}` (`types.d.ts:707-718, 1101-1105`) |
| `agent_start` | none | notify |
| `agent_end` | `messages` | notify |
| `agent_before_settle` | `BoundaryState`: `entries, continue, context, outcome` | `{entries?, continue?}`: append entries and request one more model call (`types.d.ts:762-775`) |
| `agent_settled` | `aborted` | notify. Final; pi will not continue automatically. |
| `ui_prompt_start` / `ui_prompt_end` | `kind, title?` | notify |
| `turn_start` | `turnIndex, timestamp` | notify |
| `turn_end` | `BoundaryState` + `turnIndex, message, toolResults, messageEntryId, toolResultEntryIds` | `{entries?, continue?}` (`types.d.ts:804-811`) |
| `message_start` / `message_update` | `message` (+ `assistantMessageEvent`) | notify |
| `message_end` | `message` | `{message?}` replaces the finalized message; the role must stay the same |
| `tool_execution_start` / `_update` / `_end` | `toolCallId, toolName, args, partialResult\|result, isError, durationMs?, parentToolCallId?` | notify |
| `model_select` | `model, previousModel, source` | notify |
| `thinking_level_select` | `level, previousLevel` | notify |
| `user_bash` | `command, excludeFromContext, cwd` | `{operations}` or `{result}` takes over execution |
| `input` | `text, images?, source, streamingBehavior?` | `{action: "continue"\|"transform"\|"handled"}` |
| `tool_call` | `toolCallId, toolName, input` (mutable in place), `parentToolCallId?` | `{block?, reason?, terminate?}`. A handler that throws blocks the tool (`extensions.md:260`). |
| `tool_result` | `toolCallId, input, content, structuredContent?, details, isError, usage?` | `{content?, details?, structuredContent?, isError?, usage?}`. Handlers compose (`extensions.md:105`). |

Ordering:
- Handlers run in extension load order, then registration order.
- `pi.on()` returns an unsubscribe function (`extensions.md:97`).
- Tool calls from one assistant message may run in parallel (`extensions.md:123`).

## 2. Registering tools

Full shape (`types.d.ts:448-506`):

```ts
pi.registerTool({
  name, label, description,
  promptSnippet?,            // line in the system prompt's tool list; custom tools without it are omitted
  promptGuidelines?: string[], // bullets added to the Guidelines section while the tool is active
  parameters: Type.Object({...}),  // TypeBox, import { Type } from "typebox"
  outputSchema?, prepareArguments?, constrainedSampling?,
  exposure?: "direct"|"model-only"|"codemode"|"deferred"|"hidden",
  defaultActive?, namespace?, annotations?, prepareLoadout?,
  executionMode?: "sequential"|"parallel",
  renderShell?: "default"|"self",
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>,
  renderCall?(args, theme, renderCtx): Component,
  renderResult?(result, { expanded, isPartial }, theme, renderCtx): Component,
});
```

Result shape (`$TUI/../pi-agent-core/dist/types.d.ts:370-392`):

```ts
{ content: (TextContent|ImageContent)[], details: T, structuredContent?, usage?: Usage, isError?, terminate? }
```

Result rules:
- Throw to fail. Or return `isError: true`, which keeps `details` (`extensions.md:138-146`).
- If the tool makes nested model calls, include their `usage` "so session totals remain accurate" (`extensions.md:136`).
- The subagent example does **not** return `usage`. It only shows usage in `details` (see section 7).

Streaming:
- `onUpdate({content, details})` emits partial results. They reach `renderResult` with `isPartial: true` and fire `tool_execution_update`.
- The subagent example calls `onUpdate` on every child `message_end` (`subagent/index.ts:324-331`).

Cancellation:
- `signal` is the turn's `AbortSignal`, which `Esc` aborts.
- The example kills the child on abort: SIGTERM, then SIGKILL after 5 s (`subagent/index.ts:410-420`).
- `ctx.signal` is undefined when the agent is idle, so commands and background work have no signal (`types.d.ts:239-240`; `extensions.md:125`). A background agent therefore needs its own `AbortController`.

Long-running tools block the turn until `execute` resolves. Background agents need a different pattern:
1. The tool starts the work, stores a handle, and returns at once.
2. Later the extension calls `pi.sendMessage({customType, content, display, details}, {triggerTurn: true, deliverAs: "followUp"})` to wake the model (`types.d.ts:1233-1237`).

Rendering:
- `ToolRenderContext` (`types.d.ts:347-379`) provides:
  - `args`, `toolCallId`
  - `invalidate()`
  - `lastComponent`, so the renderer can reuse the previous component
  - shared `state`
  - `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `isError`, `durationMs`, `outputPad`
- `pi.registerToolRenderer((toolName, next) => renderers)` overrides rendering for any tool, including built-in and MCP tools (`types.d.ts:509-513`; `extensions.md:188-190`).

Nested tool calls:
- `ctx.executeTool(name, args, {signal, onUpdate})` runs another tool through validation and hooks.
- Usage from nested calls is added to the caller's result `usage` (`extensions.md:148`; `types.d.ts:269-281`).

Dynamic tools:
- Tools can be registered after startup, for example in `session_start` or from a command (`examples/extensions/dynamic-tools.ts`).
- Tools cannot be unregistered. To withdraw one, re-register it with `exposure: "hidden"` (`extensions.md:160`).
- `pi.setActiveTools()` and `pi.getActiveTools()` control which tools the model sees.

Tool changes and the cache:
- Changes are appended as system-message deltas before the next request.
- Providers that cannot represent a delta get a full checkpoint, which "can invalidate the cached prefix" (`extensions.md:186`). This bears on the caching rule.

## 3. Reading the effective system prompt, tools and skills

| Source | What it gives | Can modify? | Sees other extensions? |
|---|---|---|---|
| `before_agent_start` `event.systemPromptOptions` (`types.d.ts:707-718`; `dist/core/system-prompt.d.ts:5-50`) | `customPrompt, selectedTools, hiddenTools, toolSnippets, toolGuidelines, promptGuidelines, appendSystemPrompt, sections, contextFiles, skills: Skill[], cwd` | Yes, by mutating it; or return `{systemPrompt}` to force the whole text | Yes: "Later handlers observe mutations made by earlier handlers"; `event.systemPrompt` is the text rendered so far |
| `ctx.getSystemPrompt()` (`types.d.ts:251-252`) | Current effective text | No | Yes |
| `ctx.getSystemPromptOptions()`, commands only (`types.d.ts:287-288`) | Base build options | No | n/a |
| `pi.getAllTools()` (`types.d.ts:1259-1260, 1553-1558`) | name, description, parameters schema, promptGuidelines, exposure, namespace, annotations, sourceInfo | No | Yes |
| Session system messages (`docs/message-types.md:94-107`; `docs/session-format.md:80-87`) | `sections` by name (`preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, plus custom sections) and `toolsAdded` with full schemas | n/a | Yes; this is what was recorded as sent |
| `context_with_system` | Full transcript including system messages for this request | Yes, request-local | Runs after every `context` handler |
| `before_provider_request` | Provider-specific payload actually sent | Yes | Last stage; most authoritative |

How the sections are built: `$PCA/dist/core/system-prompt.js:68-128`. Each non-preamble section is wrapped as `<name>…</name>`. The `skills` section exists only when `read` or `bash` is reachable.

For the agent view's "full effective system prompt" block:
1. Replay the child session's `role: "system"` messages, in order, to get sections and tools.
2. Optionally capture `before_provider_request` in the child as the ground truth.

The SDK equivalents are `session.systemPrompt` (read-only, "including changes not yet sent", `docs/sdk.md:30-32`) and `session.messages`.

## 4. UI API (`ctx.ui`, `types.d.ts:72-196`)

| Method | Purpose |
|---|---|
| `select(title, options, {signal?, timeout?})`, `confirm(title, msg, opts)`, `input(title, placeholder, opts)`, `editor(title, prefill)` | Blocking dialogs. They also work in RPC mode. |
| `notify(msg, "info"\|"warning"\|"error")` | Toast-like message |
| `setStatus(key, text\|undefined)` | Keyed text in the footer status area |
| `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator({frames, intervalMs})`, `setHiddenThinkingLabel` | Streaming loader row |
| `setWidget(key, string[] \| (tui, theme) => Component, {placement: "aboveEditor"\|"belowEditor"})` | Persistent component near the editor. A candidate home for the progress or agent-list strip. |
| `setFooter((tui, theme, footerData) => Component)` / `setFooter(undefined)` | Replace or restore the footer |
| `setHeader(factory)`, `setTitle(str)` | Header and terminal title |
| `custom<T>((tui, theme, keybindings, done) => Component, {overlay?, overlayOptions?, onHandle?})` | Custom interactive screen. Resolves when the component calls `done(result)`. |
| `setEditorComponent(factory)` / `getEditorComponent()`, `setEditorText`, `getEditorText`, `pasteToEditor`, `addAutocompleteProvider` | Editor control |
| `onTerminalInput(handler)` | Raw global input listener; can consume or rewrite input |
| `theme`, `getAllThemes()`, `getTheme()`, `setTheme()` | Themes |
| `getToolsExpanded()` / `setToolsExpanded(bool)` | The global expand toggle |

**Full-screen scrollable view:**
- Non-overlay `custom()` only replaces the editor area (`$PCA/dist/modes/interactive/interactive-mode.js:2324-2391`: `editorContainer.clear(); editorContainer.addChild(component)`).
- Overlay `custom()` calls `tui.showOverlay(component, overlayOptions)`. With `width: "100%"` and `maxHeight: "100%"` (or `margin`), it gives the only practical full-screen custom view.
- `OverlayOptions` fields (`$TUI/dist/tui.d.ts:134-161`): `width, minWidth, maxHeight, anchor, offsetX/Y, row, col, margin, visible(), nonCapturing`.
- `OverlayHandle` methods (`tui.d.ts:177-192`): `setHidden, focus, unfocus({target}), isFocused, getBounds`. Do not call `hide()` on `custom()` overlays (`docs/tui.md:74`).
- `tuiMode` defaults to `"fullscreen"` (`docs/settings.md:94`). In fullscreen mode:
  - `ScrollView` works (`$TUI/dist/components/scroll-view.d.ts`: `scrollBy`, `scrollTo`, `scrollToEnd`, `follow: "end"`, scrollbar).
  - The mouse wheel scrolls the nearest `ScrollView`.
  - `MouseRegion` adds click handling.
- In `regular` mode, ScrollView semantics "are intentionally unavailable" (`$TUI/README.md:119-160`). There we must window the lines ourselves, as the example does with its own `scrollOffset` (`examples/extensions/overlay-qa-tests.ts:464-580`). Design for both modes.

**Keyboard focus:**
- The component shown by `custom()` receives focus and gets raw key strings in `handleInput(data)`. Match keys with `matchesKey(data, Key.…)`, or with the injected `KeybindingsManager` for configurable actions (`docs/tui.md:44-54`).
- A focused overlay keeps input focus until `done()` or `handle.unfocus()`.
- Components that show a text cursor implement `Focusable` and emit `CURSOR_MARKER`. Containers that wrap an `Input` or `Editor` must pass `focused` down to it (`$TUI/README.md:306-358`).
- Overlays without `nonCapturing` take focus as soon as they are shown.

**Shortcuts:**
- Signature (`types.d.ts:1209-1212`):
  ```ts
  pi.registerShortcut(Key.ctrlShift("u"), { description, handler: (ctx) => ... })
  ```
  Examples: `preset.ts:352`, `plan-mode/index.ts:158`.
- Users rebind built-in actions in `~/.pi/agent/keybindings.json` (`docs/keybindings.md`). The docs do not say whether extension shortcuts can be rebound there; treat them as fixed keys.
- Avoid conflicts. `Ctrl+O` (expand), `Ctrl+T` (thinking), `Esc` (interrupt), `Ctrl+P`/`Ctrl+L` (model) and `Shift+Tab` are taken (`keybindings.md:119-166`).

**Reusable components:**
- From `@earendil-works/pi-tui` (`$TUI/dist/index.d.ts`):
  - content: `Text`, `TruncatedText`, `Markdown`, `Image`
  - layout: `Container`, `Box`, `VStack`, `HStack`, `Spacer`, `ScrollView`, `MouseRegion`
  - input: `Input`, `Editor`, `SelectList`, `SettingsList`
  - progress: `Loader` (spinner, `start`/`stop`/`setMessage`), `CancellableLoader`
  - utilities: `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `matchesKey`, `Key`, `fuzzyFilter`
- From `@earendil-works/pi-coding-agent` (`$PCA/dist/index.d.ts`, `modes/interactive/components/*.d.ts`):
  - `AssistantMessageComponent(message, hideThinking, mdTheme, …)` with `.updateContent(msg, isStreaming)`
  - `ToolExecutionComponent(toolName, toolCallId, args, opts, toolDefinition, tui, cwd)` with `.updateResult(...)` and `.setExpanded()`
  - `UserMessageComponent`, `CustomMessageComponent`, `BorderedLoader`, `DynamicBorder`
  - `SkillInvocationMessageComponent`, which has its own `setExpanded` and is the closest existing "collapsible"
  - `getMarkdownTheme()`, `getSelectListTheme()`, `keyHint()`
- With these, a child transcript can be drawn the way the main session draws its own.
- **No Collapsible component exists.** The README shows only a `MouseRegion` toggle snippet (`$TUI/README.md:297-301`).

**Theme:**
- Use the `theme` passed to callbacks: `theme.fg(token, s)`, `theme.bg`, `theme.style(s, {fg, bg, bold})`, `theme.colors`, `theme.appearance` (`docs/tui.md:78-104`).
- Tokens that fit "soft limit = orange": `warning`, `error`, `success`, `accent`, `muted`, `dim`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg` (`docs/themes.md:100-116`).
- `DynamicBorder` warns that the global `theme` may be undefined under jiti, so always pass explicit color functions.

## 5. Commands

Signature (`types.d.ts:1147-1153, 1207`):

```ts
pi.registerCommand("agents", {
  description?: string,
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<...>,  // {value, label}
  handler: async (args: string, ctx: ExtensionCommandContext) => {},
});
```

- `args` is the raw string after the command name.
- Completion example: `examples/extensions/commands.ts:18-22`.
- `ExtensionCommandContext` adds the following (`types.d.ts:286-323`). These are command-only because calling them from event handlers can deadlock (`extensions.md:214-215`):
  - `waitForIdle`
  - `newSession({parentSession, setup, withSession})`
  - `fork`, `navigateTree`, `switchSession`
  - `reload`
  - `getSystemPromptOptions`
- `pi.sendUserMessage(text, {expandPromptTemplates: true})` "dispatch[es] extension commands" (`types.d.ts:1238-1246`). It is a possible way for an event handler to trigger a command (for the hard-limit handoff). **Unverified.**
- `pi.getCommands()` lists all slash commands.

## 6. Messages and entries

| API | Persisted | Sent to model | Rendered |
|---|---|---|---|
| `pi.sendMessage({customType, content, display, details}, {triggerTurn?, deliverAs?: "steer"\|"followUp"\|"nextTurn"})` | yes (`custom_message` entry) | yes, as user-role content; `details` is not sent | if `display: true`; customize with `pi.registerMessageRenderer(customType, (msg, {expanded, outputPad}, theme) => Component)` |
| `pi.sendUserMessage(content, {deliverAs?})` | yes | yes; always starts a turn | as a user message |
| `pi.appendEntry(customType, data)` | yes (`custom` entry) | **no** | only with `pi.registerEntryRenderer(customType, (entry, {expanded}, theme) => Component)` |
| `turn_end` / `agent_before_settle` return `{entries: [...drafts], continue}` | yes; drafts are `custom`, `custom_message`, `context_edit` or `compaction` | depends on the type | as above |
| `before_agent_start` return `{message}` | yes | yes | custom message |
| `message_end` return `{message}` | replaces the message | yes | n/a |

References: `types.d.ts:729-754, 1131-1146, 1225-1248`; `docs/message-types.md:220-235`; `dist/core/session-manager.d.ts:71-120`; examples `message-renderer.ts`, `entry-renderer.ts`.

State guidance:
- Tool state that should follow the active branch goes in tool-result `details`.
- Durable data the model must not see goes in `appendEntry`.
- Rebuild state from `ctx.sessionManager.getBranch()` in `session_start` (`extensions.md:222-235`).
- `ctx.sessionManager` is read-only (`session-manager.d.ts:178`).

## 7. Status and footer, and how cost is computed

- **Simple:** `ctx.ui.setStatus("subagents-cost", theme.fg("dim", "$0.123"))` adds a keyed entry to the built-in footer status area. Example: `examples/extensions/status-line.ts`.
- **Full control:** `ctx.ui.setFooter((tui, theme, footerData) => ({render(width), invalidate(), dispose}))`. `footerData` provides `getGitBranch()`, `getExtensionStatuses()`, `getAvailableProviderCount()` and `onBranchChange()` (`dist/core/footer-data-provider.d.ts:63`). Example: `examples/extensions/custom-footer.ts`.
- **How the built-in footer computes cost** (`$PCA/dist/modes/interactive/components/footer.js:81-169`):
  - Scans `sessionManager.getEntries()` (all branches) and sums `usage` from:
    - `type: "usage"` entries
    - assistant messages
    - `toolResult` messages carrying `usage`
    - `branch_summary` and `compaction` entries with `usage`
  - Displays `↑input ↓output Rcache Wcache CH% $cost (sub) ctx%/window model`.
  - `$cost` is the sum of `usage.cost.total`.
  - Context-window percent turns `warning` above 70% and `error` above 90%.
  - `/session` and RPC `get_session_stats` use the same accounting (`docs/rpc-commands.md:526-566`).
- **Implications for the spending footer:**
  - A foreground (blocking) agent tool that returns `usage: <sum of child usage>` is counted automatically everywhere: footer, `/session`, and exports.
  - Background agents finish after their tool call has returned. Extensions cannot append `usage` entries; `appendUsage` is not on the read-only manager and is written only by the cache warmer.
  - Options for background agents:
    - **(a)** Replace the footer with our own: replicate the built-in computation and add child totals persisted through `appendEntry`.
    - **(b)** Deliver results through a tool call whose result carries the accumulated `usage`, for example a "collect results" or `agent_status` tool.
    - **(c)** Accept that `/session` under-reports.
  - Recursion: each level reports its own usage plus its children's, as pi does for nested tool calls.
  - Cost is computed by pi-ai from the model's `cost` table. Subscription providers show `(sub)`, and their dollar figure is notional.
  - Child processes in json mode emit `message_end` with `usage` on each assistant message, which is what the subagent example sums (`subagent/index.ts:362-381`).

## 8. Event bus and inter-extension state

- `pi.events: EventBus` with `emit(channel, data)` and `on(channel, handler) => unsubscribe` (`dist/core/event-bus.d.ts:1-8`; example `examples/extensions/event-bus.ts`).
- The bus is shared by all extensions in one runtime. Subscriptions are released when the runtime is invalidated, for example on reload (`types.d.ts:1596-1597`).
- It does **not** cross process boundaries. Child pi processes have their own bus, so parent and child need an IPC channel (json or rpc stdout, or files).
- Other ways to share state:
  - session entries (`appendEntry`, readable by every extension through `sessionManager`)
  - `pi.getAllTools()` / `pi.getCommands()`
  - each event's ordered mutation chain
- "Installed packages load with separate module roots", so do not rely on shared module singletons across packages (`docs/packages.md:92`).

## 9. Packaging, install, reload, settings

- Package layout: either conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`) or an explicit manifest (`docs/packages.md:42-72`):
  ```json
  { "name": "...", "keywords": ["pi-package"],
    "pi": { "extensions": ["./src/extension.ts"], "skills": ["./skills"], "prompts": ["./prompts/*.md"], "themes": [] } }
  ```
- Install:
  - `pi install npm:@scope/pkg@1.0.0`, `git:github.com/...@v1`, or `./local-path`
  - `pi list`, `pi remove`, `pi update --extensions`
  - `-l` writes to project `.pi/settings.json`
  - `pi -e npm:...` loads for one run only
  - `pi config` enables or disables resources
- Dependencies:
  - Pi provides `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and `typebox`. Declare them as `peerDependencies: "*"` and **never** in `dependencies` (`packages.md:76-92`).
  - Local-path packages are not `npm install`ed by pi.
- Settings may filter a package's resources: `{"source": ..., "extensions": ["!x.ts"], "skills": []}` (`packages.md:94-119`).
- Hot reload:
  - `/reload` reloads keybindings, extensions, skills, prompts, themes and context files (`docs/slash-commands.md:49`).
  - It fires `session_shutdown {reason: "reload"}` and then `session_start {reason: "reload"}`.
  - Any running background agents must be stopped or re-attached at that point.
- Per-extension settings: **none.** Use our own JSON (the `preset.ts` pattern: `join(getAgentDir(), "presets.json")` and `join(cwd, CONFIG_DIR_NAME, "presets.json")`, `examples/extensions/preset.ts:71-90`) or `pi.registerFlag()` and `pi.getFlag()` for CLI flags.

## 10. Running agents inside extensions

There is no prose section on subagents. There are three working mechanisms.

1. **Subprocess, JSON mode.** This is the official example (`$PCA/examples/extensions/subagent/`).
   - Command: `pi --mode json -p --no-session [--model m] [--thinking t] [--tools a,b] [--append-system-prompt file] "Task: …"`.
   - The child runs as `process.execPath` with `process.argv[1]` (`index.ts:249-263`).
   - Stdout carries JSONL events; the example parses `message_end` and `tool_result_end`.
   - Abort kills the process.
   - Supports single, parallel (8 tasks, at most 4 at once) and chain modes.
   - Agents are `.md` files with frontmatter (`name`, `description`, `tools`, `model`). The body is appended to the system prompt. Files are read from `~/.pi/agent/agents` and, opt-in, `.pi/agents` (`agents.ts`).
   - Limitations:
     - one-shot: no follow-up questions
     - the child is blocking (the tool waits)
     - usage is not returned in the result's `usage` field
2. **Subprocess, RPC mode.** Command: `pi --mode rpc [--session <file>]`.
   - Long-lived. Commands include `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `get_entries`, `get_session_stats` and `export_html`. Events stream on stdout. `RpcClient` is exported (`docs/cli-integration.md:66-90`; `docs/rpc-commands.md`).
   - This matches "stop / continue / ask a question" and gives a persistent session file for the agent view.
   - Extension dialogs in the child are forwarded as `extension_ui_request` (`docs/rpc-extension-ui.md`).
3. **In-process SDK.** `createAgentSession({cwd, model, tools, sessionManager, resourceLoader, ...})`.
   - Then `session.subscribe`, `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`, `getSessionStats`, `systemPrompt`, `messages`, `dispose` (`docs/sdk.md`; `dist/core/agent-session.d.ts:379-904`; `sdk.d.ts:10-50`).
   - The child can load our extension through `DefaultResourceLoader`, which supports nesting.
   - Running a session inside another session's extension is **not documented**.

Settled-run detection: `agent_settled`, not `agent_end`, marks the point where nothing more will run automatically (`docs/json.md:31-60`).

Related examples:
- `handoff.ts`: generates a handoff prompt and calls `ctx.newSession({parentSession, withSession})`.
- `trigger-compact.ts`: uses context thresholds.
- `ctx.getContextUsage()` returns `{tokens, contextWindow, percent}` for soft and hard limits (`types.d.ts:197-203`).

---

## Risks / unknowns

1. **API churn.** 1.0.0 shipped on 2026-10-01 and 1.1.0 on 2026-10-07. The changelog has 48 Breaking Changes sections. The prose docs are thin and defer to `types.ts`, so treat `types.d.ts` as the contract and pin the pi version.
2. **`forceSystemPrompt` record.** The docs say the transcript "continues recording the structured sections" when an extension forces `systemPrompt` (`extensions.md:103`). But `buildSystemPromptState` stores the forced text as `content` with no sections (`system-prompt.js:134-138`). `context_with_system` and `before_provider_request` can also change what is sent without persisting it. For a debug-grade record, capture `before_provider_request` in the child as well as replaying the system messages.
3. **No collapsible or tree widget.** We must write one, along with list or selection inside a scrollable overlay. `SelectList` exists but is not hierarchical.
4. **Regular vs fullscreen `tuiMode`.** `ScrollView` and mouse input work only in fullscreen. Regular mode needs manual line windowing. A user setting decides which mode is active.
5. **Overlay-as-screen.** There is no API to swap the main transcript for a different view. An overlay covering the screen is the only option. Behaviour while the main agent streams underneath, and how focus returns to the editor, need prototyping (`overlay-qa-tests.ts` is the reference).
6. **Background spending accounting.** No public way to add a `usage` entry. A custom footer, or a delivery tool that returns `usage`, is needed (section 7). `/session` and HTML export totals may then disagree with our footer.
7. **Session control from event handlers.** `newSession`, `switchSession` and `reload` are command-only, with a deadlock warning. Auto-handoff at the hard limit has to go through a command, possibly by dispatching it with `sendUserMessage(..., {expandPromptTemplates: true})`, which is unverified.
8. **Context invalidation.** Contexts captured in a tool's `ctx` go stale after reload or session replacement (`assertActive` throws). Long-lived background agents must not keep using an old `ctx`. Re-acquire it in `session_start`.
9. **`ctx.signal` is undefined outside an active turn.** Background agents need their own `AbortController` and must be cleaned up in `session_shutdown`.
10. **In-process SDK sessions inside an extension are undocumented.** Unknowns: global theme under jiti (the `DynamicBorder` note), separate module roots, shared `auth.json` and model runtime, and event-bus isolation. The subprocess route is the documented one.
11. **Prompt cache.** Mutating `systemPromptOptions` or the active tools mid-run appends deltas. Some providers then receive a full checkpoint that "can invalidate the cached prefix" (`extensions.md:186`). Child agents should fix their prompt and tools before the first request and never change them. `cache_warming_decision` may also matter for idle children.
12. **`deliverAs` semantics** (`"steer" | "followUp" | "nextTurn"`) and `triggerTurn` while idle are only typed, not described. Verify how a parallel batch "wakes the caller once".
13. **Experimental surface.** `package.json` exports `./experimental/plugin` (source only, excluded from `dist`). It is undocumented; do not use it.
14. **Shortcut configurability.** Whether extension shortcuts can be rebound in `keybindings.json` is undocumented. `KeybindingsManager` is injected into `custom()` and could expose our own actions; verify.
