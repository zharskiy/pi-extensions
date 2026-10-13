# Review findings: plans 00–06, decisions.md, shared-modules.md

## Resolution (2026-10-14)

Every blocker and should-fix below was applied to the plans on the same day; each plan carries a "Reviewed 2026-10-14" line naming the findings it absorbed. Decisions taken on the open points:

- P1: notification channel `auto` sends OSC 9 / OSC 777 without a bell; `bell` is BEL only (finding 40, UX).
- P2: `idleDelayMs` default 20 000 (finding 40).
- P3: the idle wake's visible line is `↳ 3 agents finished` (finding 39).
- P4: the `tools` service is `{ list(), add() }` (finding 29).
- P5: the panel window keeps its top row when the selection clears (finding 41).
- P6: `Esc` in the list cancels a pending stop-all and closes (declared-deviation push-back accepted).
- Finding 18: `core/manager/format.ts` holds `formatTokens` and `formatDuration`; footer and working-indicator import them.
- Finding 28: no completion lines for agents interrupted by a session switch.
- Finding 42: documented in the subagents README; no behaviour change.
- Finding 43 (regular TUI scrollback): accepted as declared by plan 04.

The integration order at the end of this file is the authoritative sequence; `plans/README.md` summarises it.

Devil's-advocate read of the nine documents against the codebase (`core/adapter/*`, `core/manager/*`, `extensions/subagents/src/**`, `extensions/working-indicator/src`, `extensions/footer/src`, `core/test/helpers/fakes.ts`, `test/architecture.test.ts`, `biome.json`, `package.json`, `.github/workflows/ci.yml`) and pi 1.1.0's dist. 44 cited `file:line` references were opened; the ones that are wrong are listed in category 3. Severity: **blocker** (a developer following the plans as written cannot keep `npm run check` green or ships the wrong behaviour), **should-fix** (costs real time or a later rework), **nit**.

## 1. Contradictions between plans

1. **blocker** · `05-agent-panel.md:13,209` vs `extensions/subagents/src/model/types.ts:153-155` · Plan 05 calls `services.require("agentView").open(id, { from: "panel" })`, but plan 06 (which lands after 05, since it depends on 05's modules) is the one that widens `AgentViewService.open` to take `{ from }`; today's signature is `open(id: string)`, so plan 05's `npm run check` fails with TS2554. Fix: plan 05 step 1 adds to `model/types.ts` `export type AgentViewOrigin = "list" | "panel" | "command"` and `open(id: string, options?: { from: AgentViewOrigin }): Promise<void>`; plan 06 §2 makes `options` required and drops the `?`.

2. **blocker** · `06-list-and-agent-view.md:111` vs `05-agent-panel.md:65,71` · Plan 06 renders list rows with `nameColumn(visible)` where `visible` is `AgentRecord[]`; plan 05 (the owner) deviated to `nameColumn(rows: Pick<TreeRow, "record" | "openDescendants">[])` and even says "Plan 06 calls it with its tree rows", which plan 06 does not. Fix: plan 06 §3 `render`: `const nameCols = nameColumn(sections.flatMap((section) => section.rows))` computed once per render, passed to every `renderRow`; update `shared-modules.md:55` to plan 05's signature.

3. **blocker** · `05-agent-panel.md:52,325` vs `extensions/subagents/src/plugins/run-agent/result.ts:3,48` and `agent-status/snapshot.ts:1-9` · Plan 05 deletes `finishSummary`, `graceSecondsLeft` and `truncate` from `agent-row.ts`, but `result.ts:48` still calls `finishSummary` for the model-facing batch text and `snapshot.ts` still imports `graceSecondsLeft` and `truncate`; plan 05 step 3 names only `truncate` in `result.ts`/`agent-view/view.ts`, and plan 04 §2 keeps `finishSummary` in `agent-row.ts` "until plan 05" without saying where it goes. Fix: plan 04 step 1 moves `statsText`/`finishSummary` (model wording `tool calls`) into `run-agent/result.ts` as private functions and `graceSecondsLeft` + a local `cutChars` into `agent-status/snapshot.ts`; `agent-row.ts` keeps private copies only for `agentRow` until plan 05 deletes it. Then plan 05's delete list is self-contained.

4. **should-fix** · `05-agent-panel.md:325` · The bridge "move a thin copy of today's `treeRow`/`agentRow` into `components/agent-list.ts`" is not thin: `agentRow` needs `finishSummary`, `progressText`, `truncate`, `chainLabel`, `attentionText`, `STATE_COLORS`, `stateIcon` and `graceCountdown` (~120 lines) and `agent-list-view/view.ts:11` and `agent-view/view.ts:15` import `truncate` too. Fix: plan 05 step 3 renames today's `components/agent-row.ts` to `components/legacy-row.ts` unchanged (after plan 04's trim), repoints `agent-list.ts`, `agent-list-view/view.ts`, `agent-view/view.ts` to it, and writes the new `agent-row.ts`; plan 06 §6 adds `components/legacy-row.ts` to its deletions. Or land 05 and 06 in one PR (plan 06 §10 already allows it) and drop the bridge.

