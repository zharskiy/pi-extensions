# Project review (2026-10-12)

What was fixed, fixed differently or left, finding by finding: [fixes.md](fixes.md).

Five reviewers read the whole repository in parallel: the core adapter and manager, the subagents runtime, the subagents UI, the session-limits and spending extensions, and the docs, config and packaging. Baseline before the review: typecheck, lint and all 434 unit tests pass; live tests were not run. Each document holds the full evidence, a dead-code table, simplification ideas and open questions. ARCHITECTURE.md and STRUCTURE.md in the repo root were also corrected in three places (see the end of this file).

- [core.md](core.md): core/adapter, core/manager, core/test and test/architecture.test.ts.
- [subagents-runtime.md](subagents-runtime.md): subagents index, model, run-agent, registry, definitions, limits, handoff, shipped agents and prompts.
- [subagents-ui.md](subagents-ui.md): agent view, agent list, agent status, progress widget, notifications, usage report and shared components.
- [session-limits-and-spending.md](session-limits-and-spending.md): both standalone extensions and their duplication with subagents.
- [docs-and-config.md](docs-and-config.md): READMEs, PLAN, HANDOFF, deviations, research, package.json, CI, lint and test config.

### Findings by severity

Counts are bullets in each document's own sections. Refuted leads, "no action" verification bullets and the dead-code tables are not counted. One High finding (disabledPlugins) is also a Medium in subagents-runtime.md, so unique High findings are 7.

| Document | High | Medium | Low |
|---|---|---|---|
| core.md | 2 | 5 | 6 |
| subagents-runtime.md | 2 | 9 | 15 |
| subagents-ui.md | 0 | 5 | 10 |
| session-limits-and-spending.md | 0 | 5 | 12 |
| docs-and-config.md | 3 | 8 | 6 |
| Total (as written) | 7 | 32 | 49 |

### High findings

Ranked by user impact.

- **Shipped agents need OpenAI credentials, README says they inherit the main model.** `extensions/subagents/README.md:13` vs `extensions/subagents/agents/{explorer,general,implementer,reviewer}.md:4`. Without OpenAI auth every `run_agent` call is rejected. Fix: ship `model: inherit[:level]` or state the requirement. See subagents-runtime.md.
- **A failed wake or follow-up after an agent's first turn is swallowed and the agent hangs holding its slot.** `core/adapter/pi-child.ts:253-258`, `:378-396`. `settled` is never reset, so `failStart` returns early; the batch never settles. Fix: reset `settled = false` before each `session.prompt`. See core.md.
- **A held or early message may start a second concurrent prompt and fail the agent (unverified at runtime).** `extensions/subagents/src/plugins/run-agent/runner.ts:669-674`, `:906-908`, `core/adapter/pi-child.ts:393-397`. `launch` steers held messages right after `child.start`, before pi sets its streaming flag, so `prompt()` may throw "Agent is already processing" and the runner closes a still-running agent as failed. Unit tests use fakes and cannot see it. To confirm: a live test that messages a queued agent with `maxConcurrent: 1`, or check that pi's `_isAgentRunActive` is set before the first await in `prompt()`. See subagents-runtime.md.
- **Project-level `disabledPlugins` is accepted and silently ignored.** `extensions/subagents/src/index.ts:18-19,35-41` vs `:21-25`; `extensions/subagents/README.md:108-120`. The manager is built at boot from the user file only. Fix: document "user file only" and warn, or read the project file at boot. See core.md and subagents-runtime.md.
- **`files` in package.json ships tests, fixtures, snapshots, spike.ts and a stray `node_modules/.vite` cache.** `package.json:14-19`. 134 files, about 45 of them tests. Fix: list only runtime paths and add `"!**/node_modules"`. See docs-and-config.md.
- **MIT license declared, no LICENSE file.** `package.json:6`. Fix: add `LICENSE`. See docs-and-config.md.
- **Version is 0.1.0 while docs, plan and git history say 0.3.** `package.json:3` (and the lock), `extensions/subagents/README.md:7`, `PLAN.md:5`. Fix: bump to 0.3.0 and tag. See docs-and-config.md.

### Cross-cutting themes

**Duplication that could move to core**
- Handoff section validation is duplicated (about 45 lines): `extensions/subagents/src/plugins/handoff/schema.ts:3-75` and `extensions/session-limits/src/handoff.ts:7-98`. Only the status lists differ. A pi-free `core/manager` helper taking sections and statuses fits the architecture rules. See session-limits-and-spending.md and subagents-runtime.md.
- `isAhead` is copied between `extensions/spending/src/ledger.ts:49-55` and `usage-report/index.ts:8-14`. See subagents-ui.md.
- Channel names `session-limits:busy` and `spending:usage` are literals on both sides with no test spanning them. Share constants and payload types, or add one agreement test.
- `MANIFEST_FILE` is exported from `registry.ts:7` while agent-view hard-codes `"manifest.json"` (`agent-view/index.ts:28`). Share it through `model/`. Also three hand-rolled throttles next to `createThrottle` (subagents-ui.md).

