# Architecture

How the three extensions work at runtime. Folder layout is in `STRUCTURE.md`.

## Layers and dependency rules

- `core/adapter` is the only code that imports pi (`@earendil-works/*`, `typebox`). It exposes `contract.ts`: `Host` (the main session as seen by an extension) and `AgentRuntime` (spawning and reading agent sessions).
- `core/manager` is pi-free shared infrastructure: plugin manager, typed bus, settings parsing, `settleWithin`, and the cross-extension contract: `handoff.ts` (handoff sections, `HandoffValidation`, `validateHandoff`) and `channels.ts` (the `session-limits:busy` and `spending:usage` channel names, payload types and parsers). Channel names and the handoff format live only there; extensions and subagents plugins import them from there, never from each other.
- Extensions import only `contract.ts` and `core/manager`. Each extension's `src/index.ts` is the single file allowed to import `pi-adapter.ts`.
- Extensions never import each other; they talk over pi's shared event bus (`Host.publish/subscribe`). Plugins inside an extension never import another plugin's folder; they share code through `src/model` and `src/components` and talk through the manager.
- No provider knowledge: no code or prompt names a model provider or a model id. Pi resolves providers, credentials and models; the harness passes `provider/id[:thinking]` strings through. The only exceptions are configuration: the shipped agent files name their `model`, and the subagents README lists those models. Cost is pi's own usage and cost figures.
- `test/architecture.test.ts` enforces the import rules above by scanning imports, plus: `core` never imports `extensions`, no tests inside `src`/`core/adapter`/`core/manager`, and `core/test` holds only `adapter` and `manager` tests. Which files may import pi packages (`core/adapter`, and among tests only `core/test/adapter`) is enforced by biome's `noRestrictedImports` overrides in `biome.json` alone.

## Startup and the adapter

1. pi loads each entry listed in `package.json` (`pi.extensions`). Each default export is `createPiExtension(boot, { root, namespace, childExclude })`.
2. The factory returns immediately when it runs inside an agent session (an `AsyncLocalStorage` scope set while children load), so no extension boots inside an agent.
3. Otherwise it builds a `Host` over pi's `ExtensionAPI` and an `AgentRuntime` over pi's SDK, then calls `boot(host, runtime, paths)`.

