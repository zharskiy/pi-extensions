# Existing subagent extensions for pi: survey

Date: 10 October 2026. Target: pi 1.1.0 (`@earendil-works/pi-coding-agent`). Companion to `HANDOFF.md`.

Method:
- Read the official example (`examples/extensions/subagent/`, `handoff.ts`) and the docs (`extensions.md`, `sdk.md`, `packages.md`, `session-format.md`, `message-types.md`) in the local 1.1.0 install.
- Downloaded the npm tarballs of 13 community packages and read their source, not just their READMEs.
- Read the READMEs of about 8 more packages.
- Read the relevant upstream issues on `github.com/earendil-works/pi`. The old `badlogic/pi-mono` repository now redirects there.

Line numbers refer to the npm tarball versions listed. Tarball paths are relative to the package root.

---

## 1. Executive summary

### What the ecosystem has converged on

1. **In-process `createAgentSession` is the default spawn mechanism.** Subprocesses are now the minority.
   - Every actively maintained, popular package runs children through the SDK, with its own `DefaultResourceLoader` and a `SessionManager` per child: nicobailon `pi-subagents` (since 0.65), tintinweb, gotgenes, pi-subagent-manager, arhen, pify, nicknisi, pi-fast-subagent and pi-submarine.
   - Subprocesses survive in three places:
     - The official example: `pi --mode json -p --no-session`.
     - RPC-mode children (narumitw, minghinmatthewlam), which keep a live steer channel.
     - Multiplexer panes (herdsman, herdr-agents, henryqw), which make children real, attachable TUIs.
2. **Agents are markdown files with YAML frontmatter.**
   - Locations: `~/.pi/agent/agents/*.md` (user) and `.pi/agents/*.md` (project). Project files load only when the project is trusted.
   - The body is the system prompt. `name` and `description` are required.
   - Common optional fields: `tools`, `model`, `thinking`, `skills`, `extensions`, `max_turns`, `prompt_mode`/`systemPromptMode` (append|replace), an allowlist of agents it may spawn, and a depth cap.
3. **Background completion wakes the parent through `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.**
   - The result text goes inside the wake message.
   - Some packages coalesce completions: a time window in nicobailon, a spawn-turn group in tintinweb, an outbox flushed on `agent_settled` in arhen, and "Final Recap" in pi-subagent-manager. That last one is the closest to our "wake once per batch".
4. **Children persist as ordinary pi JSONL sessions** with a `parentSession` header, usually in a directory named after the parent session file. They then appear nested in pi's `/resume` and can be resumed by file.
5. **Completion is detected from `agent_settled`, not `agent_end`.** `agent_end` fires before retries and compaction, and several packages reported premature completion until they switched.
6. **Nesting is opt-in and shallow.**
   - The default maximum depth is 2 almost everywhere (nicobailon, tintinweb, LukasParke, minghinmatthewlam).
   - pi-subagent-manager defaults to 3 levels, counting main. johnnywu defaults to 10. pi-submarine hard-caps at 4.
   - Many packages forbid nesting entirely (gotgenes, pify, arhen, nicknisi, narumitw, henryqw).
7. **Nobody implements budget-driven handoff to a successor.**
   - Children rely on pi auto-compaction, plus turn caps with a "wrap up" steer.
   - Two packages come close: herdsman (ADR 0010) and henryqw (`role-tools.ts`).

### What we can reuse and what we must build

| Reuse, as a pattern or near-verbatim | Must build |
|---|---|
| Spawn recipe: `DefaultResourceLoader` + `loader.reload()` + `createAgentSession` + `bindExtensions` (tintinweb, gotgenes, subagent-manager, arhen) | Successor handoff: stop at budget, write a handoff file, spawn a successor, keep the caller asleep. Nobody has it. |
| AsyncLocalStorage guard so the extension does not re-instantiate inside a child (tintinweb `child-context.ts`) | Strict "wake once when every agent in the batch is done", with no timeout-driven partial wakes |
| Fresh `ModelRuntime` per child, replaying parent `registerProvider` calls (gotgenes, arhen) | An effective-system-prompt view: the exact prompt, tools and skills sent to the model. Only johnnywu's `debug: true` file dump exists. |
| Child usage attached to a tool result's `usage`, so pi's own footer and `/cost` include it (tintinweb `reportUsage`; this is the official path in the 1.1.0 docs) | Accurate combined footer for background agents that finish after the spawning tool returned |
| High-water-mark cost ledger per thread id, persisted as custom entries (pi-subagent-manager `cost-ledger.ts`) | Interaction (stop/continue/ask) at every depth with the same components. Only pi-subagent-manager's live view steers nested agents. |
| `session_before_compact` threshold intercept: cancel compaction, tell the agent to hand off (herdsman ADR 0010) | Stop then a grace period for questions, then close: a lifecycle state no one models |
| Budget warning steer, then `setActiveTools([])`, then a forced structured final packet (henryqw `extensions/role-tools.ts`) | Adapter isolation from pi API churn. Everyone calls pi internals directly and pays for it in their CHANGELOGs. |
| Outbox + batched flush on `agent_settled` + receipt confirmation in the `context` event (arhen `delivery.ts`) | |
| Withheld-nudge queue while the parent run is active (gotgenes `observation/notification.ts`) | |
| Cache-retention pinning per child via an `agent.streamFunction` wrapper; tool-declaration pinning on resume (nicobailon) | |
| Event-bus RPC contract `subagents:rpc:*`, which would make `@tintinweb/pi-tasks` work with us for free | |

### Top 5 pitfalls

1. **Waking the parent with `sendMessage({triggerTurn:true})` can bust the parent's prompt cache.**
   - Upstream issues #5581 and #10267 are open on 1.1.0. Runs started by an injected message skip `before_agent_start`, so prompt sections that extensions added there (including pi's built-in `mcp_servers`) are dropped on the second request of the run and re-added on the next user turn.
   - Users report hundreds of full-prefix rewrites, one at about $900 in a week, caused specifically by background-task and subagent notifications.
   - Our wake path must be designed around this. A known workaround is `sendUserMessage` when idle (see section 3).
2. **Child usage is invisible to pi's totals unless it arrives through a tool result.**
   - Custom messages carry no accounted usage; nicobailon's `docs/observability.md` says so explicitly.
   - Background agents that finish after their tool call returned are undercounted by every package except tintinweb, which attaches pending usage to the parent's *next* tool result, and pi-subagent-manager and pify, which show a separate status or footer.
   - The upstream proposals for an extension-facing usage API (#6120, #6509) were not merged in that form. badlogic's direction: "custom entries/messages need to carry optional cost".
3. **In-process children share the host process.**
   - Extension module state is shared, so packages either load no extensions in children or guard against re-entry.
   - Parent-registered providers are missing unless replayed onto the child runtime.
   - Other extensions' `before_agent_start` sections are lost if the child prompt is finalised too early.
   - Child `session_shutdown` must be emitted, or extension resources leak.
   - A crash or OOM takes everything down: #8746 was 20 GB or more with subagents.
   - There is no crash isolation. Abort signals must be wired by hand; the tool signal is aborted once `execute()` returns, so background children need their own `AbortController`.
4. **Lifecycle truthfulness.** Children that die mid-run stay "running" or report "completed" with an empty result (tintinweb #318, #355; official example PR #8250).
   - `stopReason: error`/`aborted` has been reported as success (johnnywu).
   - Compaction aborts a child silently (nicobailon #2537).
   - Results are delivered twice or not at all because of followUp races (gotgenes, arhen, nicobailon #2716 "parents woken by results reply with nothing").
5. **Steering and queue routing.**
   - Upstream #10610: steer and follow-up messages queued while background workflow agents run can be drained into a *subagent's* turn instead of the idle main thread. This happened with a shared-run design (nicobailon workflows).
   - A steer without `triggerTurn` does not wake an idle model (narumitw, nicknisi).
   - Steering a resumed session mid-run fails with "already processing" (arhen).
   - Per-child sessions with explicit routing avoid all three.

---

## 2. Upstream context (pi itself)

### Maintainer stance
Mario Zechner's launch post (https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), section "No sub-agents":
> "You have zero visibility into what that sub-agent does. It's a black box within a black box."
> "If you need pi to spawn itself, just ask it to run itself via bash."
> "Spawning multiple sub-agents to implement various features in parallel is an anti-pattern in my book"

On background bash he writes "Use tmux instead", for observability. Implications:
- Core will not ship subagents. Issue #7412 "Native sub-agent support" was closed as not planned.
- Observability is the community's main criticism of subagents. Our agent view, which shows the full effective prompt and a live transcript, answers that objection directly.

### pi 1.1.0 APIs that matter (verified in the local install)
- **Tool result `usage`.** `docs/extensions.md` L136: "If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate." `AgentToolResult.usage?: Usage` is in `pi-agent-core/dist/types.d.ts` L381, and nested `ctx.executeTool` usage is summed into the caller's. This is the only extension-facing path into session totals that we found.
- **`UsageEntry`** (`docs/session-format.md` L113-121). Entries with `type:"usage"` count toward session totals; cache warming uses them. `SessionManager.appendUsage(kind, provider, model, usage)` exists, but `ReadonlySessionManager`, the type extensions get on `ctx`, does not expose it. So there is no clean extension API for late-arriving background usage. This is a candidate upstream request: it matches badlogic's "fix it in sessions" comment on #6509.
- **`cache_warming_decision`** event and the `cacheWarming` setting. pi-subagent-manager turns warming off for children.
- **`turn_end` / `agent_before_settle`** can append entries and `continue: true` for one more request. This is a natural hook for "write your handoff now".
- **`session_before_compact`** can cancel compaction (`SessionBeforeCompactResult.cancel`). herdsman uses it as the budget trigger.
- **`ctx.ui.custom(..., { overlay: true })`, `setWidget`, `setStatus`, `setFooter`, `registerMessageRenderer`** are the UI primitives every package uses.
- **`examples/extensions/handoff.ts`** (official) serialises the branch with `serializeConversation(convertToLlm(...))`. It asks the model with `ctx.modelRegistry.complete(..., { cacheRetention: "none" })` for a self-contained prompt, then calls `ctx.newSession({ parentSession, withSession })` and pre-fills the editor. This is a reference for the main-session hard-limit handoff.

### Relevant upstream issues

| # | Status | Relevance |
|---|---|---|
| [#5581](https://github.com/earendil-works/pi/issues/5581) | open | `sendMessage({triggerTurn:true})` bypasses `before_agent_start`. On a fresh session the first triggered request can have an empty system prompt (p0's report). Cache busts. |
| [#10267](https://github.com/earendil-works/pi/issues/10267) | open (reopened) | Sections added in `before_agent_start` are dropped on runs not started by a user prompt, which re-bills the whole prompt. Background-task and subagent notifications are the main trigger. Still on 1.1.0, and a fix with a regression test was offered. |
| [#10610](https://github.com/earendil-works/pi/issues/10610) | closed, not planned | Steer and follow-up messages are drained into subagent turns while background agents keep the session run active. |
| [#6120](https://github.com/earendil-works/pi/issues/6120), [#6509](https://github.com/earendil-works/pi/issues/6509) | closed | Proposals for `pi.reportUsage()` / `ctx.ui.setUsage()`. Maintainer: "this needs fixing in sessions. custom entries/messages need to carry optional cost that all cost tracking code paths then need to observe." |
| [#8746](https://github.com/earendil-works/pi/issues/8746) | closed | Children run as `pi --mode json -p` emit `agent_end` carrying the whole session on one line (57 MB). That exceeded the 16 MiB line cap of the child protocol and led to an OOM / revive loop. This is a subprocess-JSON pitfall. |
| [#10359](https://github.com/earendil-works/pi/issues/10359) | closed | pi-agent-core 1.0.0 dropped subpath exports (`./node`), which broke background subagents that imported them. An example of API churn, and why the adapter rule exists. |
| [#8250](https://github.com/earendil-works/pi/pull/8250) | open PR | The official example reports done while still working, loses failure details, and returns a normal-looking result for failed work. |
| [#9906](https://github.com/earendil-works/pi/issues/9906) | closed | The footer shows pay-as-you-go cost for subscription-backed providers. "Accurate regardless of provider" is harder than it looks: `usage.cost.total` is a client-side estimate from the model catalog. |

### `@earendil-works/pi-durable` (experimental, separate runtime)
The README sections "Abort and Subagents", "Child Tasks", "Task Graph", "Usage and Cost" and "Reset and Handoff" describe a first-party design:
- Conversations are owned by tasks. Background anchor tasks survive the parent's abort.
- `waiting` on child tasks uses an `allSettled`/`failFast` policy. That is exactly "wake once when the batch is done".
- `harness.usage()` totals per model and per tool.
- `reset(handoffNote)` handles handoff.

It is not hosted inside the coding agent yet (#10386 is open), so we cannot build on it today. Its concepts (ownership, background boundary, allSettled wait) are a good vocabulary for our caller-agent contract, and a possible future migration target for the adapter.

---

## 3. Extensions, one section each

### 3.1 Official example: `examples/extensions/subagent/` (pi 1.1.0)
- **Where:** `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (index.ts 1038 lines, agents.ts 157). Author: pi maintainers. Maturity: example quality. Open PR #8250 lists its reliability gaps.
- **Spawn:** subprocess, one-shot JSON mode. `index.ts`, `runSingleAgent`:
  ```ts
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  ...
  args.push("--append-system-prompt", tmpPromptPath);
  args.push(`Task: ${task}`);
  const invocation = getPiInvocation(args);   // process.execPath + argv[1], handles bun binaries
  const proc = spawn(invocation.command, invocation.args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore","pipe","pipe"] });
  ```
  It parses stdout lines and collects `message_end` and `tool_result_end` events.