**Unnecessary exports**
- Roughly 150 symbols are exported but used only in their own file or only by tests. Each document's "Dead code and unnecessary exports" table lists them, including which ones are reasonable test seams to keep. Do them as one sweep per document.

**Dead production code (truly dead only)**
- `Runner.live` (`runner.ts:74,970`), `AgentDefinitions.errors()` (`model/types.ts:118`), `formatCost` in `components/agent-row.ts:53`, the `parseSettings` wrapper in `session-limits/src/settings.ts:20`, the `Ledger` type (`spending/src/ledger.ts:120`), and the returned `figures`/`refresh` of `createSpending`.
- Unused contract members: `Host.contextUsage`, `Host.setPromptSection`, `ChildEvent` `turn_start`/`tool_end`/`compaction_blocked`, `ChildSession.modelLabel/contextWindow/context`, `SessionInfo.dir/hasUI`, `ToolSpec.promptGuidelines`, `ToolRenderState.isPartial` (core.md).
- Test-only in production: `manager.report()` with contribution recording, `initRenderTheme`, `Semaphore.active/waiting`, `AgentDefinitions.mainPrompt()`. Dead branches: `runner.ts:336`, `runner.ts:213`, `!batch.woken` at `:361`.

**Stale documentation**
- HANDOFF.md, PLAN.md, docs/spike.md and docs/design/agent-and-model-selection.md describe superseded state; suggested fix is a `docs/history/` folder or a one-line "historical" header (docs-and-config.md).
- docs/deviations.md has 142 entries, about 60 describe removed code, some without a `Now:` note (entries 4, 9, 14, 48, 59, 60).
- README claims versus code: project `disabledPlugins`, agent model defaults, "Pinned to pi 1.1.0" with `*` peers, linger settings without meaning or defaults, widget "lists running agents" (also queued, grace and lingering), `/agents` following chains across sessions, "one notification per batch" (subagents-ui.md), equal soft and hard ratio wording (session-limits-and-spending.md).
- Prompts: `run_agent` description contradicts the result format for stopped agents and says "returns at once"; main prompt references `run_agent` and `agent_status` even when those plugins are disabled (subagents-runtime.md).

**Packaging and config**
- Version 0.1.0, `files` over-inclusion, no LICENSE, unused peer and dev deps `pi-agent-core` and `pi-ai`, `engines.node >=22` vs `>=22.19.0` required by the toolchain.
- `.gitignore` duplicates and dead entries, `vitest.live.config.ts` not type-checked, CI duplicates the `check` script, `scripts/spike.ts` outside the lint guard with a stale default model.

**Performance**
- Agent view re-reads and re-parses the whole session file on every refresh and defeats its own prompt and context caches (`agent-view/index.ts:64-69`, `view.ts:220-256`).
- Spinner frame is `floor(now / 120)` on a 1 s redraw, so it turns backwards (`progress-widget/model.ts:84`, `agent-list-view/view.ts:117`).
- Publisher-side usage dedup is redundant with the ledger; runner state is never pruned and registry scans are O(n) per event.

**Lifecycle robustness**
- `settled` flag never reset (High above); one throwing shutdown handler skips the rest and leaves the Host live (`pi-adapter.ts:92-99`).
- Spawn failure leaks the child session and any created worktree (`pi-child.ts:306-336`, `runner.ts:675-678`).
- Wait slot leak when a `wait: true` caller closes (`runner.ts:807-819`); `checkBatch` early return skips `resolve` at shutdown (`runner.ts:195`); turns that run without a slot (`runner.ts:244-246,863,911-915`).
- Session-limits `phase: "switching"` has no exit if the dispatched command never runs (`limits.ts:143-148`); `runSwitch` is re-entrant; unguarded filesystem calls in event handlers.
- Registry write failures leave inconsistent state (`registry.ts:89-122`).

### Contradictions resolved during review