Host behaviour worth knowing:
- The adapter keeps the latest pi `ExtensionContext`, captured on every event, tool call and command. On `session_shutdown` every registered handler runs even if an earlier one throws, the context is then always dropped, and the first error is rethrown afterwards so pi reports it.
- `Host.session()` always returns a `SessionInfo`; outside a live session (before `session_start`, after `session_shutdown`) it throws, and so do `readEntries`/`sessionUsage` without a file argument. Every other Host call that needs the context (UI, `publish`, `appendEntry`, `sendUserMessage`, `dispatchCommand`, `isIdle`) is then a no-op. Code that can run after its own shutdown (spending, for reports arriving while other extensions shut down) must not call `session()`.
- `onSessionStart(info, parent)`: `parent` is the session file a freshly created session came from (its header's `parentSession`): `/fork`, `/clone`, or a handoff switch. It is unset for a plain `/new` and for resume, startup and reload. `readEntries(customType, file?)` and `sessionUsage(file?)` read the live session, or another session file when one is given. `onCompact` fires after pi compacts the main session.
- pi builds a fresh extension instance and event bus for every session (`/new`, `/resume`, `/fork`, `/reload`) and fires `session_start` once per instance, except in RPC mode where it fires twice. State therefore starts empty in each instance: handlers that only reset state at session start and unsubscribe handles at shutdown are not needed. Settings are the exception below.
- `onIdle` is pi's `agent_settled`; `onTurnEnd` passes a `ContextSnapshot` (tokens, window, percent).
- `sendUserMessage` delivers immediately when idle, otherwise as a pi follow-up.
- `setMainPrompt` replaces pi's default prompt in `before_agent_start` and re-adds the `tools`, `rules` and `docs` sections pi would otherwise drop (`main-prompt.ts`). Only the subagents `run-agent` plugin calls it, so the main prompt is replaced only when that plugin is enabled.
- `ToolSpec` and overlay/widget factories are plain-text contracts; the adapter converts them to pi tools and TUI components. UI calls degrade to no-ops outside TUI mode.
- `terminalNotify` writes an OSC 9 (or OSC 777 on rxvt) escape sequence.

Unit tests use `core/test/helpers/fakes.ts` (fake host, runtime and child session) instead of pi; a few tests (UI and message-agent) import adapter modules that load pi offline (`pi-ui.ts`, `session-file.ts`, `route.ts`), and only `core/test/adapter` tests import pi packages directly. `core/test/adapter` holds conformance tests against pi, offline.

### Child sessions

`runtime.spawn` returns a `ChildSession`. The adapter tracks a `running` flag, set when `start`, `send` or `wake` issue `session.prompt` and cleared on the `settled` event. While `running` is set (including the window before pi marks the session as streaming), `send(msg, "steer" | "followUp")` and `wake(text)` never call `prompt` again: they queue on pi's own steer or follow-up queue, so a message sent right after `start` joins the first turn and pi's "already processing" error cannot come from the adapter. When nothing is in flight they start a new prompt; if pi rejects it, the child emits an error `assistant_message` and `settled` so the runner closes the agent instead of hanging. If extension binding fails during spawn, the child's extensions get `session_shutdown` and the session is disposed before the error propagates.

## Extension manager and plugins

Only subagents uses the manager; session-limits and spending wire a few functions directly in `boot`.

- A `Plugin` is `{ id, requires?, enable(ctx) => disable? }`. `ctx` holds `host` (the real one), `runtime`, `bus`, `settings`, `services`, `root`.
- Boot order: plugins are topologically sorted by `requires` (cycles throw). A plugin is skipped silently when listed in `disabledPlugins`, and with one warning at session start when a plugin it requires is off or missing.
- Plugins communicate two ways: `services` (a typed map; `provide`/`require`/`has`, where `require` throws if the provider is not enabled) and the typed in-process `bus` (`agent:changed`, `agent:turn`, `agent:closed`, `agent:usage`, `batch:settled`, `session:closing`). Bus listener errors are caught and passed to `onError`, which shows a UI error notification.
- On every `session_shutdown` the entry calls `disableAll()`, which runs the disable callbacks in reverse order, sequentially; a failing callback goes to `onError` and the rest still run. The adapter's own shutdown handlers are fault tolerant in the same way (see above).
- `settleWithin(promise, ms)` waits for a promise or a timeout, whichever comes first, and never rejects. It bounds child aborts (5 s) and child extension shutdown (2 s).

Settings: each extension has a JSON file `<agentDir>/<file>` (user) and `<cwd>/.pi/<file>` (project, read only when the project is trusted). `parseSettings` validates each known key against a schema (number range, string list, boolean); invalid keys are dropped and reported as a warning notification, the rest is applied. Settings are read once per session start as defaults, then user, then project, because pi builds a new extension per session. Subagents additionally reads `disabledPlugins` from the user file at boot, since it decides which plugins enable; a project file cannot set it (warning, key ignored). Session-limits computes its ratios the same way at session start. Nothing is reloaded live.

## Subagents

Plugins (`src/plugins.ts`; requirements in brackets): `agent-registry` (in-memory records, `manifest.json`), `agent-definitions` (agent `.md` files, agent prompts), `run-agent` [registry, definitions] (runner, tools, outbox, main prompt, and the `handoff` service: template and schema), `notifications` [run-agent], `usage-report` [run-agent], `agent-status` [registry], `limits` [registry, run-agent], `progress-widget` [registry], `agent-view` [registry] (`/agents`), `agent-list-view` [registry, agent-view].

### Agent definitions and prompts

- Markdown files with frontmatter are loaded from the built-in `agents/` when the plugin enables, and from the built-in `agents/`, then `<agentDir>/agents/`, then `<cwd>/.pi/agents/` (trusted projects) at session start. Later files override earlier ones by `name`. Invalid files, unknown `subagents` references and `subagents` cycles remove the offending definitions and produce warnings.
- Shipped agents name `model: provider/id:thinking`. A file without a `model` line (or with `inherit[:thinking]`) runs on the main session's model and, without a suffix, its thinking level.
- An agent's configured model and thinking are computed in one place, `parseDefinition` (`agent-definitions/loader.ts`), and stored on the `AgentDefinition`; the runner (`planModel`) and the `run_agent` description read them only through the `definitions` service. A future per-agent override (for example a command that sets an agent's model and thinking) plugs in at the `onSessionStart` reload in `agent-definitions/index.ts`, by overlaying stored values onto the loaded definitions. The `model` parameter of `run_agent` and the main-session fallback are applied on top in `planModel`.
- Agent prompt = pi's own prompt for the child, with appended text: `prompts/base-system-prompt.md`, then `# Agent: <name>`, the file body and a fixed output contract.
- The main session prompt is `prompts/main-session.md`, set by `run-agent` at session start (plus `prompts/main-session-agent-status.md` when the agent-status plugin is on). `prompts/handoff.md` is the agents' handoff instruction template (`{{path}}` substituted), read by run-agent's `handoff.ts`. Prompt files are read once when their plugin enables.