- **Agents:** `agents.ts` uses `parseFrontmatter` with `name`, `description`, `tools` (string or array) and `model`; the body is the system prompt. Files come from `~/.pi/agent/agents` (default) and the nearest `.pi/agents` (with `agentScope: "project"|"both"`, after a confirmation prompt). Sample agents are scout, planner, reviewer and worker. Prompt templates chain them (`/implement` = scout → planner → worker).
- **Modes:** single `{agent, task}`, parallel `{tasks}` (max 8, concurrency 4 through `mapWithConcurrencyLimit`), and chain `{chain}` with a `{previous}` placeholder. The result is the last assistant text, capped at 50 KB per parallel task.
- **Nesting:** none explicit. The child loads the user's extensions, so it could recurse unbounded.
- **UI:** custom `renderResult` with collapsed and expanded (Ctrl+O) views. Tool calls are formatted like the built-ins. A usage line looks like `3 turns ↑in ↓out R W $cost ctx:N model`.
- **Cost:** summed per child from `message_end` usage and shown in the card. It is **not** added to the parent totals: the tool result does not set `usage`.
- **Budget/cache:** none.
- **Pitfalls:** the ones listed in PR #8250, plus the `agent_end` mega-line in #8746 that affects any `--mode json` consumer.
- **Takeaways:** the `getPiInvocation` resolver for spawning pi from inside pi, temp-file prompts with mode 0600, and the SIGTERM → 5 s → SIGKILL abort.

### 3.2 `pi-subagents` (nicobailon), the most featureful
- npm `pi-subagents` 0.77.0, released 2026-10-09, https://github.com/nicobailon/pi-subagents, author Nico Bailon. About 149 releases since January 2026, about 123k lines of JS, and 0 open issues (aggressively triaged; issue numbers exceed #2800). Most of the community knows this one as "pi-subagents". **There is no official badlogic `pi-subagents`**; the package name belongs to nicobailon.
- **Spawn:**
  - Foreground children have been in-process since 0.65.0. `src/runs/shared/child-session.js` L430-442:
    ```js
    const { session } = await pi.createAgentSession({ cwd: launch.cwd, agentDir, modelRuntime,
        ...(resolvedModel?.model ? { model: resolvedModel.model } : {}),
        ...(resolvedModel?.thinkingLevel ? { thinkingLevel: resolvedModel.thinkingLevel } : {}),
        ...(launch.tools ? { tools: launch.tools } : {}), resourceLoader: loader, sessionManager, settingsManager,
        sessionStartEvent: { type: "session_start", reason: "startup" } });
    pinChildCacheRetention(session.agent);
    await session.bindExtensions({ mode: "print", onError: ... });
    ```
  - Background runs use a **detached Node runner process** that hosts in-process sessions (`src/runs/background/async-execution.js` L497-526). It is controlled through files in a run dir: `status.json`, `events.jsonl` and a control inbox. SIGUSR2 was abandoned because of Windows.
