# Open questions: answers from pi 1.1.0 source

All of these were answered by reading pi's dist in `node_modules/@earendil-works/` and the repo code as it stands now. Nothing was run live. Paths starting with `pca/` mean `node_modules/@earendil-works/pi-coding-agent/dist/` and paths starting with `pac/` mean `node_modules/@earendil-works/pi-agent-core/dist/`. Repo line numbers are approximate because other agents are editing files at the same time. "Is the package meant for npm" is skipped because the owner decides that.

---

## 1. Session lifecycle (the main question)

### 1a. Does pi fire `session_start` again on the same extension instance?
**Answer:** no, except in RPC mode, where `new_session`, `switch_session` and `fork` fire it twice on the new instance.

**Evidence:**
- `pca/core/agent-session-runtime.js:160-166`: every `/new`, `/resume`, `/fork` and import tears down the session and calls `createRuntime`, which builds a new `DefaultResourceLoader` (`pca/core/agent-session-services.js:63-69`). The loader reruns every extension factory (`pca/core/extensions/loader.js:510-514`).
  ```
  await this.teardownCurrent("new", sessionManager.getSessionFile());
  this.apply(await this.createRuntime({ ... sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile } }));
  ```
- `session_start` is emitted only from `bindExtensions` (`pca/core/agent-session.js:2618`) and from `reload()` (`:2966`). `reload()` emits it on freshly loaded instances: the old runner is invalidated at `:2940`, then `_resourceLoader.reload()` and `_buildRuntime` run.
- RPC mode: `runtimeHost.newSession()` already rebinds through `setRebindSession` (`pca/modes/rpc/rpc-mode.js:225-227`, via `finishSessionReplacement`, `agent-session-runtime.js:121-123`). The RPC command handler then calls `rebindSession()` a second time (`rpc-mode.js:336-338`, `:475-477`, `:482-484`, `:493-495`). Each call runs `bindExtensions`, which emits `session_start` again on the same runner.
- Interactive and print modes bind once per session (`pca/modes/interactive/interactive-mode.js:369-371`, `:787`; `pca/modes/print-mode.js:48-50`, `:103`).
- Module caching: across `/new` and `/resume` in the same cwd, the cached factory is reused (`loader.js:461-466`; the cache is cleared only on `reload` or a cwd change, `resource-loader.js:353-356`, `loader.js:94-98`). Module-level state therefore survives a session switch. The repo has no mutable module-level state; the only module-level values are three read-only `Set` constants.

**Consequence for this repo:** the `onSessionStart` handlers act as one-time initialisers, not resets. Most of the reset logic is dead but harmless, and it stays useful as idempotency for the RPC double bind.
- Keep: `agent-registry` publishing busy at start, `run-agent` re-registering the tool with its description, `agent-definitions` reload, subagents settings read, `spending` restore. These need a live ctx, which does not exist during the factory call.
- Dead outside RPC, optional to remove: `progress-widget/index.ts:81-84` (`shown = false`), `usage-report/index.ts:12-14` (new token), `notifications/index.ts:49-51` (`quiet = false`), `session-limits/src/limits.ts:381-386` (state reset), and the usage-report test that exercises the reset.
- If they are kept, make sure each one stays idempotent for RPC. They all are today; `spending` already calls `ledger.clear()` before `restore()`.
- No widget-interval restart can happen after dispose: a disposed runner never emits again, and `manager.disableAll()` runs on shutdown (`extensions/subagents/src/index.ts:46-48`).

### 1b. Does `pi.events` outlive extension instances (across `/new`, `/resume`, the session-limits handoff switch, `/reload`)?
**Answer:** no. The old instances' subscriptions are removed automatically.