### A run_agent call, end to end

1. Main model calls `run_agent { agents: [...], wait? }` -> `runner.startBatch` validates agent names, the caller's allowed `subagents`, depth (`callerDepth + 1 <= maxDepth`, main is depth 1) and resolves every model. Any error throws and nothing starts.
2. Registry creates one record per agent (`queued`), writes `manifest.json`, emits `agent:changed`. The tool returns ids at once and tells the model to end its turn (`wait: true` blocks until the batch settles instead).
3. `launch` per agent: acquire a semaphore slot (`maxConcurrent`, shared by the whole tree) -> optionally create a git worktree -> `runtime.spawn(SpawnSpec)` -> record becomes `running` -> `child.start(task)` -> messages queued while `queued` are steered in.
4. `spawn` builds an in-process pi `AgentSession` (not a subprocess) inside the child scope: in-memory copy of the main session settings with compaction disabled, `reserveTokens` set and cache warming off; tools = the definition's allowlist or the main session's active tools (minus excluded extension paths), plus MCP, `codemode` and `tool_search` unless `tools: []`, plus custom tools from the runner; skills = the main session's skill files, filtered; model resolved again by exact ref; session file in the agent's dir with `parentSession` = main session file; UI is silent except `confirm/select/input/notify`, which are forwarded to the main UI through one serial queue and mark the record with `attention`.
5. A hidden child extension cancels every compaction and, on the first provider request, appends a `pi-subagents:prompt-record` entry (skills, guidelines, raw provider payload, model) to the child session file. The agent view rebuilds the effective prompt from this entry plus the system messages pi writes.
6. Child events (`turn_end`, `assistant_message`, `tool_start`, `settled`) update the record (turns, tool calls, tokens, context, last text) and emit `agent:turn` and `agent:usage`.
7. On `settled`: if the agent has its own open batches or undelivered wakes, it goes idle and releases its slot. Otherwise it closes: `done` with the last assistant text written to `result.md`, or `failed` (abort, error stop reason, empty result). Closing releases the slot, emits final usage, disposes the session and immediately stops any open children of that agent.
8. When every record of the batch is closed, `batch:settled` fires and the batch text (one `## <id> (<agent>) - <state>` section per chain terminal; results inline up to `inlineResultChars`, otherwise path and preview) is posted to the caller's outbox.
9. Outbox: for the main session it holds texts while pi is busy and flushes them joined on the next idle as one user message (the "wake"). For an agent caller it re-acquires a slot and wakes that child with a follow-up prompt.

Nesting: a child gets `run_agent`, `message_agent` and `agent_status` as custom tools only when its definition allows subagents and it is below `maxDepth`; these tools are bound to the child as caller and drive the same runner. A child waiting on its batch holds no slot, so the tree cannot deadlock.

### Messages, stop and shutdown