- **Agents:** markdown with YAML, scanned recursively from builtin, packages, `~/.pi/agent/agents/**` and `.pi/agents/**`. About 30 frontmatter fields (`docs/agents.md` L362-445), including `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `skills`, `extensions`, `defaultContext: fresh|fork`, `maxSubagentDepth`, `allowedAgents`, `timeoutMs`, `acceptance` and `memory`. Children are narrow by default (replace-mode prompt, no skills catalog). Foreground children never load the parent's extensions because module state would be shared.
- **Modes:**
  - single, parallel (8 tasks / 4 concurrent), chain, fork context, scripted JS workflows in an acorn sandbox, schedules and missions.
  - Background results go out through `pi.sendMessage({customType:"subagent-notify"}, {triggerTurn})` (`src/runs/background/notify.js` L442-466).
  - `completion-batcher.js` batches with a 150 ms debounce, a 1 s max wait and a 2 s straggler window. This is time-window batching, not batch membership.
  - A `bg_wait` tool blocks. Outputs over 2,000 characters return as a preview plus a file path.
- **Nesting:** default depth 2. `PI_SUBAGENT_MAX_DEPTH` sets it at the top level; children carry `{depth, maxDepth}` in runtime config, and an agent's own setting can only lower the limit (`min()`). `allowedAgents` is intersected down the tree. Budgets: `maxSubagentSpawnsPerRun` 64 and `globalConcurrencyLimit` 20.
- **UI:**
  - A 3.7k-line tool renderer, an async widget and a FleetView.
  - `/subagents-fleet` is an inspector with transcript, `s` steer and `D` stop. External panes are supported (tmux, Ghostty, Herdr).
  - `/subagents-detach` sends a foreground child to the background.
  - Children persist under `<parentSessionsDir>/<parentBase>/…` and are resumable.
- **Cost:** per child from `message_end`. `/subagent-cost` and an RPC `cost` method walk the parent branch, tool details and async artifacts. `docs/observability.md` L38 says: "Pi's built-in session totals do not automatically include child usage delivered only by an async completion notification … custom-message API does not carry accounted usage." The CHANGELOG has several undercount fixes (#2484, #2601).
- **Budget:** no handoff. It relies on auto-compaction, with fixes for children aborted by compaction (#2537). `forkContext.mode: "pruned"` summarises a fork down to 64 KiB.
- **Cache** (the best ideas in the ecosystem):
  - `PI_SUBAGENT_CACHE_RETENTION` pins retention per child by wrapping `agent.streamFunction` (`src/shared/child-cache-retention.js`). Children can use a 5-minute retention while the parent uses 1 hour.
  - Forks share a `prompt_cache_key` derived from the parent session id, on OpenAI-family APIs only.
  - **Declaration pinning** (`src/extension/declaration-pinning.js`): resumed sessions keep their original tool text, so upgrading the package does not bust the cache (#2778).
  - The `subagent` tool is active from session start, because adding a tool later busts the cache on most providers.
  - The tool schema was cut from 18.7k to 3.3k characters.
- **Pitfalls** (CHANGELOG):
  - upgrading under a running pi broke child launches through cached extension paths (#2780);
  - parent-registered providers were missing in children (#2730);
  - other extensions' `before_agent_start` sections were lost (#2745);
  - a runner connect timeout;
  - re-rendering long transcripts every 750 ms (#2704);
  - interrupt hitting the wrong run (#2760);
  - result-file races (#2744);
  - two windows sharing one session consumed each other's results (#1225);
  - a double wake with pi-intercom, "Agent is already processing" (fixed with a globalThis wake registry, `Symbol.for("pi-subagents.queued-completion-wakes.v2")`);
  - Windows signals and rename EPERM.
  - Upstream issue #9593 is a third-party "impersonation" package report against this name. #10576 is a crash on session paths containing two consecutive spaces.
- Treat it as **a catalogue of pitfalls, not a design to copy**. Its size is the main argument for our plugin architecture.

### 3.3 `@tintinweb/pi-subagents`, the Claude Code clone
- npm 0.20.0, released 2026-10-09, https://github.com/tintinweb/pi-subagents, author tintinweb, MIT. About 60 releases since March 2026 and about 66 open issues. Requires pi 1.1.0 or newer. Explicitly modelled on Claude Code: an `Agent` tool, background by default, and `get_subagent_result` / `steer_subagent`.
- **Spawn:** in-process. `src/agent-runner.ts` L961-1008:
  ```ts
  const sessionManager = options.resumeSessionFile
    ? SessionManager.open(options.resumeSessionFile, configuredSessionDir ?? defaultSessionDir)
    : persistSession ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir,
        { parentSession: ctx.sessionManager?.getSessionFile?.() })
    : SessionManager.inMemory(effectiveCwd);
  const sessionOpts = { cwd: effectiveCwd, agentDir, sessionManager, settingsManager, modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime }),
    model, tools: sessionTools, customTools: [...nestedTools, ...structuredTools], resourceLoader: loader };
  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));
  ```
  - The loader (L747-758) sets `noContextFiles`, `systemPromptOverride: () => systemPrompt` and `appendSystemPromptOverride: () => []`.
  - The **AsyncLocalStorage guard** (`src/child-context.ts`; `index.ts:305` `if (inChildSessionContext()) return;`) stops the extension factory from building a second manager inside the child.
- **Agents:** `.pi/agents/*.md` > `.agents/agents/*.md` > `$PI_CODING_AGENT_DIR/agents/*.md`. Fields: `tools` (built-ins, `*`, `ext:<ext>/<tool>`), `extensions`, `exclude_extensions`, `disallowed_tools`, `skills`, `memory`, `isolation: worktree`, `model` (fuzzy match), `thinking`, `max_turns`, `persist_session`, `allowed_subagents`, `prompt_mode`, `inherit_context` and `run_in_background`. Frontmatter wins over tool-call parameters. Built-in agents: general-purpose, Explore and Plan.
- **Modes:**
  - background (default) or foreground, resume, cron schedules, and JS workflows in a worker thread;
  - `@handle` mentions route the user's text to an agent: steer it if running, resume it if finished.
  - Wake: `sendMessage({customType:"subagent-notification"}, {deliverAs:"followUp", triggerTurn:true})` with `<task-notification>` XML.
  - **Smart group join** (`src/group-join.ts`): agents spawned in the same turn (100 ms debounce) form a group, and one consolidated message goes out when all finish. A **30 s timeout after the first completion sends a partial**; stragglers are re-batched with a 15 s timeout.
  - Nudges are held for 200 ms so `get_subagent_result` can cancel them.
- **Nesting:** opt-in through `allowed_subagents`, `maxSubagentDepth` default 2 (`src/nested-tools.ts:195`). Nested tools are scoped to ownership. Nested children are hidden from the UI, take no concurrency slot and are never persisted.
- **Concurrency:** background `maxConcurrent` 10 with a queue; open issue #352 says it is ignored. Foreground concurrency is unlimited by default; a cap exists because parallel agents thrash local-model caches (#253).
- **UI:** a widget above the editor (turns, tool uses, tokens, context %, compactions); a FleetView list below the editor; and an overlay **conversation viewer** (`ctx.ui.custom(..., {overlay:true})`) with live scroll, `Enter` to steer and `x x` to stop. Only top-level agents can be steered from the UI.
- **Cost:** a lifetime accumulator. Display tokens exclude `cacheRead` (fix #38: counts were inflated 5-15x). **`reportUsage`** (default off): `PendingUsagePool` (`src/usage.ts:94-130`) collects child spend, and `withUsageReporting` (`index.ts:2284-2293`) wraps *every* tool's `execute` to attach the pending usage to the next tool result. pi then folds it into `getSessionStats()`, the footer and `/cost`. Caveat: background spend appears only on the parent's next tool call.
- **Budget:** `max_turns` with a soft `session.steer("wrap up")`, then a hard abort after `graceTurns` (5). No handoff. Open issue #369: children ignore the model token limit.
- **Cache:** in append mode the parent prompt is placed verbatim first (KV-cache fix, upstreamed from gotgenes). A different tool set means no Anthropic cache reuse across parent and child.
- **Known issues:**
  - #318/#355: a dead child stays "running" or reports an empty "completed".
  - #317: 60 Hz re-renders on text deltas.
  - #356: triggerTurn preempts retry backoff.
  - #368: resumed agents get stuck.
  - #305: thinking level is not inherited.
  - #242: child `session_shutdown` never fired.
  - #44: Esc did not abort children.

### 3.4 `@gotgenes/pi-subagents`, a hard fork with a minimal core
- npm 23.4.0, released 2026-10-09, https://github.com/gotgenes/pi-packages (`packages/pi-subagents`), author Chris Lasher. **Most downloaded** (about 19k per month per pi.dev). 229 releases, ADRs, and about 994 tests by its own count.
- **Spawn:** in-process behind an IO seam. `src/lifecycle/create-subagent-session.ts` L280-301:
  ```ts
  const sessionManager = deps.io.createSessionManager(cfg.effectiveCwd, sessionDir);
  sessionManager.newSession({ parentSession: params.parentSession?.parentSessionId });
  const { session } = await deps.io.createSession({ cwd: cfg.effectiveCwd, agentDir, sessionManager,
    settingsManager: sessionSettings, modelRegistry: snapshot.modelRegistry, model: cfg.model,
    tools: [...toolNames, ...childTools.map((t) => t.name)], customTools: childTools,
    excludeTools: EXCLUDED_TOOL_NAMES, resourceLoader: loader, thinkingLevel: cfg.thinkingLevel });
  ```
  - `deps.io.createSession` (`src/index.ts:138-165`) builds a **fresh `ModelRuntime`** and replays the parent's `pi.registerProvider` registrations (#812).
  - It emits `subagents:child:session-created` before `bindExtensions` and `bound` after, so policy extensions can hook the child.
- **Agents:** `.pi/agents/*.md` and `$PI_CODING_AGENT_DIR/agents/*.md`. Fields: `description`, `tools` (complete allowlist), `model`, `thinking`, `max_turns`, `prompt_mode` (append by default), `inherit_context`, `run_in_background` and `locked`. The caller wins over the file unless a field is `locked`. Tool policy is delegated to `@gotgenes/pi-permission-system`, keyed on an `<active_agent>` tag.
- **Modes:**
  - foreground (default) or background, resume, and `get_subagent_result {wait, timeout}`.
  - Child tools: `ask_parent` (the child ends its turn with a question) and `notify_parent` (an update mid-run).
  - Notifications are per agent; there is no group join. **While the parent run is active, nudges are withheld** in a local queue and flushed on settle, after re-checking `consumed`/`claimed` (`src/observation/notification.ts:220-410`). This prevents double delivery.
- **Nesting:** none. The subagent tools are excluded in every child (#264). Background `maxConcurrent` is 4.
- **UI:** a widget (provider/model, context %, turn budget) and inline renderers. `/subagents:sessions` is a read-only transcript viewer; ADR 0007 deliberately avoids an overlay and steering, and ADR 0004 removed tintinweb's FleetView and conversation viewer. Children are always persisted at `<parent-dir>/<parent-basename>/tasks/`.
- **Cost:** tokens only. No dollar cost and no footer aggregation.
- **Budget:** a hard turn ceiling. `wrapUpTurns` (2) injects an "N turns left" context message without forcing a turn, then aborts. No handoff.
- **Cache:** the most careful analysis in the ecosystem (ADRs 0006/0008/0009/0011, `docs/configuration.md` "What a child inherits"):
  - A child inherits only the **stable identity layers** of the parent prompt, byte for byte: the pi preamble and `<project_context>`. Volatile sections are rebuilt.
  - The README states that Anthropic caches tools *before* the system prompt, so a child with a different tool set shares nothing with its parent. The benefit applies mostly to local inference.
  - It warns extensions not to edit the inherited region (#890).
- **Pitfalls:** child `session_shutdown` was never emitted, which leaked resources until a bounded shutdown emitter was added; the recursion guard was lost on tool refresh; a failed compaction erased the error (#898); `before_agent_start` appenders gated on UI state append nothing in children.

### 3.5 `@tintinweb/pi-tasks`, a task DAG that drives subagents over the event bus
- npm 0.9.0, 2026-08-24, https://github.com/tintinweb/pi-tasks. Claude Code's TaskCreate/List/Get/Update/Output/Stop/Execute, with `blocks`/`blockedBy`.
- It spawns nothing itself. `TaskExecute` makes a request/reply RPC over `pi.events` (`src/index.ts:185-226`):
  ```ts
  const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw) => { ... });
  pi.events.emit(channel, { requestId, ...params });   // channel = "subagents:rpc:spawn" | ":stop" | ":consume" | ":ping"
  ```
  It listens for `subagents:completed`/`failed` to auto-cascade to dependent tasks, and `subagents:rpc:consume` suppresses the pending followUp.
- It only works with tintinweb; gotgenes dropped the RPC. **If we implement `subagents:rpc:*` plus the `subagents:ready` handshake, pi-tasks works with our extension.** It also shows an ephemeral `<system-reminder>` injected through the `context` event, which changes only the tail of the prompt.

### 3.6 `pi-subagent-manager` (championswimmer), the closest to our view model
- npm 0.21.0, 2026-10-10, https://github.com/championswimmer/pi-subagent-manager, author Arnav Gupta. About 14k lines of TypeScript. Requires pi 0.99.2 or newer. Scripted-provider SDK tests.
- **Spawn:** in-process. `src/orch/runtime.ts` L399-462:
  ```ts
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    systemPrompt: [options.type.systemPrompt, `Your thread path is ${options.path}.`, ...].join("\n\n"),
    appendSystemPromptOverride: () => [],
    extensionFactories: [ /* codemode/tool_search per child */, (pi) => {
      pi.on("turn_end", pauseBoundary); pi.on("agent_before_settle", pauseBoundary);
      pi.on("tool_call", (e) => allowed.has(e.toolName) ? undefined : { block: true, reason: "..." }); } ] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: ctx.cwd, agentDir, modelRuntime: runtime, model, thinkingLevel,
    scopedModels, settingsManager, resourceLoader: loader, sessionManager, tools: toolNames, customTools });
  await session.bindExtensions({ mode: "print" });
  session.setActiveToolsByName(activeToolNames);
  ```
  - The prompt is fully replaced. A child starts from a frozen snapshot of its parent's conversation, which is fork-like.
  - It wraps `agent.streamFunction` to enforce the model policy and patches `agent.finishTurn` so a pause stops at a turn boundary. The source comments that `continue:false` alone was insufficient on 0.99.2.
- **Agents:** YAML frontmatter: `name`, `description`, `models` (an ordered preference list), `thinkingLevel`, `color`, `icon` and `tools: {allow, block}`. User files live in `~/.pi/agent/subagent-manager/agents/` and project files in `.pi/agent/subagent-manager/agents/`. A **`<name>.yml` overlay** tweaks a bundled agent's settings and keeps receiving upstream prompt updates; `<name>.md` forks it. `/agents types` is a TUI editor.
- **Modes and wake:**
  - Tools: `agent_spawn {path, type, task, wait?}`, `agent_wait`, `agent_steer`, `agent_status`, `agent_stop` and `agent_output` (paged), plus child-side `agent_update`/`agent_pause`.
  - Async events are posted as hidden `sendMessage(…, {triggerTurn:false})`. Then **one coalesced `triggerTurn:true` wake** fires after the parent is idle (`src/index.ts:238-290`).
  - The labs **"Final Recap"** setting holds wakes until *all* outstanding async agents finish (`index.ts:300-360`).
- **Nesting:** path-tree addressing (`/root/a/b`). `maxLevels: 3` includes main, with `maxConcurrent: 16` and `maxThreads: 64` (`src/prefs/settings.ts:61-63`). An agent addresses only its own descendants.
- **UI:**
  - An "Agents" tree widget, and `/agents tree` fullscreen.
  - Enter opens a **live transcript view with a Steer input that works at any depth** (`src/ui/live-agent-view.ts`).
  - Children are normal JSONL sessions with `parentSession`. The registry and pending steers are persisted as custom entries (DurableMailbox). After a reload, interrupted work comes back **paused**, never restarted automatically.
  - There is no effective-system-prompt view.
- **Cost:** `src/orch/cost-ledger.ts` stores a `pi-subagent:cost:v1` custom entry per thread, kept as a high-water mark so duplicates and branch rewinds are harmless:
  ```ts
  this.totals.set(data.threadId, Math.max(this.totals.get(data.threadId) ?? 0, data.totalUsd));
  ```
  It is shown through `setStatus`, a `pi-footer` event or its own `setFooter`, as subagents-only or as the total. It does not change pi's native stats.
- **Cache:** child cache warming is off. There is no shared prefix with the parent. A scoped-model `setModel` mid-run would bust the cache.
- **Limitations:** tool policy is not a sandbox; children load no skills; the `/agents` command clashes with other extensions; `pi --continue` may pick a child session; don't open a child session while the parent is driving it.

### 3.7 `pi-herdsman` (boadij), processes in multiplexer panes with the best cache and budget discipline
- npm 0.24.0, 2026-10-10, https://github.com/boadij/pi-herdsman, Apache-2.0. Pinned to pi 1.1.0 and herdr 0.9.3 by sha256. More than 19 ADRs and Linux/macOS/Windows CI.
- **Spawn:** a full interactive `pi` in a herdr pane (`dist/index.js:3182`):
  ```js
  started = await runHerdr(pi, ctx, ["agent","start",attempt.herdrAgent,"--kind","pi","--pane",paneId,
    "--timeout",String(...),"--", ...(options.extensionPath ? ["--extension", options.extensionPath] : []),
    "--extension", HERDR_AGENT_STATE_EXTENSION, ...options.agentArgs ?? []], {...});
  ```
  Pi arguments are built from frontmatter: `--model`, `--thinking`, `--append-system-prompt|--system-prompt`, `--tools`, `--no-skills`, `--no-extensions`, and `--append-system-prompt '<active_agent name="X"/>'`. The user can focus the pane and type into any agent.
- **Agents:** strict frontmatter including `systemPromptMode`, `tools`/`excludeTools`, `skills`/`inheritSkills`, `extensions`/`noExtensions`, `agents` (delegation allowlist) and `inheritProjectContext`. Whole-line `@file` includes are allowed. Precedence: bundled < project < **global** (user policy wins).
- **Modes:**
  - Always async. `delegate_agent` returns once the task is recorded durably, and the controller is told not to poll.
  - Results go through a file mailbox, are delivered **exactly once** as `followUp` + `triggerTurn` (`dist/index.js:7318`), and are kept as `result:<agent>#<n>` artifacts that can be forwarded as evidence.
  - No batching.
  - Tools: `continue_agent`, `steer_agent`, `interrupt_agent`, `reply_agent`, `close_agent`, `inspect_agent`, `read_agent_transcript` and `ask_owner`.