**Evidence:**
- On `/new`, `/resume` and `/fork` the new loader creates a new bus: `pca/core/resource-loader.js:244` runs `this.eventBus = options.eventBus ?? createEventBus();`, and main passes no `eventBus` (`pca/main.js:599-640`).
- On `/reload` the bus is shared, but `pi.events.on` tracks every subscription (`loader.js:422-426`), and `runtime.invalidate()` unsubscribes them all (`loader.js:140-150`):
  ```
  for (const unsubscribe of eventBusUnsubscribers)
      unsubscribe();
  eventBusUnsubscribers.clear();
  ```
  `invalidate()` runs from `AgentSession.dispose()` (`agent-session.js:1003`) and from `reload()` (`:2940`).
- The session-limits handoff goes through `ctx.newSession` (`core/adapter/pi-adapter.ts` `sessionControl`), which takes the same `runtimeHost.newSession` teardown and createRuntime path.
- A stale `ctx` throws instead of no-opping: every getter in `runner.createContext()` calls `runner.assertActive()` (`pca/core/extensions/runner.js:613-690`).

**Consequence for this repo:**
- No unsubscribe calls are needed for `host.subscribe` in `spending.ts:31` or `session-limits/src/limits.ts:329`. pi drops those subscriptions.
- One small hardening is recommended. In `core/adapter/pi-adapter.ts` (`session_shutdown` handler, around line 92), set `state.stale = true` in a `finally` block. Today, if a shutdown handler rejects, `stale` is never set. A timer that fires later then calls `liveCtx(state).ui`, which throws pi's stale-ctx error instead of no-opping.

### 1c. Does pi clear widgets from the previous runtime on a session switch?
**Answer:** yes, in interactive mode.

**Evidence:**
- `pca/modes/interactive/interactive-mode.js:366-368` registers `setBeforeSessionInvalidate(() => this.resetExtensionUI())`. `resetExtensionUI` (`:1898-1927`) calls `clearExtensionWidgets()` and `footerDataProvider.clearExtensionStatuses()`.
- The hook runs after `session_shutdown` and before dispose (`agent-session-runtime.js:106-112`).
- `/reload` also calls `resetExtensionUI()` first (`interactive-mode.js:5366`).

**Consequence for this repo:** no change needed. `progress-widget/index.ts:82` does not need `setWidget(KEY, undefined)`.

### 1d. Does pi rebuild extensions per session, so the settings refutation holds ("Extension reload per session")?
**Answer:** yes.

**Evidence:** see 1a. `createAgentSessionServices` creates `new DefaultResourceLoader(...)` and runs `await resourceLoader.reload(...)` (`agent-session-services.js:63-69`), which reruns every factory.

**Consequence for this repo:** no change needed. Because boot runs once per session, the project `disabledPlugins` could also be read at boot from the session cwd if the owner wants that.

---

## 2. Abort and send semantics (the second main question)

### 2a. Does `session.abort()` wait for a pending tool promise?
**Answer:** yes, `abort()` waits until the tool's `execute` promise settles. A `run_agent` call with `wait: true` that is pending during subagent shutdown never settles, so each affected `abortChild` waits out the full 5 s `ABORT_WAIT_MS`.

**Evidence:**
- `pca/core/agent-session.js:1909-1919` (abort only signals, then waits for idle):
  ```
  this.agent.abort();
  await this.waitForIdle();
  ```
- `pac/agent-loop.js:574`: `const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, ...)`. There is no race against the signal, so the tool has to honour it itself.
- The repo's tool honours the signal: `extensions/subagents/src/plugins/run-agent/tools.ts:190-198` stops the batch's agents on abort. Then it `await started.settled`.
- During shutdown the batch never resolves. `runner.ts` `checkBatch` (around lines 192-197) bails out when `shuttingDown` is set:
  ```
  if (!batch || batch.woken || shuttingDown) {
    return;
  }
  ```
  `shutdown()` (around lines 933-960) sets `shuttingDown = true` and closes every record before it aborts the children. So a child blocked in a `wait: true` `run_agent` call never returns, and `abortChild` waits out `ABORT_WAIT_MS` (5 s). The aborts run in parallel through `Promise.all`, so the total stall is about 5 s, not 5 s per tree. The child is then disposed with its tool promise still pending.