- `message_agent` (only the agent's caller) and the agent view route `[message from <sender>]` text: held while queued, steered while a turn is in flight, a follow-up (after re-acquiring a slot) when idle.
- Stop: a running agent enters `grace`, its turn is aborted and its slot released; a message during grace is answered, otherwise after `stopGraceSeconds` it closes as `stopped` (last text kept as result). A queued agent, a second stop during grace, or `stopGraceSeconds: 0` closes at once.
- Session shutdown: the outbox is cleared, `session:closing` silences notifications, every open agent closes as `failed (interrupted)` (or `stopped` if in grace), children are aborted and disposed.

### Context limits and handoff chains

- Effective limit = `min(definition limit, model window - reserveTokens)`. After each turn that continues with tool calls, `limits` compares context tokens: at `softContextRatio` it routes one warning; at the limit it sets `handoffRequested` and routes `prompts/handoff.md` with the agent's handoff path (OS temp dir); past `limit * hardContextRatio`, or 3 turns after the request, it aborts the agent.
- When an agent with a handoff request settles, the runner validates the handoff file (sections Status, Outcome, Evidence, Blocker, Next, Files touched in order; Status `partial` or `blocked`). `partial` within `maxChainLength`, not stopped and not in a settled batch -> a successor record in the same batch (same task, same worktree, task text points at the handoff) and the predecessor closes as `handoff`. Otherwise the agent closes as `handoff`, flagged invalid if the schema failed. A missing file is `failed`.
- Chains are invisible to the caller: one wake, one result section with a `Chain:` line, and any id of a chain resolves to its last link for status, messages and stop.

### Status, views, notifications

- `agent_status` reads in-memory records only; it never touches the agent.
- The progress widget and list view re-render on `agent:changed` (throttled) plus a 1 s ticker while agents run; closed rows linger for `lingerMs`/`failedLingerMs`.
- The agent view (`/agents [id]`) reads the agent's session file through `runtime.readSession`, falling back to `manifest.json` for agents not in memory. Its focus/verbose mode persists in `<agentDir>/pi-subagents-view.json`.
- Notifications (terminal escape sequence) fire for a settled main-session batch, a failed agent not already covered by its batch, and a new input request from an agent.

### Worktrees

`worktree: true` writes `<cwd>/.pi/worktrees/.gitignore` (`*`) when missing, then runs `git worktree add -b pi-agents/<id>-<stamp> <cwd>/.pi/worktrees/<id>-<stamp> <base>` from the session cwd, where `base` is the HEAD sha; the agent's cwd is the same subdirectory inside it. A failed git or fs step fails the agent with `worktree failed: <error>`. `Worktree = { path, branch, base, cwd, cleanup? }`. A successor is created holding its predecessor's worktree. `releaseLive` is one teardown per agent: it disposes the child, then, for a closed record without a successor, runs `git worktree remove <path>` (no `--force`), deletes the branch only if it still points at `base`, and stores the outcome as `worktree.cleanup` (`removed`, `branch kept`, `kept`) on every link of the chain. A batch settles only after every member's cleanup, so results show the final outcome; shutdown awaits every pending removal except one whose `git worktree add` is still running. Stopping an agent queued for a slot tears it down at once.

## Session-limits

- Active only in `tui` and `rpc` modes (a `Host` wrapper suppresses events otherwise). Thresholds compare main session context tokens to the model window: `softRatio` (0.6) shows a warning footer segment, `hardRatio` (0.75) triggers the handoff.
- Sequence: turn end at hard level -> send the `prompts/handoff.md` instruction as a user message with the path `<OS temp dir>/pi-session-limits/<session id>-handoff.md` -> on each turn end/idle check whether the file is new (mtime changed) and valid (same six sections, Status `done`, `partial` or `blocked`) -> if valid and no busy source -> dispatch `/session-handoff` -> `newSession({ parentSession, seed })`, seeding the new session with a `pi-session-limits-handoff` custom message holding the handoff.
- An invalid or missing file after the session settles gets one resend with the errors; after 2 instructions the phase becomes `stuck` and the user runs `/session-handoff` by hand. User activity after the request causes the instruction to be re-sent before switching.
- Busy sources: any extension can publish `session-limits:busy { source, busy }`. Subagents publishes it while any agent is open; the switch waits until all sources are idle (then 1 s), and a manual switch asks for confirmation.
- All state is in memory, per extension instance; the only file is the handoff. A pending switch whose `/session-handoff` command never runs ends in the failed phase at the next idle or turn end; a second `/session-handoff` while one runs is ignored. A context window of 0 or unknown token usage turns the extension off for that moment (no request, footer cleared).
- `Host.onCompact` fires after pi compacts the main session; session-limits uses it to forget its cached context size (pi reports unknown tokens after compaction), which clears the footer segment until the next turn.

## Spending

- Main cost = `sumUsage` over the session entries (assistant, tool result, `usage`, compaction and branch-summary usage; `Host.sessionUsage()`), as priced by pi. Child agents use the same `sumUsage` (`ChildSession.ownUsage`).
- Other costs arrive on `spending:usage { source, id, usage }`. Subagents' `usage-report` forwards every `agent:usage` (child session's own usage, at any depth, since all agents share one runner) with `source: "agents"` and the agent id as `id` (ids are unique within the session's agents folder, earlier runs included), with no dedup of its own, since the ledger is idempotent.
- The ledger keeps the latest report per `(source, id)` (monotonic: totals never go down), sums per source, and shows `main $x · agents $y · total $z` (plus `(sub)` when pi reports OAuth for the model) in the footer once any source is above zero; total is the sum of the displayed parts.
- Persistence: changed reports are appended as `pi-spending:usage` custom entries in the main session file on idle and shutdown, and replayed on session start (resume). Reports that arrive after spending's own shutdown are ignored.
- Lineage: totals cover the whole session lineage. Compaction and `/tree` only append to the same file, and `sumUsage` reads every entry of every branch. When a session is created from another one (`/fork`, `/clone` or a handoff switch; `parent` set) spending appends a `pi-spending:main-offset` entry (the parent's main cost, its own last offset plus all its entries, minus the usage of the entries copied into the new session), so main = last offset + `sumUsage` of the new session's entries; it also appends a continuation marker report, absorbs every parent `pi-spending:usage` report under an id prefixed with the parent file name (so new agents cannot collide with parent agent ids) and persists them into the new session at once; restore ignores reports before the last marker, so resumed sessions and chains of forks and handoffs keep the totals. Only a plain `/new` starts at zero; a handoff switch keeps the totals, since it continues the same work in a new session. A fork of a session without a file (`--no-session`) has no parent file to read and starts from the copied entries only.

## Working-indicator

- Active only in `tui` mode. On session start and every `Host.onTurnStart` (pi's `turn_start`) it sets `HostUi.setWorkingIndicator` to the `SPINNER` frames; the adapter (`pi-working.ts`) paints them with the theme's accent colour and both working calls are no-ops outside `tui`.
- On turn start an unref'd interval refreshes `HostUi.setWorkingMessage` every `TICK_MS` with `<verb>… (<seconds>s · esc to interrupt)`, picking a new random verb every `VERB_MS`; turn end and shutdown stop it and restore pi's default message. Nothing is persisted.

## Persistence summary

Every file the extensions write lives under pi's agent dir or session dir (`~/.pi/agent` by default; the `sessionDir` setting or `--session-dir` moves session data), except handoff files (OS temp dir) and `worktree: true` agents (checkout under `<cwd>/.pi/worktrees/`, git's `pi-agents/...` branch and `.git/worktrees/` metadata).

- Agents dir (`agentsDirFor` in `extensions/subagents/src/model/paths.ts`) = `<main session file without .jsonl>/agents`, or `<agentDir>/pi-subagents/<session id>/agents` for a session without a file.
- `<agents dir>/<id>/`: `manifest.json` (rewritten on state or worktree change), the child pi session `.jsonl` (with `parentSession` and the prompt record), `result.md`.
- `<OS temp dir>/pi-session-limits/<session id>-handoff.md` (main) and `<OS temp dir>/pi-subagents/<session id>/<agent id>-handoff.md` (agents): handoff files.
- `<cwd>/.pi/worktrees/<id>-<stamp>/`: a worktree agent's checkout, removed when its chain ends unless git refuses (uncommitted changes); its branch stays only if it moved past `base`. `.pi/worktrees/.gitignore` keeps them out of `git status`.
- Main session file: `pi-spending:usage` and `pi-spending:main-offset` entries; the new session's seed message after a handoff.
- `<agentDir>`: `pi-subagents.json`, `pi-session-limits.json`, `pi-subagents-view.json`, `agents/*.md`. `<cwd>/.pi/`: the same settings files and `agents/*.md` (trusted projects only).
- Registry, batches, ledger totals and limit phases live in memory and are lost on reload.

## Cross-cutting

- Errors: user-facing failures become data, not exceptions: a failed agent is a closed record with `error`, tool misuse returns an error result, bad settings or agent files become warnings and are skipped. `startBatch` throws for invalid requests so nothing is half-started.
- Model resolution (`core/adapter/model-resolver.ts`): no request means the main session's model; otherwise exact `provider/id` or id among models with credentials (preferring the session provider, then the default provider), then fuzzy matching by tokens and edit distance within a provider scope, newest version per family. Several families -> `ambiguous`, nothing -> `unknown` with suggestions; both make `run_agent` fail with the candidates. Thinking level: request suffix, then definition, then the main session's level.
- Prompt cache: agents never compact and never get cache warming; their prompt prefix is fixed at spawn.
- Tests: unit tests run against the fakes with no network (`npm run check`, also what CI runs). `*.live.test.ts` spawn real agents under `npm run test:live`, locally only: `PI_LIVE_MODEL=provider/id[:thinking]` is required (the suites fail at once when it or the credentials are missing), and a temporary agent dir holds only copies of the credentials.
