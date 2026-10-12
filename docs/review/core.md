# Review: core (adapter, manager, core tests, architecture test)

Scope: core/adapter/*.ts (15 files), core/manager/*.ts (6 files), core/test/** (16 files incl. helpers/fakes.ts, adapter/live.ts), test/architecture.test.ts; plus contract consumers under extensions/*/src.

### High

- **A failed wake or follow-up after an agent's first turn is swallowed; the agent hangs and keeps its slot** `core/adapter/pi-child.ts:253-258`, `:378-396`. `settled` becomes true on the first `settled` event and is never reset. `deliver` does not await `session.prompt` when the session is idle (`:394-396`). It attaches `.catch(failStart)`, and `failStart` returns early once `settled` is true (`:379-381`). pi's `prompt()` throws before any turn starts on auth failure or an "already processing" race (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` ~1553, ~1576). When that happens no `settled` event is ever sent. The runner expects `deliver` to reject on failure (`extensions/subagents/src/plugins/run-agent/runner.ts:258-261`), but here `wake`/`send` resolve immediately. Result: the record stays `running` with `inFlight` and a semaphore slot held, and the caller's batch never settles. Fix: reset `settled = false` before each `session.prompt(...)` call in `start`/`deliver`, so each prompt has its own settle guard.

- **The project-level `disabledPlugins` is accepted but has no effect** `extensions/subagents/src/index.ts:18-19,35-41` vs `:21-25`. The manager is created at boot with `disabled: settings.disabledPlugins` taken from user settings only. The project patch is applied later, at `session_start`, after every plugin is already enabled. The README advertises `.pi/pi-subagents.json` with `disabledPlugins` (`extensions/subagents/README.md:108-120`), and the schema validates the key silently (`extensions/subagents/src/model/settings.ts:60`). ARCHITECTURE.md mentions this limit; the README does not. Fix: either say "user settings only" in the README and warn when a project file sets it, or read the project file at boot (cwd and trust are not known in `boot` today).

### Medium

- **One throwing shutdown handler skips every later handler and leaves the Host live** `core/adapter/pi-adapter.ts:92-99`. Handlers run in a `reduce` promise chain with no try/catch, so a rejection skips the rest and `state.stale = true` is never reached. In subagents, `disableAll` is registered last (`extensions/subagents/src/index.ts:46`), after run-agent's `runner.shutdown` handler (`run-agent/index.ts:129`). If shutdown throws, the plugin disables never run, so `setInterval` tickers keep running and keep a reference to the dead instance (`agent-list-view/index.ts:31-44`, progress-widget `stopTicker`). Fix: wrap each handler in try/catch and set `stale` in a `finally`.

- **A child's tool-execution usage is counted nowhere** `core/adapter/usage.ts:51-53,64-68`. `sumSessionUsage` includes `toolResult.usage` for the main session, but `sumOwnUsage` (`ChildSession.ownUsage`, `pi-child.ts:440`) leaves it out. pi copies a tool's own `usage` into the toolResult message (`pi-agent-core/dist/agent-loop.js:657-668`), for example from codemode or non-LLM model tools. So when a child runs such a tool, its cost is missing from the spending "agents" figure. The lead about double counting is **refuted**: this package's tools never set `usage` (`core/adapter/pi-tools.ts:6-10`), so `run_agent`/`message_agent` results add nothing to the main total, and nested agents are separate sessions, not tool results. Fix: include toolResult usage in `sumOwnUsage` (then the two functions collapse into one).

- **The contract is larger than what extensions use** `core/adapter/contract.ts`. These members are not used by any `extensions/*/src` file, only by fakes or tests:
  - `Host.contextUsage` (`:192`, implemented at `pi-adapter.ts:182-186`, tested at `core/test/adapter/pi-adapter.test.ts:82-91`).
  - `Host.setPromptSection` (`:185`, plus the `sections` map and loop at `pi-adapter.ts:70,108-110`, and the `prompt-section` contribution at `extension-manager.ts:63-66`).
  - `ChildEvent` `turn_start`, `tool_end` and `compaction_blocked` (`:206,216,217`). They are emitted at `pi-child.ts:339-341,368-370,91`, but the runner only handles `turn_end`, `assistant_message`, `tool_start` and `settled` (`runner.ts:490-528`). `compaction_blocked` is asserted only in `conformance.test.ts:153`.
  - `ChildSession.modelLabel`, `contextWindow` and `context()` (`:227-228,234`).
  - `SessionInfo.dir` and `hasUI` (`:158,162`). `hasUI` is also defined differently from pi's `ctx.hasUI`, which HostUi uses (`pi-adapter.ts:37` vs `pi-ui.ts:430`).
  - `ToolSpec.promptGuidelines` (`:49`) and `ToolRenderState.isPartial` (`:40`).

  Fix: delete these members, their implementations and their fake counterparts. The child extension still needs to cancel compaction; it just does not need to emit an event.

- **`manager.report()` and the contribution recording exist only for tests** `core/manager/extension-manager.ts:5-15,52-71,111,167-171`. `report()` is called only from `core/test/manager/extension-manager.test.ts` and `extensions/subagents/test/plugins.test.ts:8,37`. No command or notification shows it, so users never learn that a plugin was skipped (for example, a plugin whose `requires` target is listed in `disabledPlugins` is dropped silently). ARCHITECTURE.md presents `report()` as a feature. Fix: either notify the skipped plugins with their reasons at boot and drop `contributions` and `recordingHost`, or remove `report` entirely and keep `skipped` as a notification.

- **A partially failed spawn leaks the child session** `core/adapter/pi-child.ts:306-336`. After `loader.reload()` has loaded the child extensions (including pi's MCP extension, `:300`), an exception in `createAgentSession` or `bindExtensions` propagates without `session.dispose()` or a `session_shutdown` emit. The runner closes the record but holds no handle to clean up (`runner.ts:676-679`). Fix: try/catch around `createAgentSession` and `bindExtensions`, and on failure call the same `dispose` steps before rethrowing. Unverified: whether pi's MCP extension opens connections at load or only on first use, which decides how much actually leaks.

### Low

- **Duplicate context snapshot code** `core/adapter/pi-adapter.ts:44-49` and `core/adapter/pi-child.ts:65-70` are the same function over `getContextUsage()`. Fix: one helper in `pi-tokens.ts` or `usage.ts`.
- **Unexplained provider literal** `core/adapter/pi-adapter.ts:39` treats `kimi-coding` as a subscription by name. Fix: move it to a named constant with the reason, or confirm pi exposes this.
- **`dispatchCommand` no-ops silently without a live context** `core/adapter/pi-adapter.ts:201-207`. The only caller sets `phase: "switching"` before dispatching (`extensions/session-limits/src/limits.ts:144-147`), so a dropped dispatch would leave session-limits stuck in `switching`. In practice the caller runs inside turn_end/idle handlers that have just captured a context, so this is unlikely. Fix: return a boolean and have the caller revert the phase. Discarded `subscribe` unsubscribe handles (`pi-adapter.ts:215`, callers `limits.ts:297` and `spending.ts:31`) do **not** leak, because pi tracks every event-bus subscription and clears them when the extension context is invalidated (`pi-coding-agent/dist/core/extensions/loader.js:147-149,424`).
- **Extension tests import adapter internals, which load pi** `extensions/subagents/test/plugins/agent-view/agent-view.test.ts:10,15`, `agent-list-view/agent-list-view.test.ts:4`, `run-agent/message-agent.test.ts:2-3`. ARCHITECTURE.md says tests replace pi with fakes, and `test/architecture.test.ts:91-98` forbids pi imports outside `core/test/adapter`. But that rule checks only direct `@earendil-works/*` specifiers, and rule 3 (`:100-109`) does not scan tests at all. `initRenderTheme` (`pi-ui.ts:117-119`) exists in shipped code only for these tests. Fix: either extend rule 3 to tests (allowing `core/test`), or document the exception.
- **`main-prompt.ts` copies a private pi builder** `core/adapter/main-prompt.ts:10-74`. This includes the full docs text. The restore is needed: pi drops `tools`, `rules` and `docs` when `customPrompt` is set, which `core/test/adapter/main-prompt.test.ts:51-66` demonstrates. Drift is caught by the test, which compares against pi's own `dist/core/system-prompt.js` (`:9-14,35-49`). `RESTORED_SECTIONS` (`:8`) is used only by that test. Fix: move the constant into the test. The rest is justified.
- **`live.ts` has import-time side effects** `core/test/adapter/live.ts:27-35,52`. Importing it creates a temp dir, mutates `process.env.PI_CODING_AGENT_DIR` and runs a top-level `await ModelRuntime.create()`. It is imported only by `*.live.test.ts` and `extensions/subagents/test/helpers/live.ts`, so it is safe today; any unit test that imports it would get a different agent dir. `liveAgentDir` is exported but never imported elsewhere.

### Leads refuted

- **`disableAll()` on new/resume leaving plugins off: refuted.** On every session replacement, pi tears down the runtime and builds a new one: `teardownCurrent` then `createRuntime` (`pi-coding-agent/dist/core/agent-session-runtime.js:102-113,128-140`). `createRuntime` calls `createAgentSessionServices`, which reloads the resource loader (`agent-session-services.js:63-69`), and extensions are re-imported with `moduleCache: false` (`core/extensions/loader.js:477-481`). Each session therefore gets a fresh factory call, Host and manager. The old Host is marked stale (`pi-adapter.ts:98`) and its pi context is invalidated by pi.
- **`usesOsc777` dead: refuted.** `notificationSequence` uses it (`pi-ui.ts:309`), and `terminalNotify` calls `notificationSequence` (`:462`). Only the `export` keyword is unnecessary.
- **`toPiResult`, `fromPiResult` and `normalizeUsage` are live** inside their own files (`pi-tools.ts:45,61`, `usage.ts:62,68`); only their exports are unnecessary.
- **Settings rule types** are not over-abstracted: all three kinds are used by the subagents schema. They only need to be exported if a consumer annotates with them, and none does.

### Dead code and unnecessary exports

| Symbol | File | Status | Note |
|---|---|---|---|
| `Host.contextUsage`, `Host.setPromptSection` | contract.ts:185,192 | dead | see Medium; plus `sections` in pi-adapter.ts:70,108-110 |
| `ChildEvent` turn_start / tool_end / compaction_blocked | contract.ts:206,216,217 | dead | emitted, never consumed |
| `ChildSession.modelLabel/contextWindow/context` | contract.ts:227-228,234 | dead | fakes only |
| `SessionInfo.dir/hasUI` | contract.ts:158,162 | dead | |
| `ToolSpec.promptGuidelines`, `ToolRenderState.isPartial` | contract.ts:49,40 | dead | |
| `ExtensionManager.report`, `Contribution`, `ManagerReport`, `recordingHost` | extension-manager.ts | test-only | see Medium |
| `matchModel`, `normalise` | model-resolver.ts:152,38 | export unnecessary | used in-file |
| `editDistance`, `compareVersions`, `tokensOf` | model-resolver.ts:46,93,40 | test seam | reasonable to keep exported for unit tests |
| `toPiResult`, `fromPiResult` | pi-tools.ts:6,12 | export unnecessary | |
| `normalizeUsage` | usage.ts:11 | export unnecessary | |
| `usesOsc777`, `TerminalEnv`, `TerminalOut` | pi-ui.ts:302,298,289 | export unnecessary | `TerminalOut`/env params of `createUi` are test seams (pi-ui.test.ts:75) |
| `initRenderTheme` | pi-ui.ts:117 | test-only in shipped code | used only by subagents tests |
| `RESTORED_SECTIONS`, `restoredSections` | main-prompt.ts:8,66 | test-only | `restoredSections` is also used in-file |
| `NumberRule`, `ListRule`, `BooleanRule`, `SettingsRule` | settings.ts:4-10 | export unnecessary | |
| `CompletionItem`, `CostBreakdown`, `JsonSchema`, `KeyName`, `ScrollState`, `ToolCallContext`, `ToolRenderState`, `ModelRequest`, `THINKING_LEVELS` | contract.ts | export unnecessary | used only inside contract.ts |
| `Boot`, `BootPaths`, `PiExtensionOptions`, `ChildOptions`, `ParentTool`, `PiModel`, `PromptRecordData` | adapter | export unnecessary | used in-file |
| `liveAgentDir` | core/test/adapter/live.ts:29 | export unnecessary | |
| `createPiHost`, `mcpBuiltinLoaded`, `childSettings`, `childToolNames`, `childUiContext`, `createChildExtension`, `pickSkillFiles`, `parseSessionLines`, `orderPlugins` | adapter/manager | test seam | justified; each has meaningful conformance or unit tests |

### Simplification opportunities

- Collapse `sumSessionUsage`/`sumOwnUsage` into one function once toolResult usage is included for children (`usage.ts:58-68`).
- After removing the dead contract members, `FakeHost`/`FakeChild` (`core/test/helpers/fakes.ts:172-174,191,374-375,413`) shrink accordingly.
- `applySettings` (`settings.ts:92-96`) is `Object.assign` that returns its target; inline it.
- `recordingHost` with `{ ...host, ui: host.ui }` (`extension-manager.ts:52-54`) has a redundant `ui` line; it disappears if `report` goes.
- Interfaces kept for fakes (`Host`, `AgentRuntime`, `ChildSession`, `HostUi`) are justified: they are the seam that lets around 400 tests run without pi. `ParentSource` (`pi-child.ts:51-58`) is justified by `pi-child.test.ts` and `live.ts`.

### Open questions

- Does `createTranscriptPane.sync` (`pi-ui.ts:207-214`) need to handle a same-length but different item list, for example when the agent view switches to another agent's file with the same entry count? It resets only when the list shrinks. Confirm by checking whether agent-view reuses one pane across agents.
- Does pi's MCP extension open server connections during `loader.reload()` in a child? That decides how much a partially failed spawn leaks (`pi-child.ts:306`).
- Is `ChildSession.dispose` ever called twice (stop during grace, then shutdown)? If so, `session_shutdown` would be emitted twice to child extensions (`pi-child.ts:407-416`); there is no guard.