- Main session: on `/new`, `/resume` and `/fork`, pi calls `session.abort()` before `session_shutdown` (`agent-session-runtime.js:105-110`). A main-session `run_agent wait:true` is not affected, because `shuttingDown` is still false at that point and `stop` resolves the batch.

**Consequence for this repo:** in `runner.ts`, let shutdown resolve pending waiting batches. In `shutdown()`, after the records are closed, resolve every unresolved batch where `batch.wait` is set (`batch.woken = true; batch.resolve(terminals)`), and skip only the wake/outbox part. Alternatively, `checkBatch` can skip only the non-wait wake path when `shuttingDown`. Either way the nested tool returns and `abort()` finishes without the 5 s timeout. A live shutdown test with a nested `wait: true` would confirm it.

### 2b. Can `ChildSession.send` (`steer`/`followUp`) reject, including on a disposed session?
**Answer:** no in practice, because the only throw path is text that starts with `/<extension command>`.

**Evidence:**
- `pca/core/agent-session.js:1690-1705`: `_queueUserInput` throws only through `_throwIfExtensionCommand` when the text starts with `/`. Input-handler errors are caught and reported in `runner.js:1224-1231`.
- `_queueSteer` and `_queueFollowUp` (`:1733-1757`) only push to arrays and call `agent.steer`/`followUp`, which just enqueue (`pac/agent.js:184-190`). There is no disposed check, so on a disposed session the message is silently dropped.
- The repo always prefixes the text, so it never starts with `/`: `core/adapter/route.ts:3-4` builds `` `[message from ${message.sender}]\n${message.text}` ``.
- `resume()` already catches `deliver` errors (`runner.ts` around lines 258-261).

**Consequence for this repo:** the `void send(...)` calls in `limits/index.ts:45,53` and `void resume(...)` do not need extra catches. Optional hardening: add a `disposed` flag in `core/adapter/pi-child.ts` that `dispose` sets and that `deliver` checks (return early). Today `deliver` on a disposed, idle child would call `session.prompt()`, which still starts a model request on the disposed session, because `prompt` has no disposed guard. The runner's `releaseLive` clears `live.child` first, so this is defensive only.

### 2c. Can `prompt()` throw on a busy session (the held-message double-prompt High finding)?
**Answer:** yes, and pi sets the busy flag late. The current repo code already avoids it, with one small window left.

**Evidence:**
- `pca/core/agent-session.js:1551-1553` throws `"Agent is already processing..."` when `isStreaming` is true and no `streamingBehavior` is given.
- `isStreaming` is `_isAgentRunActive` (`:1049-1051`), and that flag is set only in `_runAgentPrompt` (`:1388`). That happens after several awaits in `prompt()`: input handlers, the auth check, `_checkCompaction`, `emitBeforeAgentStart` and image normalisation (`:1535-1615`). The race described in the review was real.
- `prompt()` also throws for compaction in progress (`:1533`), no model (`:1572`) and missing auth (`:1576-1583`). The `Agent` itself throws if a run is active (`pac/agent.js:244`).
- The current `core/adapter/pi-child.ts:381-399` sets `running = true` synchronously in `prompt()`, and `deliver` checks `!running && !session.isStreaming`. A held message right after `start` therefore goes to `steer`. That enqueues into the agent queue, and `runLoop` drains it at the start of the run (`pac/agent-loop.js:85`):
  ```
  // Check for steering messages at start (user may have typed while waiting)
  let pendingMessages = (await config.getSteeringMessages?.()) || [];
  ```
- Remaining window: `running` is cleared only when pi-child receives `agent_settled`. pi emits that after the extension `agent_settled` handlers finish (`agent-session.js:684-692`), and after its last `hasQueuedMessages()` check (`:1450`, `:1454`, `:1464`). A `steer` or `followUp` that lands in that gap stays in the agent queue and is not delivered until the next prompt. If the agent then closes, the message is lost.