- **Nesting:** a hard 2-level tree: lead → delegating agent → leaf. A delegating agent cannot publish its result while a child is active or undelivered. Close cascades.
- **Cost:** `/herdsman stats` sums native usage over the current session plus transitively owned child session files, deduplicated, with a per-model breakdown. It is on demand, not live, and warns "Coverage incomplete".
- **Budget (ADR 0010, `dist/index.js:15927-15965`):** on `session_before_compact` with `reason === "threshold"`, it appends a retirement marker, **cancels the compaction** and injects hidden guidance telling the agent to finish the current coherent operation and return a self-contained handoff. Overflow still lets emergency compaction run. A retired session cannot be continued; a fresh agent receives the handoff files. This is the closest thing to our successor model.
- **Cache (ADR 0009):** "Preserve prompt-cache continuity" is a first-class rule:
  - context is append-only;
  - no transient per-request injection;
  - stable tool definitions and order;
  - stable leading instructions.
- **Pitfalls:** `docs/guides/recovery.md` lists the failure states of process and pane orchestration: `unknown`, `lost`, `settling`, `pane_not_ready` and rollback after a partial start. Steering is at-least-once.

### 3.8 `@arhen/pi-core-subagent`: DAG scheduler, most robust batched wake
- npm 1.3.68, 2026-10-08, https://github.com/arhen/pi-extensions (`packages/core/pi-core-subagent`), MIT.
- **Spawn:** in-process. `src/manager.ts` L603-628:
  ```ts
  const loader = new DefaultResourceLoader({ cwd: childCwd, agentDir: getAgentDir(), noExtensions: true,
    extensionFactories: await codemodeFactories(),
    appendSystemPromptOverride: (base) => [...base, [prompt?.trim(), subagentInstruction].filter(Boolean).join("\n\n")] });
  await loader.reload();
  const created = await createAgentSession({ cwd: childCwd, agentDir: getAgentDir(),
    modelRuntime: await createChildModelRuntime(ctx), resourceLoader: loader,
    sessionManager: resume ? SessionManager.open(resume.sessionFile, undefined, childCwd)
      : SessionManager.create(childCwd, undefined, { parentSession: getParentSessionFile(ctx) }),
    model, thinkingLevel, tools, customTools });
  ```
  Children keep pi's default prompt, so context files and skills still load. Non-default models are **probed before use** and fall back to the session model.