5. **should-fix** · `04-main-transcript.md:158,192` vs `core/adapter/pi-tools.ts:12-21` · Plan 04's error header tests `result.isError`, but the adapter's `fromPiResult` never copies `isError` into the `ToolResult` a renderer receives, and plan 01 §D does not change that. Fix: plan 04 §4 uses `state.isError` (plan 01 §D forwards it from pi's context); plan 01 §D additionally copies `isError` in `fromPiResult` so both agree.

6. **should-fix** · `04-main-transcript.md:191` vs `01-adapter-foundations.md:238-249` and pi `types.d.ts:349` · Plan 04 keeps a `Map<toolCallId, params>` filled by `renderCall` only because `renderResult` gets no params, yet pi's `ToolRenderContext.args` carries them and plan 01's `ToolRenderState` drops the field. Fix: plan 01 §D adds `args: unknown` to `ToolRenderState` (from `context.args`); plan 04 reads `(state.args as RunAgentParams).wait` and deletes the map and its eviction rules (which were also wrong for nested batches rendered in the agent view, where entries keyed by the overlay's toolCallIds are never evicted).

7. **should-fix** · `03-notifications.md:3` · Says "Spec §8 names the channel `session:busy`"; the spec (`00-ux-spec.md:458,508`) says `pi:busy`. Fix: delete the sentence; all three documents agree on `pi:busy`.

8. **should-fix** · `06-list-and-agent-view.md:303` vs `04-main-transcript.md:311` · The nested-`run_agent` test expects `transcripts[0].tools` to include `agent_status`, but the harness lists only `runAgentPlugin`; `agent_status` is appended by `agentStatusPlugin` (now `requires: ["agent-registry", "run-agent"]`). Fix: plan 06 §9 harness: `[agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, agentStatusPlugin, agentViewPlugin]`.

9. **should-fix** · `06-list-and-agent-view.md:188` vs `04-main-transcript.md:45-48` · Plan 06 defines local `oneLine`/`firstLine` in `view.ts` and computes the duration inline; plan 04 exports `singleLine`, `firstLine`, `elapsedOf` from `format.ts` (spec §1 principle 6: one set of formatters). Plan 05 line 77 also re-implements `\s+` collapsing. Fix: both import `singleLine`, `firstLine`, `elapsedOf` from `components/format.ts`; plan 06 header line 3 uses `formatDuration(elapsedOf(record, now))`.

10. **should-fix** · README "Other keys" sentence (`extensions/subagents/README.md:125`) is rewritten by plan 04 §8 (`renderThrottleMs` clause), plan 05 §5 (whole paragraph, different `renderThrottleMs` wording), plan 06 §8 (`lingerMs` and `renderThrottleMs` fragments that will no longer exist after 05) and plan 03 §4.7 (drops `notifications`). Fix: plan 05 owns the final sentence (its text is complete and already includes `lingerMs` for the list); plan 04 and plan 06 delete their edits of that sentence; plan 03 only guarantees the `notifications` clause is absent (if 05 landed first there is nothing to do).

11. **should-fix** · README "Use" bullets: plan 05 §7 replaces line 36 "and its three sub-bullets"; plan 06 §8 says "Line 36 keeps its first sentence" and replaces the same sub-bullets plus line 40. Fix: plan 05 replaces line 36 and its sub-bullets with its three panel bullets; plan 06 appends its two bullets after them and deletes line 40; plan 06 drops the "keeps its first sentence" instruction.

12. **should-fix** · README line 7 (`Version 0.3.0 adds the context breakdown, terminal notifications, … you can message any agent from its view, browse all agents in a list`) · Plan 03 drops `terminal notifications, `; nobody removes `the context breakdown` or `message any agent from its view`, both deleted by plan 06. Fix: plan 06 §8 rewrites line 7 to a 0.4.0 sentence: "Version 0.4.0 replaces the progress widget with a panel below the editor, redraws `run_agent` as a start block with one completion line per agent, merges the list and the view into one `/agents` overlay, and moves notifications to the notifications extension."

13. **should-fix** · `ARCHITECTURE.md` "Status, views, notifications" bullet 90 is replaced three times: plan 04 §9 ("replace the widget sentence with" the shared-surfaces paragraph), plan 05 §7 ("replace the second bullet"), plan 06 §8 ("replace the list half of the widget bullet"). Fix: the section's final content is: title `Status and views` (plan 03); bullet 1 `agent_status` unchanged; bullet 2 plan 04's shared-surfaces paragraph (new bullet, not a replacement); bullet 3 plan 05's panel paragraph; bullet 4 plan 06's list sentence; bullet 5 plan 06's agent-view paragraph; the notifications bullet deleted (plan 03). Write that list into plan 04 §9 and have 05/06 refer to it.

14. **nit** · `01-adapter-foundations.md:300` says the panel keeps "its own unref'd 1 s interval"; plan 05 §2.3 uses a 100 ms / 1000 ms `setTimeout` chain. No contract impact; align the sentence.

15. **nit** · `06-list-and-agent-view.md:351` suggests the 05 bridge `tickMs: () => 1000`; plan 05 §2.3 already specifies `tickMs: () => (ticking() ? 1_000 : undefined)`. Keep 05's.

16. **nit** · `02-working-indicator.md:174` says "plan 03 renames the value, not the constant"; the rename is plan 01 §G.

17. **nit** · `04-main-transcript.md:150,189` · `render.ts` imports `RunAgentParams` from `tools.ts` and `tools.ts` imports `RunAgentDetails` from `render.ts`: make both `import type` to avoid a runtime cycle.

Who owns what, confirmed consistent: `tools` service (04 provides, 06 consumes), `batchSettled` and `session:closing` removal (03; 04/05/06 do not use them; 04 listens to `batch:settled`, which stays), `terminalNotify(message, channel)` (03; only caller is the deleted plugin; `prompts.ts` never calls it; plan 01 does not touch it), `ChoiceRule` (03 only), `spinnerFrame(now)` and `stateGlyph(state, now)` (04 → 05/06, test clocks all land on frame `⠋`), entry type `pi-subagents:agent-closed` and wake `customType` `pi-subagents:wake` (04 only), manifest counters (06) versus non-persisted `activity` (04), `PAD` (05's rows carry it; plan 06's list rows therefore also get it, which matches the spec §5 mockup where rows sit one column right of the headers), `lingerMs`/`doneLingerMs`/`failedLingerMs`/`agentsHintMs` ownership (shared-modules table matches 05/06).

Overlapping doc paragraphs (for the integration order): `extensions/subagents/README.md` line 7 (03, 06), 34-40 (04, 05, 06), 42 (03), 44 (01 §G, 03), 45 (04, 05 fallback), 125 (03, 04, 05, 06); `ARCHITECTURE.md` line 3 (03), 8 (01 §G), 14-31 "Startup and the adapter" (01 §A/B/C/D/F, 03 terminalNotify), 39 (03), 43 (03), 51 plugin list (03, 05, 06), 64/70/71 steps 2/8/9 (04; 01 §C also names step 9), 67 step 5 (06), 77 (06), 79 (03), 87-92 (03, 04, 05, 06), 103 (01 §G, 03), 116-119 (02), new Notifications section (03), 143 and 147 (03, 06); `STRUCTURE.md` tree (01, 02, 03), components comment 41-43 (04, 05, 06), plugin list 86-103 (03, 05, 06), entry points 118 (03).

## 2. Gaps against the spec

18. **should-fix** · `00-ux-spec.md:33,509` vs `shared-modules.md:19`, `04-main-transcript.md:85`, `02-working-indicator.md:84` · The spec says the `formatTokens` duplicate in `footer/src/render.ts` goes; plans 02 and 04 keep it and add a second duplicate (`working-indicator/src/format.ts`) because extensions may not import each other. Both are right about the rule, but the rule allows `core/manager` (`ARCHITECTURE.md:9`). Fix: plan 04 step 1 creates `core/manager/format.ts` exporting `formatTokens` and `formatDuration` (pi-free, tested in `core/test/manager/format.test.ts`); `extensions/subagents/src/components/format.ts` re-exports them; footer imports `formatTokens` from there (its own copy and the render test case move); plan 02 §3 imports `formatDuration` from there and drops `src/format.ts`. Spec §2 and §10 then hold as written.

19. **should-fix** · `00-ux-spec.md:310` vs `06-list-and-agent-view.md:90` · The list hint with nothing selected (empty list) is `esc to close` in plan 06; the spec has one hint line. Declare it or use the full line. Suggest declaring: an empty list has nothing to select, stop or view.

20. **should-fix** · `00-ux-spec.md:305` vs `06-list-and-agent-view.md:126` · `No running agents` is shown when no `queued`/`running` record is visible; the spec says "with no open agent", and `grace` is open. With only grace rows plan 06 shows `No running agents` yet the agents are still answering. Fix: plan 06 tests `visible.some((r) => !isClosed(r.state))`; for an all-grace list the second `X` is a no-op (plan 06 leaves grace alone) and the feedback stays `Press X again…`. Or declare the deviation.

21. **should-fix** · `00-ux-spec.md:47` ("on every pi render while the main session is busy") vs `04-main-transcript.md:196` · pi's `ToolExecutionComponent` caches its rendered lines until `invalidate()`, so the spinner header during `wait: true` only moves on throttled `agent:changed`. Plan 04 declares it. Accept, but record it in the spec as a deviation so the manual checklist does not fail on a frozen spinner between agent events.

22. **nit** · `00-ux-spec.md:92` ("The error is its first line, cut at 120 columns") and `04-main-transcript.md:237` agree; `00-ux-spec.md:73` says the row's `Failed:` line shows the first line without a cut while the row is bounded by `BLOCK_WIDTH` — fine, just confirm `truncateCols` is applied to the status line as well (plan 04 line 171 does not cut it).

23. **nit** · `00-ux-spec.md:109` keeps the forwarded-dialog title `<id> (<agent>) asks: <title>`; plan 03's notification text is `pi needs your input: <title>` where `<title>` is pi's `ui_prompt_start.title`, i.e. the already-prefixed `explorer-1 (explorer) asks: Allow bash?`. Intended? If so note it in plan 03 §1 (the manual checklist line 245 reads as if the bare title were shown).

Everything else in spec §3–§9 maps to a plan step: block header phases, rows, status lines, worktree suffixes, `Status unavailable`, completion lines (incl. chains and worktrees), the wake and its idle/busy split, panel row grammar and column rule, window and markers, visibility and lingers, keys, hint line, footer status, refresh; list layout, sections, lifecycle, keys, feedback, one overlay; view header lines 1–6, transcript, Ctrl+O, scrolling, hint table, keys, refresh, removals; indicator phases, grammar, clock, child isolation; notifications triggers, cancellations, channels, settings; settings table.

### Declared deviations

| Plan | Deviation | Verdict |
|---|---|---|
| 04 §4 | `BLOCK_WIDTH = 100` instead of the real width (no width reaches a tool renderer); rows wrap below 100 columns | accept (note it in the README "narrow terminals" sentence) |
| 04 §4 | Spinner header advances only on invalidation | accept (see 21) |
| 04 §4 | Aborted `wait: true` shows `✗ No agents started` | accept |
| 04 §10 | Regular TUI mode: scrollback cleared on each invalidation, no age cutoff | accept |
| 05 §2.2 | `nameColumn` takes tree rows | accept (fix plan 06, finding 2) |
| 05 §2.2 | `PAD` on every panel line, grammar gets `width - 1` | accept; it also applies to list rows, say so in plan 06 |
| 05 §3.1 | Closed-row cache key adds selection and tree shape | accept |
| 05 §2.3 | Call-site bridge for `watchAgents` | accept if finding 4 is adopted |
| 05 §2.2 | Name column measured over all lifecycle-visible rows, not the 5 shown | accept |
| 06 §2 | Plugin id stays `agent-view` (merge, no `agent-views`) | accept |
| 06 §3 | Wheel and page keys move the selection | accept |
| 06 §3 | Selection falls back to the previous row before clearing | accept |
| 06 §3 | `Esc` with a pending stop-all only cancels the confirmation | push back: the spec's "any other key cancels" plus "`Esc` closes" means Esc cancels *and* closes; a 3 s modal Esc is a surprise. Make Esc cancel and leave. |
| 06 §3 | Stop-all leaves grace records alone | accept (they are already stopping) |
| 06 §3 | `stop failed: <msg>` feedback kept | accept |
| 06 §4 | Reaching the tail by scrolling resumes following | accept |
| 06 §4 | The view's tick also stats the session file | accept |
| 06 §4 | `worktree: kept: <path> (branch <b>)` keeps today's text | accept |
| 06 §2 | `/agents` completion lists only visible agents | accept |
| 02 §2 | Repeated `agent_start` keeps the clock (today restarts it) | accept (spec §7 asks for it) |
| 02 §2 | Working row jitter on each hide/show | accept (D7) |
| 03 §1 | A forwarded dialog shown while `/agents` is open does not notify | accept |

## 3. Incorrect claims about pi or the codebase, and rule violations

Verified correct (sampled): plan 01 §A `agent-loop.js:50/51/68/113/191-197/290-320`, `types.d.ts:724/777/829/848`, `IM:1819-1829/1921/2762/2915`, `AS:1049-1051`; §B `tui.js:678-697`, `custom-editor.js:62-80`, `editor.js:760-771`, `IM:2083-2084/2255-2290`, `custom-editor.d.ts:11`; §C `AS:1782-1808/1591/1611-1614/1627/1409/1518-1521/684-704/748-750/1848`, `IM:2776-2781/3126-3144`, `custom-entry.js:36-57`; §D `tool-execution.js:74-93/242/311-322`, `codemode/index.js:17-30`, `tool-search/index.js:9-13`, `index.d.ts:8`, `IM:2936-2941`; §E `pi-ui.ts:353-401/213-244`, `agent-view/view.ts:194`, `footer/src/render.ts:152-160`, `loader.js:2-3`; §F `runner.js:359-399`, pi-tui `index.d.ts:23`; §G all nine file:line rows; plan 02 `IM:1783-1794/1806-1810/1813-1818/2061-2066/1831-1837/2957/366-368/5366`, `AS:686/690/1388`; plan 03 `runner.ts:901`, `types.ts:138`, `runner.ts:153-157/932`, `run-agent.test.ts:507-525`, `settings.test.ts` fixture (`notifications: "off"` at line 33); plan 04 `runner.ts:346/512-514`, `placement.ts:14-20`, `tool-execution.js` `isPartial` (line 27 initial `true`, `updateResult(result, isPartial = false)`), pi-tui `Text` renders no line for empty text; plan 05 `agent-view/index.ts:173`, `agent-list-view/index.ts:13-17`; plan 06 `extension-manager.ts:79-82`, `IM:2787` (a `display: false` custom message is never added to the chat).

24. **nit** · `01-adapter-foundations.md:82` cites `types.d.ts:62` for `setWorkingVisible`; it is at `types.d.ts:88` (line 62 is `WorkingIndicatorOptions`). `onTerminalInput` (`01:327`) is at `:82`, not `:80`.

25. **nit** · `06-list-and-agent-view.md:177` says `result.ts:55` stores invalid-handoff reasons in `error`; `result.ts:55` only prints them, the store is `runner.ts:338-342` (`error: validation.errors.join("; ")`).

26. **nit** · `05-agent-panel.md:255` cites `prompts/main-session.md:61` for the `/agents <id>`, then `x` sentence; it is line 59 (line 39 for the description sentence is right).

27. **should-fix** · `01-adapter-foundations.md:60` ("tools of the previous turn are finished before `turn_end`, agent-loop.js:185-190") is a fair reading, but note the reducer must also tolerate `turn_start` arriving with a non-empty `running` map after an abort mid-tool (pi aborts the tool, emits `tool_execution_end` with `isError`, then `agent_end`); the plan's "clears a (defensively) non-empty map" covers it. No change, add a reducer test `"clears running tools on turn_start after an aborted tool"`.

28. **should-fix** · `04-main-transcript.md:220-226` · The completion-line listener is on `agent:closed`; on `/new`, `/quit`, `/reload` the runner closes every open agent as `failed (interrupted)` inside `host.onSessionShutdown` while the pi context is still alive, so N `✗ Agent "…" failed: interrupted: session new` entries are appended to the session file at shutdown and replayed on resume/reload. Spec §3 says "every agent whose caller is main … when the record closes", so it is spec-conformant, but it was probably not intended. Fix: plan 04 §5 step 1 adds `if (shuttingDown) return` (the runner exposes nothing; use a flag set in run-agent's own `onSessionShutdown` handler, registered before `runner.shutdown` runs) and documents "agents interrupted by a session switch print no line".

29. Architecture rules: no plan step makes an extension import another extension or a plugin import another plugin; plan 03's new extension imports only `contract.ts`, `core/manager` and `pi-adapter.ts` from `src/index.ts`; plan 06's `test/helpers/overlay.ts` imports `core/adapter/pi-ui.ts` from a test, which `test/architecture.test.ts` does not scan and `biome.json` allows (only direct `@earendil-works/*` imports are restricted). Plan 04's `tools` service is an array mutated by `agent-status` (`push`); that is a cross-plugin write through a service, allowed by the manager rules but fragile: prefer `services.provide("tools", { list(): AnyToolSpec[]; add(spec): void })`. **nit**.

30. Order-of-work breaks (beyond findings 1–4): plan 03 step 2 removes the subagents plugin before step 4 changes `terminalNotify` — fine, the old signature has no caller after step 2. Plan 04 step 1 trims `agent-row.ts` but `test/components/agent-row.test.ts:4-10` imports `formatElapsed`/`formatTokens`/`truncate`; plan 04 deletes one `it` but the import list must also drop `formatElapsed` and `formatTokens` or the file fails to compile (`truncate` stays). **should-fix**, add to plan 04 step 1.

## 4. Missing pieces a developer would hit

31. **should-fix** · `01-adapter-foundations.md:283` · `FakeHost.renderTool(name, { call?, result?, state? })` is specified, but plan 04's render tests also need the fake's default `ToolRenderState` to carry `args` (finding 6) and `isError` from the given result; add both to the default state builder.

32. **should-fix** · `03-notifications.md:94` · `createNotifications` registers `host.subscribe(BUSY_CHANNEL)` at boot "so the registry's `session_start` publish is heard": the fake's `publish` only delivers while not stale and the real adapter's `publish` is a no-op before `session_start` captures a context; the registry publishes from its own `onSessionStart`, which runs after the adapter has captured the context. Fine, but the notifications extension and subagents are different pi extensions, so the ordering of their `session_start` handlers is pi's load order: if notifications loads first, its `onSessionStart` runs first; the busy subscription is on `pi.events`, made at boot, so it hears the registry's publish either way. No change, but the test `holds while a busy source is set…` should also cover `busy: true` arriving before `host.start()`.

33. **should-fix** · `06-list-and-agent-view.md:127` · `showFeedback`'s `setTimeout` is not `unref()`'d; plan 05's `agent-panel.test.ts` asserts `vi.getTimerCount() === 0` after disable, plan 06 has no such test. Add `.unref()` and a `dispose()` assertion.

34. **should-fix** · `05-agent-panel.md:216` · The widget `render` closure calls `panelRows(registry.list(), …)` (a full `treeOrder`) on every TUI render and the ticker requests a render 10×/s while any agent runs even when the main session is idle; today's widget renders at most 1×/s when idle. Acceptable for ≤ 20 records; put a note in plan 05 and skip the render when `panelLines` output equals the last one (compare joined strings) to keep pi's diff cheap.

35. **should-fix** · `04-main-transcript.md:191` · `renderResult` registers `deps.onRendered(batchId, invalidate)` also when the spec renders inside the agent view (plan 06) for a nested batch; after the overlay closes the stored `invalidate` points at a disposed component and is called on the batch's next `agent:changed` (`tui.requestRender()` on a dead overlay). Harmless today but add `try/catch` around `invalidate()` in `scheduleRender` or scope the map per spec instance (the agent view passes the main plugin's specs, so the map is shared).

36. **nit** · `01-adapter-foundations.md:327` · `onKeyPress` skips SGR mouse reports (`\x1b[<`); legacy X10 reports (`\x1b[M`) are not filtered. Add `|| data.startsWith("\x1b[M")`.

37. **nit** · `03-notifications.md:180-181` · Root `README.md:5` subagents bullet also says `with a context breakdown per agent`; plan 06 should drop that phrase in the same edit (`with MCP for every agent with tools`).

38. Verified present: fakes for every capability a plan test needs (`phases`/`setPhase`/`workingVisibility` 02; `dialog`/`pressKey`/`keyListeners`/`terminalNotices` 03; `hidden`/`renderEntry`/`renderTool` 04; `pressEmptyLeft`/`pressEditorKey`/`editorCapture`/`foreignEditor`/`widgets`/`widgetRefreshes`/`statuses` 05; `overlays` + `fakeOverlayApi` 06); `plugins.ts` order gives `run-agent` before `agent-status` (04's new `requires`) and `limits`/`usage-report` already require `run-agent`; `/agents` is registered only by `agent-view/index.ts` after the merge; `package.json` `files` globs cover `extensions/notifications/src/**` and `README.md`, the CI pack grep excludes `test/`; `vitest.live.config.ts` `include` must gain `core/test/adapter/**/*.live.test.ts` (plan 01 §C says so).

## 5. UX risks

39. The visible `3 agents finished` line renders in pi's user-message box, i.e. as if the user typed it, and is replayed on resume; a reader of the transcript will think the user wrote it. Mitigation within the plan: none possible without pi changes; consider a leading glyph (`↳ 3 agents finished`) so it reads as a system note.
40. `idleDelayMs` 10 s rings the bell and posts a desktop notification after every reply the user merely reads without touching a key, including short Q&A; Claude uses 60 s. Keep the setting prominent in the README, and consider 20 s.
41. The panel window resets to `top = 0` whenever the selection clears (Esc, any typed key, a selected row leaving), so a scrolled panel jumps; and `done` rows leaving after 10 s reflow the rows under the cursor while the user is aiming at them.
42. The panel is entered with `←` on an empty editor (changed from `↓` on 2026-10-14). `←` has no editor meaning on an empty line (`moveCursor(0, -1)` is a no-op at column 0; no history or autocomplete behaviour), so the reflex-press risk is gone and history keeps `↑`/`↓`. Document the key in the composer hint if one exists.
43. Shutdown completion lines (finding 28) and, in regular TUI mode, the block redraws clearing scrollback (plan 04 §10) are the two places where "one calm line" turns into a wall; the first is fixable now.

## Integration order

Each step ends with a green `npm run check`.

1. Plan 01 §G (busy rename) and §H (none) — docs and one constant.
2. Plan 01 §A (phases) → plan 02 (working indicator; it fixes the `setWorkingVisible` doc comment).
3. Plan 01 §F (dialogs, key listener) → plan 03 steps 2–6 (remove the subagents notifications plugin, `ChoiceRule`, `terminalNotify(message, channel)`, the new extension, docs). Also delete `README.md` line 7's `terminal notifications, `.
4. Plan 01 §B (editor hooks) → plan 01 §D (tool render state incl. `args` and `isError`, transcript tools) → plan 01 §C (hidden message, entry renderer; live test run locally).
5. Plan 04 with the core/manager formatters (finding 18) as step 0, then steps 1–6 with findings 3, 5, 6, 28, 30 applied; `agent-row.ts` keeps `agentRow`/`treeRow` working over the new formatters. Footer and working-indicator switch to `core/manager/format.ts` here (or plan 02 does it up front if 02 lands first: then plan 02 creates `core/manager/format.ts` with `formatDuration` and plan 04 adds `formatTokens`).
6. Plan 05 with findings 1 and 4 (optional `{ from }` on `agentView.open`; `legacy-row.ts` bridge); settings file rebased over plan 03's removal of `notifications`; README "Other keys" final text (finding 10).
7. Plan 06 with findings 2, 8, 9, 12, 19, 20, 33; delete `legacy-row.ts`; README/ARCHITECTURE merges per finding 13 and the overlap list.
8. Final doc pass: `ARCHITECTURE.md` plugin list and "Status and views", `STRUCTURE.md` components comment, root `README.md` line 5 and bullets, `package.json` description.

If 05 and 06 are landed in one PR, skip the `legacy-row.ts` bridge and the optional `{ from }` (make it required at once).

## Verdict

The set is coherent on the things that usually go wrong between parallel authors: names, channels, services, settings and the fakes line up, and the pi citations are accurate where it matters (the wake analysis in plan 01 §C, the `isStreaming` re-show in plan 02, `isPartial` in plan 04, dialog wrapping in plan 01 §F all check out against the dist). Three things block a developer as written: the `agentView.open` signature between 05 and 06, `nameColumn`'s argument in 06, and the helpers 05 deletes that `result.ts` and `snapshot.ts` still import. Two should be fixed before anyone starts plan 04: `isError` never reaches a renderer today, and the params map is unnecessary once `args` is forwarded. The doc edits need a single owner per paragraph (findings 10–13) or the last PR will spend its time rebasing prose. The spec's promise to remove the footer duplicate is kept only if the formatters move to `core/manager`, which the architecture already allows. The declared deviations are reasonable; push back only on plan 06's Esc-cancels-but-stays. Shutdown completion lines and the 10 s notification are the two UX points worth a second look before implementation. With the fixes above the order in "Integration order" keeps `npm run check` green at every step.
