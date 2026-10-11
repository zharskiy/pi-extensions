# Implementation plan: pi subagents extension

Date: 10 October 2026. Input: `HANDOFF.md` and the four research reports in `research/`.

Status: release 0.1 is merged. Release 0.2 (F9, F11, F12, F13, F14) is implemented on branch `feat/0.2`, uncommitted, pending the product owner's review. Every departure from this plan is listed in `docs/deviations.md`.

## 1. Research conclusions that fix the design

These are the decisions the research settles, plus the product decisions taken during the 0.1 review. Everything below assumes them.

| Topic | Decision | Why (report) |
|---|---|---|
| Spawning | In-process `createAgentSession` per agent, behind the adapter. Subprocess (`pi --mode rpc`) stays possible behind the same contract, not built in MVP. | Pi maps `@earendil-works/pi-coding-agent` imports to its own copy, several sessions run concurrently, in-process gives steer/abort/usage/context directly. The whole ecosystem converged on this. (`pi-sdk-sessions-cost.md` §1-2, `existing-subagent-extensions.md` §5.1) |
| Persistence | One agent = one ordinary pi JSONL session file under `<parent session dir>/<parent>/agents/`, with `parentSession` set and a sidecar manifest (status, depth, batch, predecessor/successor). | Shows up nested in `/resume`, gives "closed is final" an on-disk meaning, and lets the viewer read the file after close. (`pi-sdk-sessions-cost.md` §3) |
| Completion | `agent_settled`, never `agent_end`. Empty output is a failure. | `agent_end` fires before retries and compaction; several packages shipped false "done" reports. (`existing-subagent-extensions.md` §5.11) |
| Waking the caller | Single membership-based wake per batch. Child callers: `session.followUp()` on their `AgentSession`. Main session: `pi.sendUserMessage` when idle, held in an outbox while mid-turn. Path lives in the adapter. | `sendMessage({triggerTurn})` skips `before_agent_start` and busts the main session cache (open pi issues #5581, #10267). (`existing-subagent-extensions.md` §5.3-5.4) |
| Spending | Two channels, one process-wide ledger. Synchronous waits return `usage` on the tool result. Background agents report not-yet-delivered usage on the next tool result we own (`agent_status`, collect). Our own footer segment shows main + agents from the ledger. | Extensions cannot write `usage` entries; tool-result `usage` is the only supported path into pi's totals. Cost is pi's catalog estimate on every provider, so "accurate" means "consistent with pi". (`pi-sdk-sessions-cost.md` §4, `pi-extension-api.md` §7) |
| Context budget | Measure with `session.getContextUsage()` on `turn_end`. Disable auto-compaction in the child's in-memory settings, set `reserveTokens` so pi can never pre-empt us, cancel `session_before_compact` as backstop, steer a "write your handoff now" instruction. | Compaction would break the cache and the "closed is final" rule. (`pi-sdk-sessions-cost.md` §6) |
| Settings | Every child gets its own `SettingsManager.inMemory(...)` snapshot. Extension settings live in our own JSON file and hold numbers and switches only, never prompt text. | `setAutoCompactionEnabled` and friends write to the user's global `settings.json`; `applyOverrides` is lost on save; pi has no per-extension settings namespace. (`pi-sdk-sessions-cost.md` §1, `pi-extension-api.md` §9) |
| Prompts | The base prompt and the main session prompt are markdown files in the package (`prompts/`). The main session prompt replaces pi's default preamble at runtime when the extension loads, with the sections pi drops on override rebuilt from the structured options. Nothing is written to `~/.pi/agent`. | Product decision: prompts are versioned with the code and edited as files. Pi has no install hook, and a global `SYSTEM.md` would change every pi session, not only those with the extension. (`docs/deviations.md`) |
| Where orchestration knowledge lives | Only the main session prompt holds orchestration rules. An agent allowed to spawn learns how from its `run_agent` tool description, generated per agent at spawn from its `subagents` list. | Product decision. Tool descriptions are frozen at spawn, so this is cache-safe, and each agent sees only what it may do. |
| Model selection | Each agent file fixes `model` as `name[:thinking]`, the only place its thinking level is set; without a suffix the agent inherits the main session's thinking level. A caller may pass a per-call `model` override only when the user explicitly named a model or thinking level for that task. The harness resolves names against credentialed providers only, tolerates misspellings, picks the newest version when none is given, and refuses with a ranked candidate list when matches span families or nothing matches; the main session then asks the user and reuses the answer. The resolved `provider/id:thinking` is echoed everywhere the agent is shown. | Product decision. Pi's own matcher is a substring search in string order and offers no typo tolerance or version preference. Guessing a family silently changes cost. (`docs/design/agent-and-model-selection.md`) |
| Agent set | Three role agents with `subagents: []` (`explorer`, `implementer`, `reviewer`) plus `general`, a fallback with every tool and `subagents: [explorer, reviewer]`, listed separately as usable only when no role agent fits the work. | Product decision; the fallback rule is about the work, so naming a model never selects the general agent over a role agent. |
| Prompt cache | Freeze system prompt, tool set and tool order at spawn. All later input is appended messages (steer, followUp). Never change model, thinking level or earlier messages mid-agent. Child cache warming off by default. | Mid-conversation prompt or tool changes keep the cache on only about 18 models. (`pi-sdk-sessions-cost.md` §7) |
| Views | Overlay via `ctx.ui.custom(factory, { overlay: true })` using pi's exported `AssistantMessageComponent`, `ToolExecutionComponent`, `Markdown`, `Loader`, so an agent transcript looks exactly like the main session, including Ctrl+O tool detail. Scrolling through pi's `ScrollView` with mouse wheel in fullscreen mode; keyboard only in regular mode. Progress widget via `setWidget`. Footer segment via `setStatus`. Collapsible component is ours; pi has none. The widget cannot take focus, so `/agents <id>` is the entry point and an unknown id only warns. | No API swaps the main transcript for another view. Plain-text tool results and keyboard-only windowing were rejected in review. (`pi-extension-api.md` §4, §7) |
| System prompt record | Capture `before_provider_request` on the child's first request and persist it as a custom entry in the child session. `before_agent_start` gives the structured sections for the collapsible view. | Only the provider payload records what every extension actually sent. (`pi-extension-api.md` §3) |
| Agent files | Markdown with YAML frontmatter in `~/.pi/agent/agents` and `.pi/agents` (project files only for trusted projects). Accept the community field names (`name`, `description`, `tools`, `model`, `skills`, prompt append), ignore unknown keys. The thinking level is a suffix on `model` (`provider/id:thinking`); a separate `thinking` key is rejected so a setting is never silently lost. Our own mandatory fields: `limit` (context budget) and `subagents` (agents it may spawn). | Matches Claude Code and every pi package, so users can bring existing files. (`claude-code-agent-ux.md` §5, `existing-subagent-extensions.md` §1) |
| Interaction model | Stop → abort → grace state (configurable `stopGraceSeconds`, default 60) → close and notify caller exactly once with the last output. A message during grace runs a turn and pauses the countdown, which restarts after the turn settles, so a stopped agent can never go stale. A second stop closes at once. Ask → `steer` while running, `followUp` in grace. Continue → new agent from the handoff file. A caller can also send a message to its own running agent through a tool, using the same route. Route every message by agent id to that agent's session, never through pi's shared queue. | Keeps the handoff's "closed is final" rule, which differs from Claude Code's resume-in-place. Avoids pi issue #10610. Steer and followUp append at the end of the context, so they never break the agent's cache (`pi-sdk-sessions-cost.md` §9). |
| Isolation hazards | Adapter owns: child guard so our extension never loads inside a child, fresh model runtime with provider replay, per-agent `AbortController`, bounded `session_shutdown` before `dispose`, stale-`ctx` guard after `/reload`. | Every shared-process failure the ecosystem reported. (`existing-subagent-extensions.md` §5.1, §5.13) |

## 2. Architecture skeleton

Built once, before any feature. Owned by the platform stream.

```
pi-subagents/
  package.json              # "pi" field pointing at extensions, skills, prompts
  README.md
  biome.json  vitest.config.ts  tsconfig.json
  src/
    adapter/                # ONLY place that imports @earendil-works/*
      contract.ts           # our interface: Host, AgentRuntime, Ui, Session, Usage
      pi-adapter.ts         # implementation against pi 1.1.0
      model-resolver.ts     # pure name → provider/id:thinking resolution over a plain catalog
      main-prompt.ts        # rebuilds the sections pi drops when the preamble is replaced
      session-file.ts       # reads an agent's JSONL session for the view
    manager/
      extension-manager.ts  # enables plugins, owns every cross-plugin interaction
      plugin.ts             # Plugin interface: id, deps, enable(host, bus), disable
      bus.ts                # typed in-process events between plugins
      settings.ts           # our own JSON settings file + schema + defaults
    plugins/
      agent-definitions/    # loads agent .md files, base prompt, main session prompt
      run-agent/            # run_agent tool, batches, wake, result contract
      agent-status/         # agent_status tool
      agent-registry/       # in-memory tree of agents, manifests, lifecycle state
      limits/               # per-agent context budget + handoff trigger
      session-limits/       # main-session soft/hard limit (separate plugin per handoff)
      spending/             # ledger, tool-result usage channel, footer segment
      progress-widget/      # rows below the editor
      agent-view/           # overlay transcript of one agent
      agent-list-view/      # overlay list of all agents
      handoff/              # handoff file schema, writer prompt, successor spawn
    components/
      collapsible.ts  agent-row.ts  system-prompt-block.ts
    index.ts                # pi entry: builds adapter, manager, enables plugins
  test/                     # mirrors src/ one to one; helpers/ holds fakes and the harness
    adapter/                # the only tests allowed to import pi (conformance, main prompt, resolver)
    manager/  plugins/  components/
    architecture.test.ts    # import boundary, no tests under src, pi imports only in test/adapter
  agents/                   # shipped agent definitions (.md)
  prompts/
    base-system-prompt.md
    main-session.md
    handoff.md
  scripts/spike.ts          # SDK-level conformance run against a real pi, rerun per pi release
  docs/  docs/design/  research/
```

Rules enforced by lint and review: `plugins/**` and `components/**` never import `@earendil-works/*`, and under `test/` only `test/adapter/**` may; plugins talk only through the bus and the registry; the manager is the single list of what the extension adds to pi. Code conventions: no code comments anywhere, no for-loops, Conventional Commits, tests live under `test/` and never under `src/`.

**Spike (first task, time-boxed to two days):** run three concurrent child sessions from an extension inside the TUI, assert no interference, cache hit on the second turn of each child (`cacheRead` grows), clean `dispose()`, MCP behaviour, and that waking the idle main session via `sendUserMessage` keeps its `cacheRead` stable. The adapter contract is frozen only after the spike passes.

## 3. Features by release

Each feature lists user value, scope, the plugins it touches, and the acceptance tests. Features inside a release are ordered by dependency.

### Release 0.1 (MVP): run agents in the background, watch them, pay for them

Goal: the main session, a cheap coordinator, can delegate work to one or more background agents, be woken once per batch with results, inspect any agent, stop it, and see combined spend. Nesting (F10) is delivered in 0.1, default depth 3.

**F1 Agent definitions**
- Value: users and the team add agents by dropping a markdown file.
- Scope: loader for `~/.pi/agent/agents/*.md` and `.pi/agents/*.md` with project-over-user precedence; frontmatter schema (`name`, `description`, `model` as `name[:thinking]` (an exact `provider/id` or a name the harness resolves at spawn) or `inherit[:thinking]`, with no separate `thinking` field (a file that has one fails to load and is told to use the model suffix), `fallback`, `tools`, `skills`, `prompt`, `input`, `output`, `maxTurns`, and the mandatory `limit` and `subagents`); `subagents` names must exist, must not include the agent itself and must not form a cycle; base system prompt + per-agent additions assembled with `appendSystemPromptOverride`, never a full override (a full override drops pi's tools and rules sections); validation errors shown with `notify`.
- Main session prompt: `prompts/main-session.md` replaces pi's default preamble in the main session at runtime (`before_agent_start`, `customPrompt`), and the `tools`, `rules` and `docs` sections that a custom preamble drops are rebuilt from the structured prompt options. It holds every orchestration rule. Agents never get orchestration rules in their system prompt: an agent allowed to spawn learns how from its `run_agent` description, built per agent at spawn by `describeRunAgent(allowedAgents, limits)` (allowed agents with descriptions and limits, depth, concurrency and budget rules, result contract). The main session uses the same builder with every loaded agent. Both prompt files live in the package; there are no prompt path settings.
- Ships with three role agents, `explorer` (read-only search in large repos, returns file list + findings), `implementer` (edits, returns diff summary) and `reviewer` (read-only, returns findings), all with `subagents: []`, plus `general`, a fallback (`fallback: true`) for work no role agent fits, with every built-in tool and `subagents: [explorer, reviewer]`. `run_agent` lists fallback agents in a separate block "only when no agent above fits the work". Prompts are a separate task after the loader exists.
- Plugins: `agent-definitions`.
- Tests: frontmatter parsing, precedence, invalid files, prompt assembly snapshot.

**F2 Run agent tool and batches**
- Value: the main session delegates sequentially or in parallel and is woken once.
- Scope: `run_agent` tool taking one or several `{agent, task, input files}`; background by default; a batch is a set of agent ids with an all-settled policy; results held in an outbox and delivered in one wake message; results under a size threshold inline as text, larger ones and all handoffs as files under the agent's directory with the path in the message; wake path per the adapter decision; failure = `stopReason ∈ {error, aborted}` or empty output; global concurrency semaphore; optional per-item `model` as `name[:thinking]`, passed only when the user named a model or thinking level and resolved by the harness (credentialed providers only, typo-tolerant, newest version, ambiguous or unknown names rejected with candidates); depth carried in the child runtime config, spawn tool not registered at the cap (default max depth 3, 2 to 4, see F10).
- Plugins: `run-agent`, `agent-registry`, adapter spawn.
- Tests: batch of three wakes once; one failure inside a batch still wakes once with the failure marked; large output goes to file; semaphore caps concurrency; cache-read assertion on the main session before and after a wake; wake deferred while the caller is mid-turn.

**F3 Agent status tool**
- Value: the main session checks on one or many agents in one call without waking.
- Scope: `agent_status` tool returning state, elapsed, tokens, context percent, last text line, result path; batch query; carries not-yet-reported usage on its result (spending channel b).
- Plugins: `agent-status`, `spending`.
- Tests: status snapshot shape, usage delivered exactly once.

**F3b Message agent tool**
- Value: when the user corrects the main session mid-flight ("stop touching the auth module", "also cover the tests"), the main session forwards the correction to the running agent instead of killing and respawning it.
- Scope: `message_agent` tool taking `{agent id, message}`; only the caller that spawned the agent may use it, so an agent can message its own children but never a sibling or the main session; the message is delivered with `steer` while the agent is running and `followUp` while it is in the stop grace state; a closed agent returns an error; the tool returns immediately and the agent does not reply, the caller observes the effect through `agent_status` and the final result; the message appears in the agent's transcript and view as a user message tagged with the sender; the main session prompt tells the model to forward user corrections this way; the main session stays idle while a batch runs, so the user can type a correction, the main session forwards it in one turn, and the single batch wake still arrives later.
- Plugins: `run-agent` (shares the routing with F7 budget steers and later F11), `agent-registry`, `agent-view`.
- Tests: delivery while running vs in grace, rejection for non-callers and closed agents, message shows in the transcript, cache-read assertion that a steer does not reset the child's `cacheRead`.

**F4 Progress rows**
- Value: the user sees what is running without opening anything.
- Scope: one-line start and finish rows per agent in the transcript via custom `renderCall`/`renderResult` (`Done (N tool calls · tokens · elapsed)`); a widget below the editor listing running agents at any depth with status icon, description, live token count, elapsed; finished rows linger about 30 seconds, failed and stopped longer; render throttled.
- Plugins: `progress-widget`; component `agent-row`.
- Tests: row formatting, throttle, linger timing.

**F5 Agent view (read and stop)**
- Value: the user inspects any agent and the exact prompt it was sent; this is the debugging record.
- Scope: overlay opened with `/agents <id>` (the widget cannot take focus; an unknown id only warns and opens nothing); reads the agent's session file, so it works after close; first block is the full effective system prompt, skills, tools and tool guidelines as collapsible sections built from the persisted `before_provider_request` snapshot; transcript rendered with pi's own message and tool components, tool results paired to calls by id, Ctrl+O toggles tool detail; pi's `ScrollView` with mouse wheel, PgUp/PgDn, Home/End, following the tail unless the user scrolled up, keyboard only in regular mode; live updates throttled; first `x` enters the stop grace state and the hint bar says a second `x` closes now; `Esc` closes the view.
- Plugins: `agent-view`; components `collapsible`, `system-prompt-block`.
- Tests: snapshot of the transcript rendered through pi's components from a recorded session; view opens for a closed agent; Ctrl+O, scrolling and tail following; stop then stop again notifies the caller once.

**F6 Spending footer**
- Value: one number for what the whole tree cost, consistent with pi's own accounting.
- Scope: process-wide ledger keyed by agent id, high-water-mark per agent persisted as custom entries in the parent session so reloads never double count; footer segment `main $x · agents $y · total $z` via `setStatus`; tool-result `usage` on synchronous waits; subscription usage shown as pi shows it.
- Plugins: `spending`.
- Tests: nested agents counted once; reload keeps totals; pi `/session` total equals our main figure plus delivered agent usage.

**F7 Agent context budget with handoff file**
- Value: an agent in a huge repo never silently loses its context; its work survives as a file.
- Scope: budget from the agent's mandatory `limit` field, capped by the model window; soft warning steered at 80 percent; at the budget the agent is steered to write a handoff file with a fixed schema (Status, Outcome, Evidence, Blocker, Next, files touched); auto-compaction disabled in the child, `reserveTokens` set, `session_before_compact` cancelled; the agent closes and the caller is woken with the handoff path. Successor spawn is F9.
- Plugins: `limits`, `handoff`.
- Tests: budget trigger at the right turn, handoff file validated against schema, compaction never runs in a child.

**F8 Packaging, README, CI**
- Scope: `pi install` from the repo and from npm, `/reload` safe (stale `ctx` guard, agents interrupted by reload marked failed, never restarted), Biome and Vitest in CI, adapter conformance test pinned to pi 1.1.0, short README (needs, install, update).

### Release 0.2: talk to agents, nest them, keep going

**F9 Successor chain**
- At the budget, spawn a successor from the handoff file in the same batch slot without waking the caller; the caller sees one logical agent with a chain of sessions; manifests link predecessor and successor; progress row shows the chain index.
- Tests: three-link chain returns one result; caller woken once.

**F10 Nesting to depth 4** (delivered in 0.1; see `docs/deviations.md` entry 4)
- Children whose `subagents` list is not empty get `run_agent` (description from `describeRunAgent` listing only those agents, frozen at spawn), `message_agent` and `agent_status`; the runner rejects any agent outside the list; tree-wide semaphore where a slot is held only while a run is in flight, so waiting parents hold none and cannot deadlock the tree; default depth 3, max 4; every level uses the same registry, rows, view and wake code.
- Tests: grandchild batch wakes the child only; deadlock scenario with the semaphore full of waiting parents.

**F11 Ask a question from the view** (the grace state machine is delivered in 0.1; only the input box remains)
- Agent view gains an input box; `Enter` sends through the F3b message route (steer while running, followUp in grace), tagged as coming from the user, so the user can ask a stopped agent questions during the grace countdown, which the row and status already show.
- Tests: message routing by agent id from the view, user tag in the transcript.

**F12 Agent list view**
- `/agents` overlay listing all agents grouped by state (working, needs attention, done, failed, closed), with `↑`/`↓`, `Enter` to open the agent view, `x` to stop, stop-all chord with confirmation, filter by status or agent name.

**F13 Main session limits**
- The user can talk to the main session endlessly; the limits are silent. A cheap main model is the intended default, since the main session only coordinates.
- Separate plugin with soft and hard limits on the main session's context. At the soft limit the footer segment turns orange; nothing is said in the conversation. At the hard limit the session writes a handoff as its very next step and a new session is created from it automatically, with no user action; the user keeps typing into the new session. Session switching only works from command handlers, so the plugin triggers a registered command itself.
- Tests: colour transition, handoff written before any other tool call, new session seeded from the file.

**F14 Permissions and attention**
- Permission or confirmation prompts raised inside a child surface in the main session naming the agent; `Esc` denies one call without stopping the agent; a "needs input" state in rows and list view.

### Release 0.3: hardening and ecosystem

**F15 Context breakdown view** per agent (system prompt, tools, skills, messages, free space) with the budget line, green/yellow/red by percent.

**F16 Subprocess isolation option** behind the adapter (`pi --mode rpc`) for agents that must survive a crash or need CPU isolation; selectable per agent definition.

**F17 Compatibility**: tintinweb event-bus protocol (`subagents:rpc:spawn|stop|consume|ping`, `subagents:completed|failed`) so `@tintinweb/pi-tasks` works on top of us; accept Claude Code frontmatter fields where they map.

**F18 Upstream work**: file pi requests for an extension-facing `appendUsage` and a cache-safe wake, and track issues #5581, #10267, #10610; switch adapter paths when fixed.

**F19 Operability**: terminal notification on done or needs input, per-agent worktree isolation, persisted verbose or focus view modes.

## 4. Team streams and parallelism

Three streams can run in parallel after the skeleton and spike.

| Stream | Owns | 0.1 order |
|---|---|---|
| Platform | adapter, manager, registry, run-agent, status, message agent, limits, spending ledger, packaging | spike → F2 → F3 → F3b → F7 → F6 ledger → F8 |
| Experience | components, progress rows, agent view, footer segment, list view | collapsible + rows (mock registry) → F4 → F5 → F6 footer |
| Agents | definitions loader, base and main session prompts, agent set, handoff schema, result contract wording | F1 loader → prompts → F7 handoff schema |

Dependencies: F4 and F5 need the registry's event shape from F2, so the registry interface is defined in the skeleton week and mocked by the experience stream. F3b, F7 and later F11 share one message route in the adapter (steer while running, followUp in grace), built once in F3b. F7 needs F1's prompt assembly.

## 5. Decisions

Settled during the 0.1 review:

1. **Agent set.** Four shipped agents: `explorer`, `implementer`, `reviewer` and the `general` fallback (see the Agent set row in section 1).
2. **Nesting in MVP.** Nesting (F10) ships in 0.1 with default depth 3, because the `general` agent may start explorers and reviewers.
3. **Mandatory frontmatter.** `limit` and `subagents` are required in every agent file; an empty list means no subagents.
4. **Model and thinking override.** Allowed for every agent, only when the user deliberately asks, with typo-tolerant resolution and newest-version default (see the Model selection row).
5. **Prompts as files.** No prompt text in settings; the main session prompt replaces pi's default at runtime.
6. **Orchestration knowledge.** Main session prompt only; agents learn spawning from the tool description.
7. **Silent main session limits.** The user talks to the main session endlessly; compaction or handover never interrupts the conversation (F13).
8. **Stop grace.** Delivered in 0.1 as a state machine with a single wake after the countdown.
9. **Code conventions.** No code comments, tests under `test/` mirroring `src/`, Conventional Commits, nothing committed until the product owner has reviewed.

Still open, the plan proceeds on the stated assumption:

1. **Closed is final.** Claude Code resumes agents in place; the plan keeps the handoff rule (continuation only via a new agent from a handoff file).
2. **Accuracy of spend.** Pi computes cost from its catalog on every provider, so OpenRouter and subscription figures are estimates. The plan defines "accurate" as "matches pi's own accounting".
3. **tintinweb compatibility** in 0.3: worth doing only if the team wants pi-tasks users.
4. **Spike script.** `scripts/spike.ts` stays as a per-release conformance run unless the owner prefers unit tests only.

## 6. Risks carried into design

- Pi shipped 1.0.0 and 1.1.0 within a week with 48 breaking-change sections in the changelog. The adapter plus conformance test is the mitigation; budget a day per pi release.
- Cache-safe waking of the main session rests on `sendUserMessage` behaving as the type suggests when idle. The spike verifies it; if it fails, the fallback is an outbox flushed on the user's next prompt.
- `ScrollView` and mouse events only exist in fullscreen TUI mode. Regular mode is keyboard only, and was not tested.
- In-process children share the process: an OOM or crash in one agent takes the session down. F16 is the escape hatch.
- Typo-tolerant model resolution can match an unintended family. The resolver refuses when matches span families and echoes the resolved model everywhere, so a wrong pick is visible before spend accrues. Pi's catalog has no release dates, so "newest" compares version numbers in the id only.
- Nesting and the budget handoff have only been exercised through the fake runtime and unit tests, not against a real pi session.
- Agents get no MCP tools and share one model runtime, so providers registered by other extensions cannot be used by agents until a fresh runtime with provider replay is added.