- **Agents:** usually invented inline per call. Optional files are matched by **description token overlap** with the goal, not by name. They are searched in `.agents/agents`, `.claude/agents` and `.pi/agents`.
- **Modes:** one wave scheduler covers single, parallel, chain and a graph with `needs` edges. Upstream outputs are prepended to the prompts of dependent tasks, as `## Output of <id>` blocks. Up to 16 tasks, with concurrency 3 by default. Everything runs in the background, with an optional `autoAwait`.
- **Child tools:** `ask_parent` (blocking, delivered as an `[URGENT]` steer), `notify_parent {final}` and sibling messaging.
- **Wake** (`src/delivery.ts:436-470`): completions sit in an outbox, flushed on `agent_end`/`agent_settled` as **one batched `sendUserMessage`**. Each notice is **confirmed against the leader's finalized context** in the `context` event, re-queued if dropped, and suppressed if the leader already read the result. Sending a user message also happens to avoid the `triggerTurn` / `before_agent_start` cache bug.
- **Nesting:** none.
- **UI:** a throttled widget (about 6 updates per second), a graph render in `renderCall`, and `/subagents peek`, a read-only tail of a child's JSONL with abort.
- **Cost:** per-run aggregate shown in the summary and widget, not in the footer.
- **Budget:** wall clock only (1 h auto, 6 h ceiling).
- **Cache risk:** `presentation.sync()` on `turn_start` can call `setActiveTools`, which changes the tool list mid-run.

### 3.9 `@pify/subagent`: in-process, child cost in the footer
- npm 0.19.0, 2026-10-01, https://github.com/pifydev/subagent. Part of a suite (`@pify/swarm`, `@pify/workflow`, `@pify/usage`).
- **Spawn:** in-process, `extensions/subagent.ts:313-346`, with `SessionManager.inMemory`, `noExtensions` and `await loader.reload()`. Its comment: "a passed-in loader is not auto-loaded -> child ran with NO prompt". **Gotcha:** the `tools` allowlist also filters `customTools`, so any custom tool must be listed by name.
- **Agents:** `.pi/agents` > `<agentDir>/agents` > builtins (reviewer, scout, worker). Fields: `tools`, `model`, `thinking`, `max_turns`, `system_prompt_mode` and `inherit_skills`. With no `tools`, the agent is read-only. Project definitions need a separate consent prompt.
- **Wake:** one message per run, a **steer on failure and a followUp on success**, both with `triggerTurn`. The `.then` chain is wrapped because after `/reload` the captured `ctx` throws "ctx is stale" and would otherwise crash. Background delivery is impossible under `pi -p`.
- **Cost:** `addChildSpend` writes to a process-wide store under `Symbol.for("pify.child-cost")` on `globalThis`, because jiti gives each extension its own module realm. `@pify/usage` renders ` · agents $…` in the footer. Tokens are counted as `input+output+cacheWrite`.
- **Budget:** a turn cap with a wrap-up steer one turn early, plus a `LoopGuard` stall detector and a 60-minute deadline.
- **Cache:** `@agent` mentions are injected as a hidden custom message from `before_agent_start`, never as a system-prompt edit.
- **Pitfalls (README):**
  - Esc must abort children and their helpers.
  - Extract the last message *with text*.
  - An empty report must not render as "running".
  - Child text is neutralised so it cannot close `<subagent_result>` or inject `<system-reminder>`.

