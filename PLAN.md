# Implementation plan: pi subagents extension

Date: 10 October 2026. Input: `HANDOFF.md` and the four research reports in `research/`.

## 1. Research conclusions that fix the design

These are the decisions the research settles. Everything below assumes them.

| Topic | Decision | Why (report) |
|---|---|---|
| Spawning | In-process `createAgentSession` per agent, behind the adapter. Subprocess (`pi --mode rpc`) stays possible behind the same contract, not built in MVP. | Pi maps `@earendil-works/pi-coding-agent` imports to its own copy, several sessions run concurrently, in-process gives steer/abort/usage/context directly. The whole ecosystem converged on this. (`pi-sdk-sessions-cost.md` §1-2, `existing-subagent-extensions.md` §5.1) |
| Persistence | One agent = one ordinary pi JSONL session file under `<parent session dir>/<parent>/agents/`, with `parentSession` set and a sidecar manifest (status, depth, batch, predecessor/successor). | Shows up nested in `/resume`, gives "closed is final" an on-disk meaning, and lets the viewer read the file after close. (`pi-sdk-sessions-cost.md` §3) |
| Completion | `agent_settled`, never `agent_end`. Empty output is a failure. | `agent_end` fires before retries and compaction; several packages shipped false "done" reports. (`existing-subagent-extensions.md` §5.11) |
| Waking the caller | Single membership-based wake per batch. Child callers: `session.followUp()` on their `AgentSession`. Main session: `pi.sendUserMessage` when idle, held in an outbox while mid-turn. Path lives in the adapter. | `sendMessage({triggerTurn})` skips `before_agent_start` and busts the main session cache (open pi issues #5581, #10267). (`existing-subagent-extensions.md` §5.3-5.4) |
| Spending | Two channels, one process-wide ledger. Synchronous waits return `usage` on the tool result. Background agents report not-yet-delivered usage on the next tool result we own (`agent_status`, collect). Our own footer segment shows main + agents from the ledger. | Extensions cannot write `usage` entries; tool-result `usage` is the only supported path into pi's totals. Cost is pi's catalog estimate on every provider, so "accurate" means "consistent with pi". (`pi-sdk-sessions-cost.md` §4, `pi-extension-api.md` §7) |
| Context budget | Measure with `session.getContextUsage()` on `turn_end`. Disable auto-compaction in the child's in-memory settings, set `reserveTokens` so pi can never pre-empt us, cancel `session_before_compact` as backstop, steer a "write your handoff now" instruction. | Compaction would break the cache and the "closed is final" rule. (`pi-sdk-sessions-cost.md` §6) |
| Settings | Every child gets its own `SettingsManager.inMemory(...)` snapshot. Extension settings live in our own JSON file. | `setAutoCompactionEnabled` and friends write to the user's global `settings.json`; `applyOverrides` is lost on save; pi has no per-extension settings namespace. (`pi-sdk-sessions-cost.md` §1, `pi-extension-api.md` §9) |
| Prompt cache | Freeze system prompt, tool set and tool order at spawn. All later input is appended messages (steer, followUp). Never change model, thinking level or earlier messages mid-agent. Child cache warming off by default. | Mid-conversation prompt or tool changes keep the cache on only about 18 models. (`pi-sdk-sessions-cost.md` §7) |
| Views | Overlay via `ctx.ui.custom(factory, { overlay: true })` using pi's exported `AssistantMessageComponent`, `ToolExecutionComponent`, `Markdown`, `Loader`. Progress widget via `setWidget`. Footer segment via `setStatus`. Collapsible component is ours; pi has none. `ScrollView` needs fullscreen mode. | No API swaps the main transcript for another view. (`pi-extension-api.md` §4, §7) |
| System prompt record | Capture `before_provider_request` on the child's first request and persist it as a custom entry in the child session. `before_agent_start` gives the structured sections for the collapsible view. | Only the provider payload records what every extension actually sent. (`pi-extension-api.md` §3) |
| Agent files | Markdown with YAML frontmatter in `~/.pi/agent/agents` and `.pi/agents` (project files only for trusted projects). Accept the community field names (`name`, `description`, `tools`, `model`, `thinking`, `skills`, prompt append), ignore unknown keys. | Matches Claude Code and every pi package, so users can bring existing files. (`claude-code-agent-ux.md` §5, `existing-subagent-extensions.md` §1) |
| Interaction model | Stop → abort → grace state for questions → close and notify caller. Ask → `steer` while running, `followUp` in grace. Continue → new agent from the handoff file. Route every message by agent id to that agent's session, never through pi's shared queue. | Keeps the handoff's "closed is final" rule, which differs from Claude Code's resume-in-place. Avoids pi issue #10610. |
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
      conformance.test.ts   # run against each pi release
    manager/
      extension-manager.ts  # enables plugins, owns every cross-plugin interaction
      plugin.ts             # Plugin interface: id, deps, enable(host, bus), disable
      bus.ts                # typed in-process events between plugins
      settings.ts           # our own JSON settings file + schema + defaults
    plugins/
      agent-definitions/    # loads agent .md files, base prompt, orchestrator prompt
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
  agents/                   # shipped agent definitions (.md)
  prompts/
    base-system-prompt.md
    orchestrator.md
  docs/  research/
```

Rules enforced by lint and review: `plugins/**` and `components/**` never import `@earendil-works/*`; plugins talk only through the bus and the registry; the manager is the single list of what the extension adds to pi.

**Spike (first task, time-boxed to two days):** run three concurrent child sessions from an extension inside the TUI, assert no interference, cache hit on the second turn of each child (`cacheRead` grows), clean `dispose()`, MCP behaviour, and that waking the idle main session via `sendUserMessage` keeps its `cacheRead` stable. The adapter contract is frozen only after the spike passes.

## 3. Features by release

Each feature lists user value, scope, the plugins it touches, and the acceptance tests. Features inside a release are ordered by dependency.

### Release 0.1 (MVP): run agents in the background, watch them, pay for them

Goal: an orchestrator in the main session can delegate work to one or more background agents, be woken once per batch with results, inspect any agent, stop it, and see combined spend. Nesting is designed in but switched off by default.

**F1 Agent definitions**
- Value: users and the team add agents by dropping a markdown file.
- Scope: loader for `~/.pi/agent/agents/*.md` and `.pi/agents/*.md` with project-over-user precedence; frontmatter schema (`name`, `description`, `model`, `thinking`, `tools`, `skills`, `prompt`, `input`, `output`, `maxTurns`); base system prompt + per-agent additions assembled with `appendSystemPromptOverride`, never a full override (a full override drops pi's tools and rules sections); orchestrator prompt file loaded into the main session; validation errors shown with `notify`.
- Ships with three agents, to be settled with the product owner: `explorer` (read-only search in large repos, returns file list + findings), `implementer` (edits, returns diff summary), `reviewer` (read-only, returns findings). Prompts are a separate task after the loader exists.
- Plugins: `agent-definitions`.
- Tests: frontmatter parsing, precedence, invalid files, prompt assembly snapshot.

**F2 Run agent tool and batches**
- Value: the orchestrator delegates sequentially or in parallel and is woken once.
- Scope: `run_agent` tool taking one or several `{agent, task, input files}`; background by default; a batch is a set of agent ids with an all-settled policy; results held in an outbox and delivered in one wake message; results under a size threshold inline as text, larger ones and all handoffs as files under the agent's directory with the path in the message; wake path per the adapter decision; failure = `stopReason ∈ {error, aborted}` or empty output; global concurrency semaphore; depth carried in the child runtime config, spawn tool not registered at the cap (MVP default max depth 2, configurable to 4 once F10 lands).
- Plugins: `run-agent`, `agent-registry`, adapter spawn.
- Tests: batch of three wakes once; one failure inside a batch still wakes once with the failure marked; large output goes to file; semaphore caps concurrency; cache-read assertion on the main session before and after a wake; wake deferred while the caller is mid-turn.

**F3 Agent status tool**
- Value: the orchestrator checks on one or many agents in one call without waking.
- Scope: `agent_status` tool returning state, elapsed, tokens, context percent, last text line, result path; batch query; carries not-yet-reported usage on its result (spending channel b).
- Plugins: `agent-status`, `spending`.
- Tests: status snapshot shape, usage delivered exactly once.

**F4 Progress rows**
- Value: the user sees what is running without opening anything.
- Scope: one-line start and finish rows per agent in the transcript via custom `renderCall`/`renderResult` (`Done (N tool calls · tokens · elapsed)`); a widget below the editor listing running agents at any depth with status icon, description, live token count, elapsed; finished rows linger about 30 seconds, failed and stopped longer; render throttled.
- Plugins: `progress-widget`; component `agent-row`.
- Tests: row formatting, throttle, linger timing.

**F5 Agent view (read and stop)**
- Value: the user inspects any agent and the exact prompt it was sent; this is the debugging record.
- Scope: overlay opened from the widget or `/agents <id>`; reads the agent's session file, so it works after close; first block is the full effective system prompt, skills, tools and tool guidelines as collapsible sections built from the persisted `before_provider_request` snapshot; transcript rendered with pi's own message and tool components; `ScrollView` in fullscreen mode, manual windowing otherwise; `x` stops the agent (abort → closed, caller notified); `Esc` closes the view.
- Plugins: `agent-view`; components `collapsible`, `system-prompt-block`.
- Tests: snapshot of the prompt block from a recorded session; view opens for a closed agent; stop transitions state and notifies the caller once.

**F6 Spending footer**
- Value: one number for what the whole tree cost, consistent with pi's own accounting.
- Scope: process-wide ledger keyed by agent id, high-water-mark per agent persisted as custom entries in the parent session so reloads never double count; footer segment `main $x · agents $y · total $z` via `setStatus`; tool-result `usage` on synchronous waits; subscription usage shown as pi shows it.
- Plugins: `spending`.
- Tests: nested agents counted once; reload keeps totals; pi `/session` total equals our main figure plus delivered agent usage.

**F7 Agent context budget with handoff file**
- Value: an agent in a huge repo never silently loses its context; its work survives as a file.
- Scope: budget default 100k tokens or derived from the model window, per-agent override; soft warning steered at 80 percent; at the budget the agent is steered to write a handoff file with a fixed schema (Status, Outcome, Evidence, Blocker, Next, files touched); auto-compaction disabled in the child, `reserveTokens` set, `session_before_compact` cancelled; the agent closes and the caller is woken with the handoff path. Successor spawn is F9.
- Plugins: `limits`, `handoff`.
- Tests: budget trigger at the right turn, handoff file validated against schema, compaction never runs in a child.

**F8 Packaging, README, CI**
- Scope: `pi install` from the repo and from npm, `/reload` safe (stale `ctx` guard, agents interrupted by reload marked failed, never restarted), Biome and Vitest in CI, adapter conformance test pinned to pi 1.1.0, short README (needs, install, update).

### Release 0.2: talk to agents, nest them, keep going

**F9 Successor chain**
- At the budget, spawn a successor from the handoff file in the same batch slot without waking the caller; the caller sees one logical agent with a chain of sessions; manifests link predecessor and successor; progress row shows the chain index.
- Tests: three-link chain returns one result; caller woken once.

**F10 Nesting to depth 4**
- Children get `run_agent` and `agent_status`; tree-wide semaphore with reserved capacity so waiting parents cannot deadlock the tree; default depth 3, max 4; every level uses the same registry, rows, view and wake code.
- Tests: grandchild batch wakes the child only; deadlock scenario with the semaphore full of waiting parents.

**F11 Ask a question and stop grace period**
- Agent view gains an input box; `Enter` sends a `steer` to a running agent, a `followUp` to one in grace; after `x` the agent enters a grace state for a configurable delay during which questions can be asked; when the delay ends it notifies its caller and closes; countdown shown in the row.
- Tests: message routing by agent id, grace timer, close after grace is final.

**F12 Agent list view**
- `/agents` overlay listing all agents grouped by state (working, needs attention, done, failed, closed), with `↑`/`↓`, `Enter` to open the agent view, `x` to stop, stop-all chord with confirmation, filter by status or agent name.

**F13 Main session limits**
- Separate plugin with soft and hard limits on the main session's context; footer segment turns orange at the soft limit; at the hard limit the session writes a handoff as its very next step and a new session is created from it. Session switching only works from command handlers, so the plugin triggers a registered command.
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
| Platform | adapter, manager, registry, run-agent, status, limits, spending ledger, packaging | spike → F2 → F3 → F7 → F6 ledger → F8 |
| Experience | components, progress rows, agent view, footer segment, list view | collapsible + rows (mock registry) → F4 → F5 → F6 footer |
| Agents | definitions loader, base and orchestrator prompts, agent set, handoff schema, result contract wording | F1 loader → prompts → F7 handoff schema |

Dependencies: F4 and F5 need the registry's event shape from F2, so the registry interface is defined in the skeleton week and mocked by the experience stream. F7 needs F1's prompt assembly and F2's steer path.

## 5. Decisions still open for the product owner

1. **Agent set and prompts.** The three proposed starter agents are a suggestion; the handoff leaves the set undesigned.
2. **Closed is final.** Research confirms Claude Code resumes agents in place. The plan keeps the handoff rule (continuation only via a new agent from a handoff file). Confirm.
3. **Nesting in MVP.** The plan designs for depth 4 from the start but ships depth 2 in 0.1 to keep the semaphore and deadlock work out of the first release. Confirm.
4. **Accuracy of spend.** Pi computes cost from its catalog on every provider, so OpenRouter and subscription figures are estimates. The plan defines "accurate" as "matches pi's own accounting". Confirm.
5. **tintinweb compatibility** in 0.3: worth doing only if the team wants pi-tasks users.

## 6. Risks carried into design

- Pi shipped 1.0.0 and 1.1.0 within a week with 48 breaking-change sections in the changelog. The adapter plus conformance test is the mitigation; budget a day per pi release.
- Cache-safe waking of the main session rests on `sendUserMessage` behaving as the type suggests when idle. The spike verifies it; if it fails, the fallback is an outbox flushed on the user's next prompt.
- `ScrollView` only works in fullscreen TUI mode. Regular mode gets manual windowing, which is more work in F5.
- In-process children share the process: an OOM or crash in one agent takes the session down. F16 is the escape hatch.