Do not re-investigate these.
- `disableAll()` on new or resume does not leave plugins off: pi tears down the runtime and re-imports extensions per session, so each session gets a fresh factory call, Host and manager.
- The settings merge onto one object is harmless for the same reason; the remaining issue is a redundant double read of the user file. Subagents `applySettings` is the odd pattern only in theory.
- Discarded `subscribe` handles do not leak: pi tracks event-bus subscriptions and clears them when the context is invalidated (`loader.js:147-149,424`).
- Double counting between main and agents does not happen: this package's tools never set `usage` on tool results, nested agents are separate sessions, and successors have their own ids. The real issue is an undercount of a child's own tool-result usage (`core/adapter/usage.ts:51-68`).
- Most "unused" exports (`usesOsc777`, `pendingLabels`, `toPiResult`, `normalizeUsage`, settings rule types, `statusTool`) are used in their own file; only the `export` keyword is unnecessary. `statusTool` is not registered twice.
- Every README keyboard claim for the agent views matches the key handlers; the `spending:usage` and `session-limits:busy` payloads match on both sides; session-limits retry flow is bounded.

### Suggested order of work

1. Fix the shipped agents' model (inherit) or document the OpenAI requirement (subagents-runtime.md, High).
2. Reset `settled` per prompt in `pi-child.ts`, and make the shutdown handler chain fault tolerant (core.md, High and Medium).
3. Reproduce the held-message double prompt with a live test; then hold messages until streaming or pass `streamingBehavior` (subagents-runtime.md, High).
4. Packaging: fix `files`, add LICENSE, bump version to 0.3.0, drop unused peer deps, set `engines` (docs-and-config.md, High and Medium).
5. Resolve project `disabledPlugins`: read at boot or document and warn; also gate the main prompt on enabled plugins (core.md, subagents-runtime.md).
6. Runner lifecycle fixes: wait slot leak, `checkBatch` shutdown, turns without a slot, registry write failures, spawn-failure cleanup (subagents-runtime.md, Medium; core.md for the child leak).
7. Move shared code to core: handoff validator, `isAhead`, channel names and payload types, `MANIFEST_FILE` (session-limits-and-spending.md, subagents-ui.md).
8. Count child tool-result usage in `sumOwnUsage` and merge the two usage functions (core.md, Medium).
9. Add a `docs/history/` folder; label or move HANDOFF.md, PLAN.md, spike.md, the design note; condense deviations.md; commit ARCHITECTURE.md and STRUCTURE.md (docs-and-config.md).
10. Delete dead production code and unused contract members in one cleanup (see the dead-symbol theme above and the per-document tables).
11. Remove unnecessary `export` keywords in one sweep per document table, keeping the listed test seams.
12. UI performance and polish: skip session parsing when the file is unchanged, fix spinner frames, share one throttle, session-limits stale-context and `switching` exit (subagents-ui.md, session-limits-and-spending.md).

### Open questions

- Does pi's MCP extension open connections during `loader.reload()` in a child? Decides how much a failed spawn leaks. Confirm by a spawn-failure test watching open handles (core.md).
- Can `ChildSession.dispose` be called twice, emitting `session_shutdown` twice? Confirm by stopping an agent during grace and then shutting down (core.md).
- Does `createTranscriptPane.sync` handle a same-length but different item list? Confirm whether agent-view reuses one pane across agents (core.md).
- Held-message double prompt: see High findings (subagents-runtime.md).
- Does pi's `session.abort()` wait for a pending tool promise? If so shutdown stalls up to 5 s per nested `wait: true` tree. Confirm with a live shutdown test (subagents-runtime.md).
- Can `ChildSession.send` reject (steer or follow-up on a disposed session)? Confirm in pi's `_queueSteer` and `_queueFollowUp` (subagents-runtime.md).
- Does pi ever fire `session_start` again on the same extension instance, or does `pi.events` outlive instances? Decides whether the `onSessionStart` resets, the widget interval restart and stale old subscribers matter. Confirm with a probe log across `/new` and `/session-handoff` (subagents-ui.md, session-limits-and-spending.md, subagents-runtime.md).
- Does pi clear widgets from the previous runtime on a session switch? Only matters if the instance is reused (subagents-ui.md).
- Does pi return `tokens: null` right after compaction, leaving a stale footer percentage? Confirm by compacting above `softRatio` (session-limits-and-spending.md).
- Does `/session-handoff` via `sendUserMessage` leave a visible user message? Confirm in a live TUI run. Also, does spending's shutdown persist still have a live context (session-limits-and-spending.md).
- Could a resumed run double count usage under a new runtime token? Confirm whether the registry restores agents on session start (session-limits-and-spending.md).
- Is the package meant for npm, and does pi honour `peerDependencies: "*"` as documented? Confirm with the owner and pi's package docs (docs-and-config.md).

Root doc corrections made alongside this review: ARCHITECTURE.md Settings paragraph (no live reload, pi rebuilds the extension per session), ARCHITECTURE.md test sentence (some tests import adapter modules that load pi), STRUCTURE.md spike.ts comment (it ships).