### 3.10 `@narumitw/pi-subagents`: RPC-mode subprocesses
- npm 3.1.1, 2026-10-02, https://github.com/narumiruna/pi-extensions. Minimalist and security-focused.
- **Spawn:** `src/process.ts:92-114`:
  ```ts
  const args = ["--mode","rpc","--no-session","--no-extensions","--no-skills","--no-prompt-templates",
    "-e", childCommunicationBridgePath()];
  ... args.push("--model", request.model, "--thinking", request.thinkingLevel, request.projectTrusted ? "--approve" : "--no-approve");
  args.push("--tools", selectedChildTools(request).join(","));
  // env: PI_SUBAGENT_DEPTH incremented; spawn(..., { detached: true, stdio: [pipe x4/5] }) — extra FDs carry broker credentials
  ```
  RPC commands used: `prompt`, `steer`, `get_state`. Settlement comes from the `agent_settled` RPC event. Kill is SIGTERM to the process group, then SIGKILL.
- **Agents:** none. The task text is the specialisation and the model is always the parent's.
- **Modes:** background only, with `MAX_ACTIVE_JOBS=8`. Two-way messaging uses a loopback TCP broker with per-job tokens passed through an inherited FD. Completion is a `steer` **without triggerTurn**, so an idle parent is not woken; the README admits this.
- No cost, nesting, persistence or cache handling.
- **Pitfalls:** process-local `--api-key` and in-memory providers are unavailable in the child; Windows command-line length; a readiness probe is needed before the first steer; a generation counter drops stale deliveries after a reload.

### 3.11 `@nicknisi/pi-subagents`: small, in-process, child sessions dual-written
- npm 0.4.2, 2026-09-29, https://github.com/nicknisi/pi-extensions (`packages/subagents`). The spawn runtime lives in `@nicknisi/pi-shared`.
- **Spawn:** in-process `createAgentSession` through `createSubagentRuntime` (`index.ts` L1366), with in-memory sessions. Background runs get **their own `AbortController`**, aborted on `session_shutdown`. They deliberately get no tool signal because "pi aborts tool signals once execute() returns" (`index.ts` L1147-1166).
- **Agents:** flat frontmatter, ignoring unknown keys, so agent files from other harnesses load. `skills` are resolved from the parent's catalog via `pi.getCommands()`.
- **Modes:** `dispatch` runs up to 8 tasks. Mutating tasks run sequentially or in a git worktree that produces a `.patch`; `/patches` applies it. Background completion is a notice **without triggerTurn and without the result text**, so the model has to poll `fleet`.
- **Persistence:** child transcripts are **dual-written as native pi sessions** with `parentSession`, so they appear in `/resume`/`/tree` and can be forked. A startup reaper marks runs whose host PID is dead as aborted.
- **Cost:** tokens only. No nesting by design. Its README notes that `pi -p` run through bash escapes the recursion guard.

### 3.12 `@johnnywu/pi-subagents`: JSON subprocesses, configurable depth, a prompt debug dump
- npm 2.2.3, 2026-09-18, https://github.com/jwu/pi-subagents.
- **Spawn:** `extensions/subagent-executor.ts:529-565`:
  ```ts
  const args = [...(pi.entryPoint ? [pi.entryPoint] : []), '--mode','json','-p','--no-skills','--no-prompt-templates'];
  if (options.agent.model) args.push('--model', options.agent.model);
  args.push('--thinking', options.agent.thinking);
  if (options.agent.tools.length > 0) args.push('--tools', options.agent.tools.join(','));
  args.push(options.agent.systemPromptMode === 'append' ? '--append-system-prompt' : '--system-prompt', promptFilePath);
  args.push('--session-dir', subagentSessionDir(options.cwd, options.agentDir));
  if (options.session?.effective === 'fork' && options.session.file) args.push('--session', options.session.file);
  const env = { ...process.env, PI_SUBAGENT_DEPTH: String(options.depth ?? 1), PI_SUBAGENT_MAX_DEPTH: String(options.agent.maxDepth), ... };
  ```
- **Agents:** frontmatter fields `name`, `description`, `tools`, `model`, `thinking`, `systemPrompt` (append|replace|replace-all), `skills` (wildcards), `allowedAgents`, `maxDepth` (default 10) and **`debug: true`**. With `debug`, the child writes its effective system prompt (`ctx.getSystemPrompt()`) to `debug-system-prompt.md`. In replace modes it re-injects pi's "Available tools" and "Guidelines" blocks through `before_agent_start`.
- **Modes:** foreground only. Parallelism comes from pi running tool calls in parallel. `session: "fork"` branches the parent at its leaf.
- **Cost:** a per-child usage line in the render only.
- **Pitfall fixed:** `stopReason: error/aborted` used to be reported as success.