**Consequence for this repo:** the High finding is resolved by the `running` flag, provided that edit stays. For the remaining window, in the `agent_settled` branch of `pi-child.ts` (around line 363), check for queued messages before emitting `settled`. If `session.agent.hasQueuedMessages()` is true (or `session.pendingMessageCount > 0`), call `session.agent.continue()`, or re-prompt, instead of reporting settled.

---

## 3. Remaining questions

### Does pi's MCP extension open connections during `loader.reload()` in a child?
**Answer:** no. It connects in its `session_start` handler, which runs inside `bindExtensions`.

**Evidence:**
- `pca/extensions/mcp/index.js:190-203`: the factory only declares state.
- `:968-995` is `pi.on("session_start", ...)`, which then runs `startConnection(...)` after `setImmediate`. `:1111-1116` closes the connections on `session_shutdown`.
- `core/adapter/pi-child.ts` (around lines 330-336) already calls `dispose()`, which emits `session_shutdown`, if `bindExtensions` throws.

**Consequence for this repo:** no change needed. A spawn that fails before or inside `bindExtensions` leaks no MCP connection. Note: under the RPC double bind (1a), pi's MCP extension would start its connections twice. That is pi's issue, not this repo's.

### Can `ChildSession.dispose` be called twice, emitting `session_shutdown` twice?
**Answer:** no, not through the runner.

**Evidence:**
- `runner.ts` `releaseLive` (around lines 304-323) clears the reference before awaiting, so a second call finds no child:
  ```
  live.child = undefined;
  if (child) { ... await child.dispose().catch(() => undefined); }
  ```
  `releaseLive` is the only `dispose()` call site.
- `shutdown()` only touches records that are not closed. A record stopped during grace is already closed.
- pi's own `AgentSession.dispose` is safe to repeat, because `invalidate` is guarded (`runner.js:482-486`).

**Consequence for this repo:** no change needed. Optionally add a `disposed` guard in `pi-child.ts` `dispose` (the same flag as 2b) as defence in depth.

### Does `createTranscriptPane.sync` need to handle a same-length but different item list?
**Answer:** yes. The agent view follows the chain to the successor's session file while it stays open, so the list source changes under the same pane.

**Evidence:**
- `extensions/subagents/src/plugins/agent-view/index.ts` (around lines 94-101) loads the session of the chain terminal on every load:
  ```
  const record = live ? chainTerminal(registry, live) : found;
  const session = record.sessionFile ? readSession(record.sessionFile) : undefined;
  ```
- `view.ts:165` creates one transcript per view, and `view.ts:244` calls `transcript.sync(...)` on every reload.
- `core/adapter/pi-ui.ts:207-214` resets only when the list shrinks (`items.length < synced`). After a handoff the successor's list can be shorter, equal or longer, so the predecessor's rendered items can stay with the successor's tail appended.

**Consequence for this repo:**
- In `agent-view/view.ts` `reload()`, track the session file (or `record.id`). When it changes, reset the transcript before calling `sync`, for example through a new `reset()` on `TranscriptPane`.
- Alternatively, have `sync` take a source key and reset when the key changes (`pi-ui.ts:207`).

### Does pi return `tokens: null` right after compaction, leaving a stale footer percentage?
**Answer:** yes, pi returns null until the next assistant response. The stale footer comes from the missing refresh, though, not from the null.

**Evidence:**
- `pca/core/agent-session.js:3445-3463`: after the latest compaction, if no assistant usage follows it, pi returns `{ tokens: null, contextWindow, percent: null }`.
- Session-limits updates `state.context` only in `onTurnEnd` (`extensions/session-limits/src/limits.ts:349-366`). Manual `/compact` happens while idle, and auto-compaction runs after `turn_end` (`_checkCompaction` in `_handlePostAgentRun`, `agent-session.js:1445`). So the footer keeps the pre-compaction percentage until the next turn ends.
- pi emits `session_compact` after both compaction paths (`agent-session.js:2242-2248`, `:2531`).

**Consequence for this repo:**
- Add `onCompact` to the `Host` contract (`core/adapter/contract.ts`) and wire it in `pi-adapter.ts` with `pi.on("session_compact", ...)`.
- In `limits.ts`, on compact set `state.context = undefined`, which hides the segment because the level is unknown, then call `refresh()`.