### 3.13 `pi-herdr-agents`: full pi in Herdr panes
- npm 3.2.1 (v3.2.0 released 2026-10-09), https://github.com/giuseppecrj/pi-herdr-agents.
- **Spawn:** `pi --session <file> -e child/subagent-done.ts --model … --thinking …` is sent to a pane with `herdr pane run`. The child extension writes a `<session>.exit` sidecar on **`agent_settled`** and calls `ctx.shutdown()`. The parent watches the files and reconciles every 4.8 s.
- **Modes:** everything is async, with persistent specialists (cap 3, busy rejection), resume and worktree isolation. Wake: one `subagent_result` message per child, **steer + triggerTurn, with the result inline**. An earlier version sent a bare "look at the adjacent message" wake and produced empty turns.
- No depth limit and no cost aggregation.
- **Pitfalls:** premature completion during compaction (#17), which is why it uses `agent_settled`; PID-reuse-safe kill (process identity: PID, start time, boot ID); a launch-policy sidecar so a resume cannot widen tools.

### 3.14 `@henryqw/pi-subagent`: checked task graphs and a budget handoff template
- npm 26.5.0, 2026-10-10, https://github.com/HenryQW/pi-harness. Peer dependency **pi ^1.1.0**.
- **Spawn:** three paths:
  - a `pi --mode json -p --no-session` pool (`dist/ephemeral.js:384-405`);
  - Herdr tabs running `--session <file>`;
  - Herdr worktrees.

  Children always get `--no-extensions` plus only the extensions the role declares.
- **Agents ("roles"):** `~/.pi/agent/config/pi-subagent/*.md`. Fields: `modelClass` (fast/balanced/frontier/fav), and required `tools[]`, `extensions[]` and `skills[]`.
- **Modes:** `delegate_task` direct (single, parallel or chain) or an isolated DAG. **One followUp when the whole workflow finishes** (`extensions/subagent.ts:526-531`).
- **Budget** (`extensions/role-tools.ts:96-178`): the child reads `{maxTurns, maxTokens, maxMs}` from an environment variable and counts tokens on `turn_end`.
  - At **80%** it steers a warning with `triggerTurn:false`.
  - At `maxTurns-1` or when the token budget is crossed, it calls **`pi.setActiveTools([])`** and steers a forced **final handoff packet**: `Status | Outcome | Evidence | Blocker | Risk | Suggested next`.

  This is the best existing template for our ~100k → handoff. One caveat: `setActiveTools([])` changes the tool list and therefore busts the cache on the final request. That is acceptable because it is the last request.
- **Pitfalls:** an `agent_settled` with `aborted:true` is a failure even when the exit code is 0; partial trailing JSONL lines; 16 MiB caps on session reads; a process-lease FD to prove descendant processes are dead.

### 3.15 Smaller or README-only packages
- **`pi-fast-subagent`** (tuansondinh, 0.9.4, 2026-06): in-process `createAgentSession`. Frontmatter `maxDepth` defaults to 0, so an agent cannot spawn unless allowed. **Ctrl+Shift+B moves a running foreground subagent to the background.** Background results are posted as a follow-up. The default of all parent extensions in a child adds startup and prompt cost; `tools: builtins` is the lean mode.
- **`pi-submarine`** (Daniel Nouri, 0.4.0, 2026-09-25), described in the post "The minimal case for a minimal subagents implementation in Pi" (https://danielnouri.org/notes/2026/08/06/the-minimal-case-for-a-minimal-subagents-implementation-in-pi/):
  - foreground only, in-process, fresh or `context: "fork"`, `subagent_resume({sessionId, message})`;
  - **nesting deeper than 4 is rejected**;
  - artifacts go to `<parent>.jsonl.subagents/manifest.jsonl` + `<child>.jsonl`, plus an append-only `<parent>.jsonl.subagents.md` status stream suitable for `tail -f`;
  - progress includes `contextUsage` from `AgentSession.getContextUsage()`;
  - it refuses silent model fallback;
  - its README notes that nested subagents share the event loop and that there is no wall-clock timeout.
- **`@mjakl/pi-subagent`** (3.1.0, 2026-10-02): RPC-mode children, named persistent sessions (`session: "api-review"`), an inactivity watchdog on RPC stdout, and a `sessionHint` frontmatter field. Its 3.1.0 upgrade notes warn against running old and new extension versions against the same child session.
- **`pi-subagents` by minghinmatthewlam** (README): invisible `pi --mode rpc` children with `spawn_agent`/`send_input`/`wait_agent`/`close_agent`/`resume_agent`, a `<subagent_notification>` wake, and `PI_SUBAGENT_MAX_DEPTH` defaulting to 2. This is the Codex-style tool set.
- **`pi-subagent` by LukasParke** (README; also the author of upstream #6509):
  - RPC children, completion on `agent_settled`, and `async:true` with `status`/`wait`/`cancel`/`steer`;
  - a **batched followUp**; `maxDepth` 2; `maxActiveProcesses` 4 and a machine-wide `maxGlobalActive` of 16;
  - "On Pi builds after v0.80.10, delivered runs also report usage natively, so Pi's own totals include subagent spend once per run" (most likely through tool-result `usage`);
  - a `/subagent-cost` command.
- **`pi-inclusive-cost`** (serhii-chernenko, 0.1.2): the footer adds `incl $X` by walking child session files. It finds them as nested `<root-session>/**/session.jsonl` and as flat siblings whose header has `parentSession`. It sums `usage.cost.total`. It warns that this is a client-side estimate from the model catalog and that nicobailon's artifacts-only mode is invisible to it. **Lesson: persist every child as a real session linked by `parentSession`, and cost becomes recoverable by any tool.**
- **Handoff and context packages:**
  - the official `handoff.ts`;
  - `pi-handoff` (default-anton), a `/handoff` command that sends immediately;
  - `pi-continue` (Tiziano-AI): mid-turn continuation using the native compaction threshold (`contextWindow - reserveTokens`). It writes a strict JSON "Continuation Ledger" into the compaction summary and an artifact at `.pi/continue/<session>.md`, and resumes **in the same session** only after it has verified the compaction entry;
  - `pi-sessions` (search, ask, handoff).

  The community's "handoff" is either a model-generated note in a new session or a structured compaction. No one combines it with subagents.

---

## 4. Comparison table

Abbreviations: IP = in-process `createAgentSession`; SP-json = `pi --mode json -p`; SP-rpc = `pi --mode rpc`; Pane = interactive pi in a herdr/tmux pane.

| Package (version) | Spawn | Agent defs | Modes | Parent wake for background | Batch wake once | Nesting default / cap | User steer / stop from UI | Child sessions persisted | Cost into parent footer | Budget / handoff | Cache care |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Official example (1.1.0) | SP-json | md+YAML, 4 fields | single/parallel/chain | n/a (foreground) | n/a | uncontrolled | Ctrl+C only | no (`--no-session`) | no | none | none |
| nicobailon pi-subagents 0.77.0 | IP (fg), detached runner hosting IP (bg) | md+YAML, ~30 fields | all + workflows | followUp+triggerTurn | time window 150 ms–2 s | 2 / config | fleet: steer, stop, detach | yes, resumable | no (`/subagent-cost` only) | compaction only | strong: retention pin, decl pinning, fork key |
| tintinweb 0.20.0 | IP + ALS guard | md+YAML, rich | bg default, fg, schedule, workflow | followUp+triggerTurn | group join, 30 s partial timeout | off; 2 when allowed | overlay viewer: steer, stop (top level only) | yes, nested in `/resume` | yes, via next tool result (`reportUsage`) | max_turns wrap-up | parent prompt verbatim first |
| gotgenes 23.4.0 | IP + fresh ModelRuntime | md+YAML, `locked` | fg/bg, resume | followUp, withheld while parent busy | no (per agent) | none | read-only viewer | always | no (tokens only) | hard turn cap | identity-layer inheritance, ADRs |
| pi-subagent-manager 0.21.0 | IP, fork-like context | md+YAML + `.yml` overlay | spawn/wait, tree | hidden msgs + one coalesced wake; Final Recap | yes (Final Recap, labs) | 3 incl. main / config | live view with steer at any depth | yes + durable mailbox | yes (own status/footer, HWM ledger) | none | warming off |
| pi-herdsman 0.24.0 | Pane | md, strict | async only | followUp+triggerTurn per result, exactly once | no | 2-level hard tree | attach pane, steer/interrupt tools | yes | on demand `/herdsman stats` | **compaction intercept → handoff** | **ADR 0009** |
| arhen pi-core-subagent 1.3.68 | IP | inline + description-matched files | DAG waves | **outbox → one `sendUserMessage`, receipt-confirmed** | per flush | none | peek (read-only), abort | yes | no | wall clock | risk: per-turn setActiveTools |
| pify subagent 0.19.0 | IP, in-memory | md+YAML | fg/bg | steer (fail) / followUp (ok) | no | none | none (widget) | no | yes (globalThis cost bus) | turn cap + wrap-up | hidden msgs, no prompt edits |
| narumitw 3.1.1 | SP-rpc | none | bg only | steer, **no triggerTurn** | no | none | no | no | no | none | none |
| nicknisi 0.4.2 | IP | flat md | dispatch, fleet | notice, no wake | no | none | radar overlay, cancel | dual-written native sessions | no | none | none |
| johnnywu 2.2.3 | SP-json | md+YAML, `debug` | fg single | n/a | n/a | 10 / env vars | no | yes | no (card only) | none | fork shares prefix |
| pi-herdr-agents 3.2.1 | Pane | md, strict | async, persistent | steer+triggerTurn with inline result | no | unbounded | attach pane, interrupt | yes | no | none | none |
| henryqw pi-subagent 26.5.0 | SP-json pool / Pane | roles md | DAG, chain, parallel | one followUp per workflow | **yes (per workflow)** | none | menu, tabs | yes (leases) | no | **80% warn → tools off → handoff packet** | none |
| pi-fast-subagent 0.9.4 | IP | md+YAML, `maxDepth` | fg/bg, detach key | followUp | no | 0 / per agent | Ctrl+Shift+B to background | ? | no | none | none |
| pi-submarine 0.4.0 | IP | md | fg only, fork, resume | n/a | n/a | cap 4 | no | yes + manifest + md log | no | none | fork shares branch |
| LukasParke pi-subagent | SP-rpc | md | async, steer | batched followUp | yes (batched) | 2 | overlay: steer/apply/discard | artifacts | yes (native, via tool usage) | none | ? |

---

## 5. Design implications for our extension

1. **Spawn in-process, behind the adapter.**
   - Use `DefaultResourceLoader` + `await loader.reload()` + `createAgentSession` + `session.bindExtensions`, with a `SessionManager.create(cwd, dir, { parentSession })` per agent. This is the converged and fastest path. It gives `steer`/`followUp`/`abort`/`getContextUsage` directly and needs no IPC.
   - Mitigate the shared-process risks in the adapter:
     - an AsyncLocalStorage child guard (tintinweb);
     - a fresh `ModelRuntime` with provider replay (gotgenes, arhen);
     - a bounded `session_shutdown` before `dispose`;
     - a per-agent `AbortController` that does not depend on the tool signal (nicknisi).
   - Keep a subprocess (`--mode rpc`) implementation possible behind the same adapter contract for crash isolation later. narumitw and LukasParke show the RPC protocol is sufficient for steer, settle and state.
2. **One agent = one persisted pi session**, stored under `<parent-session-dir>/<parent-basename>/agents/`, with a `parentSession` header and a sidecar manifest (status, parent id, depth, batch id, handoff predecessor and successor). This makes agents viewable in pi's `/resume`, recoverable by tools like pi-inclusive-cost, and gives "closed is final" an on-disk meaning. Mark agents interrupted by a reload as closed or failed; never auto-restart them (pi-subagent-manager pauses them, nicknisi reaps them).
3. **Batch wake must be membership-based, not time-based.**
   - Model a batch as a set of agent ids with an `allSettled` policy (pi-durable vocabulary). Hold completions in an outbox and send **one** wake when the last member settles, with no partial-timeout wake (unlike tintinweb).
   - Withhold while the caller is mid-run (gotgenes) and flush on `agent_settled`.
   - Put the bounded results, or file paths for large ones, inside the wake message (herdr-agents' lesson).
   - Confirm receipt in the `context` event (arhen).
   - For child callers the wake is just `session.followUp(...)` on the parent `AgentSession`, so it is the same code at every level.
4. **Wake the main session without busting its cache.** Issues #5581 and #10267 are open on 1.1.0.
   - When the main session is idle, prefer `pi.sendUserMessage` (it runs `before_agent_start`) over `sendMessage({triggerTurn:true})`.
   - Never add `before_agent_start` system-prompt sections of our own that would flap.
   - Make the wake path an adapter function so we can switch when upstream fixes it.
   - Test with a cache-read assertion: the harness should compare `cacheRead` before and after a wake.
5. **Spending: two channels, one ledger.**
   - (a) For synchronous waits, return the agent's usage as the tool result's `usage`. This is the documented path, and pi's footer and `/cost` include it.
   - (b) For background agents, keep a per-agent high-water-mark ledger persisted as custom entries (pi-subagent-manager). Deliver the not-yet-reported usage on the next tool result we own: the collect or `agent_status` tool, or a tintinweb-style wrapper.
   - Render our own spending footer segment as main + all agents from the ledger.
   - Count `cacheRead` in cost but not in "token" displays (tintinweb #38).
   - Note in the UI that `usage.cost.total` is pi's catalog estimate (#9906, pi-inclusive-cost). "Accurate regardless of provider" means "consistent with pi's own accounting".
   - File an upstream request for an extension-facing `appendUsage`, matching badlogic's "fix in sessions" direction.
6. **Handoff at budget: combine herdsman's trigger, henryqw's protocol and our successor.**
   - Measure context with `session.getContextUsage()` on `turn_end`.
   - At the soft threshold, steer a warning with no turn trigger.
   - At the budget, either intercept `session_before_compact` (reason `threshold`; cancel it) or act on `turn_end` before pi compacts. Steer a "write the handoff file now" instruction with a fixed schema (Status / Outcome / Evidence / Blocker / Next, plus file list).
   - Optionally restrict tools to `write` for that final turn; changing the tool set busts the cache only for that last request.
   - Then close the agent, spawn the successor from the handoff file **in the same batch slot**, and do not wake the caller. The caller sees one logical agent with a chain of sessions.
   - Set each child's `compaction.reserveTokens` so pi's own auto-compaction can never pre-empt our handoff.
7. **Prompt-cache stability is a contract for every plugin.**
   - Freeze each agent's system prompt, tool set and tool order at spawn.
   - All later inputs (steer, questions, handoff notices, budget warnings) are appended messages, never prompt or tool edits (herdsman ADR 0009, pify).
   - Turn child cache warming off, or decide it per agent.
   - Pin cache retention per child through a `streamFunction` wrapper (nicobailon).
   - Register our tools at session start and never toggle them (nicobailon, arhen's risk).
   - Do not copy the parent prompt into children hoping for cache reuse: the tool sets differ, so Anthropic caching gains nothing (gotgenes).
8. **Effective system prompt view: build it, nobody else has.**
   - Source of truth: `session.systemPrompt` (read-only, includes all extension changes), `session.getActiveToolNames()` plus tool definitions, and the loaded skills from the resource loader.
   - Better still, capture the exact provider payload in `before_provider_request` on the child's first request. That records what was actually sent, after every extension.
   - Persist the snapshot as a custom entry in the child session, so the view stays reliable after close.
9. **Interaction at every depth with one component set.**
   - pi-subagent-manager's live view with a steer box at any depth proves this works in-process. tintinweb only allows steering at the top level.
   - Map stop → `abort()` then a "stopped, Q&A grace" state. Ask → `steer` while running or `followUp` while in grace. Continue → only through a new agent spawned from a handoff, per our rules.
   - Route by agent id to that agent's `AgentSession`. Never use the shared session queue, to avoid #10610.
10. **Depth and concurrency.**
    - Carry `{depth, maxDepth}` in the child's runtime config, not the environment, and only ever tighten it (nicobailon).
    - Do not register the spawn tool at the cap (LukasParke, tintinweb), so the prompt stays honest.
    - Use one global semaphore across the tree. Waiting parents hold their slots, so reserve capacity or let blocked parents release theirs, to avoid the nested-deadlock that tintinweb sidestepped by exempting nested children.
11. **Lifecycle truth.**
    - Completion comes from `agent_settled`.
    - Failure is `stopReason ∈ {error, aborted}` or an exception, never "no output".
    - Extract the last assistant message *with text*.
    - An empty result is a failure.
    - Throttle render updates (tintinweb #317, nicobailon #2704).
12. **Compatibility hooks that come cheap.** Expose the `subagents:rpc:spawn|stop|consume|ping` event-bus API and the `subagents:completed|failed` events (tintinweb protocol), so `@tintinweb/pi-tasks` works on top of us. Also accept the common frontmatter field names (`tools`, `model`, `thinking`, `skills`, `description`) and ignore unknown keys (nicknisi), so users can bring existing agent files.
13. **Pin what we depend on.** Several packages broke on pi upgrades (#10359; nicobailon #2780; the pify "ctx is stale" crash after `/reload`). Keep every pi import in the adapter, guard captured `ctx` against staleness after reload or session switch, and run an adapter conformance test against each pi release.

---

## Sources
- Local: `~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/{examples/extensions/subagent,examples/extensions/handoff.ts,docs/*.md,dist/core/extensions/types.d.ts}`, `pi-agent-core/dist/types.d.ts`.
- npm tarballs (source read): pi-subagents@0.77.0, @tintinweb/pi-subagents@0.20.0, @gotgenes/pi-subagents@23.4.0, @tintinweb/pi-tasks@0.9.0, pi-subagent-manager@0.21.0, pi-herdsman@0.24.0, @arhen/pi-core-subagent@1.3.68, @pify/subagent@0.19.0, @narumitw/pi-subagents@3.1.1, @nicknisi/pi-subagents@0.4.2, @johnnywu/pi-subagents@2.2.3, pi-herdr-agents@3.2.1, @henryqw/pi-subagent@26.5.0.
- READMEs: pi-fast-subagent, pi-submarine, @mjakl/pi-subagent, pi-inclusive-cost, pi-handoff, pi-continue, pi-background-tasks, @earendil-works/pi-durable, [LukasParke/pi-subagent](https://cdn.jsdelivr.net/gh/LukasParke/pi-subagent@main/README.md), [minghinmatthewlam/pi-subagents](https://cdn.jsdelivr.net/gh/minghinmatthewlam/pi-subagents@main/README.md).
- Package registry: https://pi.dev/packages (search "subagents").
- Upstream issues: earendil-works/pi #5581, #6120, #6509, #7412, #8250, #8746, #9906, #10267, #10359, #10610.
- Mario Zechner, "What I learned building an opinionated and minimal coding agent": https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Daniel Nouri, "The minimal case for a minimal subagents implementation in Pi": https://danielnouri.org/notes/2026/08/06/the-minimal-case-for-a-minimal-subagents-implementation-in-pi/
- No curated "awesome-pi" list was found. The pi.dev package gallery is the de facto index (more than 30 subagent packages on npm as of today).