### Does `/session-handoff` via `sendUserMessage` leave a visible user message?
**Answer:** no. Extension commands are run before any message is created.

**Evidence:**
- `pi.sendUserMessage` reaches `session.sendUserMessage` (`agent-session.js:1848-1875`), which calls `prompt(text, { expandPromptTemplates })`.
- `prompt()` runs `_tryExecuteExtensionCommand` first and returns when the command is handled (`:1525-1531`):
  ```
  if (expandPromptTemplates && text.startsWith("/")) {
      const handled = await this._tryExecuteExtensionCommand(text);
      if (handled) { preflightResult?.("handled"); return; }
  ```
- `pi-adapter.ts` `dispatchCommand` passes `expandPromptTemplates: true`.
- If the dispatch happens during `agent_settled`, it is deferred, not dropped (`:1518-1521`).

**Consequence for this repo:** no change needed. The README claim holds. A live TUI check is still worthwhile for the rendering side.

### Does spending's shutdown persist still have a live context?
**Answer:** yes.

**Evidence:**
- `agent-session-runtime.js:105-112` and `:296-302`: `session_shutdown` is emitted before `beforeSessionInvalidate` and `session.dispose()`, so the runner is not yet invalidated.
- `pi-adapter.ts:92-99` sets `state.stale = true` only after all shutdown handlers have run.

**Consequence for this repo:** no change needed. Order relative to other extensions does not matter for liveness.

### Could a resumed run double count usage under a new runtime token?
**Answer:** no. The registry is in memory and starts empty in each new instance, and every child session is fresh.

**Evidence:**
- `extensions/subagents/src/plugins/agent-registry/index.ts:13` runs `createRegistry({ bus })` per instance and never restores from `manifest.json`. The manifest is written only, in `registry.ts:44`.
- `runner.ts` `continueChain` (around lines 362-388) creates a successor with a new id and a new child. `resume()` (around lines 237-242) needs an existing `live.child`.
- Usage reaches spending through `releaseLive` with `child.ownUsage()` (around line 321). That sums only that child's fresh session file.

**Consequence for this repo:** no change needed.

### Can `toolResult` usage be double counted in main (`core/adapter/usage.ts`)?
**Answer:** no, because the repo's tools never set `usage`.

**Evidence:**
- pi copies `result.usage` from a tool's return value into the toolResult message (`pac/agent-loop.js:665`). pi's own totals count it as "Tools/summaries" (`pca/core/usage-totals.js:54-56`).
- The repo's `toPiResult` (`core/adapter/pi-tools.ts:6-10`) returns only `content`, `details` and `isError`.

**Consequence for this repo:** no change needed. Keep `toPiResult` free of `usage`, or drop `toolResult` from `sumSessionUsage` if `run_agent` ever starts returning child usage.

### Does pi honour `peerDependencies: "*"` as documented, and is it in `research/pi-extension-api.md`?
**Answer:** yes, it is documented, and the research file records it.

**Evidence:**
- `pca/../docs/packages.md:80-90` lists the host-provided packages (pi-ai, pi-agent-core, pi-coding-agent, pi-tui, typebox):
  > "Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not bundle them. Pi suppresses automatic peer installation for managed npm packages and git packages..."
- `research/pi-extension-api.md:346` records the same rule.
- The repo's `package.json:42-46` declares pi-coding-agent, pi-tui and typebox. Those are the only host packages the repo imports.

**Consequence for this repo:** no change needed.

### Is `engines >=22.19.0` acceptable?
**Answer:** yes, it matches pi.

**Evidence:** `pi-coding-agent/package.json:105-107` declares `"node": ">=22.19.0"`, the same as the repo's `package.json:56-58`.

**Consequence for this repo:** no change needed.

### Not answered here
- `docs/deviations.md` entries 25-44 and 84-122 cross-check: code reviewers own this.
- npm publication: the owner decides.
