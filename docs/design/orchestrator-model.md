# Orchestrator model: a capable main session that decides and delegates

Status: proposal, 2026-10-17. Branch `feat/agent-workflow-revamp`, pi 1.3.0. Supersedes the delegate-only default in agent-workflow.md; the roster, brief template, result contract, fetch tool and call-time skills from that design stay.

Research date: 2026-10-17. Evidence: [orchestrator-capability.md](../research/orchestrator-capability.md) (model tiers), [settings-and-skills-layering.md](../research/settings-and-skills-layering.md) (settings, skills, MCP). The user's earlier plan-mode research is cited as future-plans/plan-mode.md. Repo references are `file:line` on this branch; `PI/` means `node_modules/@earendil-works/pi-coding-agent`. Model values in settings examples are placeholders (`provider/id`); they are user data, not code.

## Decision

The main session runs on a capable model and both decides and delegates. Delegate-only on a cheap model is not the default. Cost is controlled by phase and by delegating the work, not by weakening the decision maker.

Three pillars:

1. **The direct test failed.** Cognition ran a fast, cheaper sub-frontier primary with a strong planning helper, which is the shape agent-workflow.md proposes (cheap coordinator, strong `planner`): "the quality ceiling was set by the primary, and the primary wasn't strong enough"; making a weaker primary work is "still an open problem, and we think it's a training one" (Cognition, "Multi-Agents: What's Actually Working", 2026-04-22).
2. **The planner matters more than the executor.** "A weak planner degrades overall clean task performance more severely than a weak executor" (PEAR, arXiv 2510.07505, v4 2026-01-08). MAST (NeurIPS 2025) puts about 44% of multi-agent failures in specification and system design and about 24% in verification; both are the coordinator's decisions.
3. **Nobody ships it.** Claude Code, Codex, Cursor, Gemini CLI and Amp default to a capable main model with subagents inheriting it. Roo's delegate-only Orchestrator mode has no official model guidance, and Kilo, which shipped the same mode, now marks it deprecated (orchestrator-capability.md, verdict d).

The supporting pattern is the reverse split: a strong planner with cheaper executors. Claude Code's `opusplan` (strong model in plan mode, cheaper in execution), Aider architect/editor (2024-09-26: strong architect with a cheap editor matched or beat the strong model alone), Anthropic's research system (Opus lead, Sonnet workers, +90.2%, 2025-06-13), Cursor swarms (strong planner, cheap workers, $1,339 against $10,565, 2026-07-20) and Devin Fusion (frontier main agent "making the significant decisions", cheaper sidekick, about 60% lower cost, 2026-06-29).

What this changes in agent-workflow.md: its first goal ("The main session is a coordinator that can run on a cheap model") and its "Second opinion" verdict ("viable, but it is an experiment") are replaced. Its goal that the main-session prompt and tool list stay byte-stable within a session, and its non-goal "No per-agent MCP filter", are revised below (prompt and tools change at phase transitions only; MCP per agent). Its statement that docs/ is gitignored no longer holds: docs/ is tracked.

## The user's pros and cons, answered

**Cheap orchestrator, minus 1: not capable of decisions.** Agree. The routing table in `extensions/subagents/prompts/main-session.md:3-14` removes decisions only for requests that already have a clear shape. Its first row ("Multi-step, a design choice ... `planner`") is itself a judgement, as agent-workflow.md "Second opinion" admits. Validating a plan with the user, judging whether a result answers the brief, and deciding what to do with a `partial` result are decisions that no table removes. MAST's top modes (disobeying the task spec 11.8%, incorrect verification 9.1%) sit exactly there.

**Cheap orchestrator, minus 2: over-spawning leads because finished agents cannot be followed up.** The user is right about the code.
- `message_agent` (`extensions/subagents/src/plugins/run-agent/tools.ts:283-314`) routes through `route` (`runner.ts:920-957`), which rejects closed agents: "closed agents cannot receive messages. Start a new agent instead." (`runner.ts:929-934`). Every state except `queued`, `running` and `grace` is closed (`model/types.ts:7-9`). `grace` is the window after a stop request, not after a normal finish (`runner.ts:453-460`).
- On finish the child session is disposed: the `settled` event calls `finish` then `releaseLive` (`runner.ts:555-556`), which runs `teardown` and `disposeLive`, ending in `child.dispose()` (`finish` 393-422, `releaseLive` 319-325, `teardown` 303-317, `disposeLive` 285-301, dispose at 299).
- The child's JSONL stays on disk (`core/adapter/pi-child.ts:225-227`, session dir `agentsDirFor(info)/<agentId>`, `model/paths.ts:9-10`), but only the read-only `/agents` view reads it (`plugins/agent-view/loader.ts:30`). Nothing reopens it. A handoff chain starts a new session from a handoff file; it is not a resume (`continueChain`, `runner.ts:363-391`).
- Consequence: every follow-up to a planner or reviewer is a fresh spawn with a re-brief, and the new agent re-reads what the old one already knew. The cost of that is unsourced, but Anthropic (2025-06-13) reports that vague briefs cause duplicated work, and Cognition (2025-06-12) says to share full traces. Fix: see "Resumable leads".

**Cheap orchestrator, minus 3: needs a nested interactive plan session.** Agree that one-shot planning is not enough: every vendor keeps planning interactive in the user-facing thread, and validation of findings is iterative (orchestrator-capability.md, "Plan-mode interaction loops"; future-plans/plan-mode.md, "Recommended user experience" steps 3 to 6). Disagree that it needs a second pi process overlaid on the TUI. Pi has no nested interactive session API; session switching replaces the main session (`newSession`, `fork`, `switchSession`, `PI/dist/core/extensions/types.d.ts:292-323`), and the repo builds only non-interactive children (`pi-child.ts:261`, `mode: "print"`). The primitives that are needed all work in the same session:
- `setActiveTools` to swap the tool set (used today by the adapter, `core/adapter/pi-adapter.ts:93-139`);
- `before_agent_start` returning `{ systemPrompt }` per turn (`types.d.ts:1125-1129`);
- `setModel` and `setThinkingLevel` (`types.d.ts:1293-1305`);
- the `input` event to intercept editor input (`types.d.ts:908-930`);
- UI overlays and forms (`core/adapter/contract.ts:181-185`: status, confirm, widget, overlay, form).

So plan mode is a mode of the same session, not a second process. The safety and approval design in future-plans/plan-mode.md still applies: owner-scoped tool policy, a `tool_call` block as the execution boundary, revision-bound approval, fail-closed without UI.

**Cheap orchestrator, plus 1: good for executing an approved plan.** Agree. Once the plan fixes the decisions, execution is routing and status-checking. Cursor's swarm planner splits and delegates while cheaper workers execute (2026-07-20); Aider's cheap editors applied a strong architect's plan at equal or better scores (2024-09-26); `opusplan` runs execution on the cheaper model. This becomes the `build` phase below.

**Capable orchestrator, minus 1: expensive.** Partly. Three things cap the cost: session-limits hands the main session off at 0.75 of the context window (`extensions/session-limits/src/settings.ts:5-10`, `limits.ts:79-105`), so its context does not grow without bound; scouts do the reading, so the main context stays small; and the `build` phase may run on a cheaper model. The cost is still real: in Cursor's swarm the strong planner was about two thirds of the $1,339 even with cheap workers (2026-07-20). That spend is where quality is decided, which is why it is the last place to save.

**Capable orchestrator, minus 2 and 3: the user may pick a weak model; the main session carries more responsibility.** Agree; both are acceptable. `/agents setup main` and the phase defaults make the model choice explicit and visible. Note that this machine's pi default model is a small model (`~/.pi/agent/settings.json`, per [model-tiers.md](../research/model-tiers.md)), so taking this decision means setting a capable default or a `main.decide.model`.

**Capable orchestrator, plus 1: no plan mode needed.** Partly disagree. A capable model still benefits from a read-only mode with an approval gate; every vendor ships one (Cursor 2025-10-07, Claude Code, Codex UNVERIFIED, Cline, Factory). Claude Code's own guidance also says "If you could describe the diff in one sentence, skip the plan" and "Plan mode ... adds overhead", so it should be opt-in. It becomes small: a tool profile, a prompt addendum and an optional model, not a new process.

**Capable orchestrator, plus 2: skills work far better.** Agree. Pi lists each skill as one `<skill>` entry (name, description, location) in the system prompt and the model reads the file on demand (`PI/dist/core/skills.js:278-303`, `system-prompt.js:105-108`). A capable main session can see every company skill at about 100 tokens each (Agent Skills client guide) and pass the fitting ones per task through the existing `skills` parameter of `run_agent` (`runner.ts:112-116, 607`). The precedents for "list in the main session, narrow for subagents" are the Agent SDK session option `skills` ("The model doesn't see unlisted skills"), the Agent Skills spec ("Hide filtered skills entirely from the catalog"), Deep Agents' per-subagent lists, and the skill-shadowing result (up to 21% lower pass rate at 202 skills, ICML 2026 workshop). Claude Code's `skills:` field is a definition-time list too, but it preloads bodies and does not narrow (unlisted skills stay invocable).

## Phases of the main session

One session, three phases. A phase is a tool profile, a prompt variant and an optional model and thinking level, all read from settings. Phase changes happen only at explicit transitions, so the system prompt and tool list stay byte-stable between transitions (the agent-workflow.md goal, relaxed from "within a session" to "within a phase"). Each transition costs one prompt-cache miss; a model change costs the whole cache.

| Phase | Entered by | Model | Tools | Produces |
| --- | --- | --- | --- | --- |
| `decide` (default) | session start; end of `build`; `/decide` | `main.decide.model`, else the user's selected model | `read`, `grep`, `find`, `ls`, `questionnaire`, `run_agent`, `message_agent`, `agent_status`, `write` (handoff files only, see below) | Answers, briefs, small direct delegations, or a suggestion to `/plan` |
| `plan` | `/plan` (explicit) | `main.plan.model`, else unchanged | `decide` tools; the `write` guard also allows the plan store; `run_agent` admits only agents that cannot write | A versioned plan under the session dir, approved by revision |
| `build` | approving a plan revision, or `/build` | `main.build.model`, else unchanged; may be cheaper | Agent tools plus `delegateOnlyTools` (today's `delegateOnly` set, `run-agent/index.ts:166-174`) | Batches routed to implementer and reviewer; status relay |

**`decide`.** The capable main session talks to the user, asks clarifying questions, reads one short file when that is all a brief needs, and otherwise sends scouts. It writes briefs with the existing template and judges results. It may send a well-shaped change straight to `implementer` then `reviewer` (today's routing row 3) without a plan. Cognition's warning that managers without codebase context become "overly prescriptive" (2026-04-22) is why `decide` keeps read access instead of none. `bash` and `edit` stay off: the main session decides and delegates; it does not do the work.

**`plan`.** Same as `decide`, plus the plan artifact and the approval gate from future-plans/plan-mode.md: the artifact lives under the session dir (AGENTS.md storage rule), is versioned, and Build is enabled only by a user action bound to the current revision and content. Read-only is enforced twice: `setActiveTools` hides mutating tools, and a `tool_call` guard blocks them at execution, like pi's example (`PI/examples/extensions/plan-mode/index.ts:22-23, 93-112, 164`). Hiding alone is not enough: `tools: all` agents rebuild the parent's tool set from active plus removed tools (`parentTools`, `core/adapter/pi-adapter.ts:162-169`), so in `plan` the `run_agent` admission check must also refuse agents that can write (implementer, general, shell, worktree agents). Pi's example filters `bash` by regex, which future-plans/plan-mode.md rightly calls unreliable; `plan` therefore has no `bash`.

**`build`.** Optional cheaper model, delegate-only tools. The main session routes the approved plan's batches to `implementer` and `reviewer` (the existing "run a planner result batch by batch" rule), judges only `Status:` lines and reviewer verdicts, and relays progress. It returns to `decide` (restoring the `decide` model) when the plan is done or when any result comes back `blocked`, or a reviewer verdict asks for a decision. It does not re-plan; that is a decision.

**Session handoff and `write`.** session-limits asks the main session to write `<tmpdir>/pi-session-limits/<sessionId>-handoff.md` (`extensions/session-limits/src/limits.ts:79-105`), which is why `write` is in `delegateOnlyTools` today. All three phases keep `write`, guarded by a `tool_call` check that allows only the handoff paths (and in `plan`, the plan store). The successor session starts in `decide`.

**Settings sketch** (`pi-subagents.json`, user and project):

```json
{
  "main": {
    "decide": { "model": "provider/capable-id", "thinking": "high" },
    "plan": { "thinking": "high" },
    "build": { "model": "provider/cheaper-id", "thinking": "medium", "tools": ["read", "write", "questionnaire"] }
  }
}
```

Every field is optional. With no `main` key, all phases use the user's selected model and thinking level, which matches future-plans/plan-mode.md ("Preserve the user's model and thinking settings ... not automatic model switching"): switching models is opt-in. `tools` replaces the phase's default extra tools, as `delegateOnlyTools` does today.

**Model switching.** On a transition the controller calls `setModel` and `setThinkingLevel` through the adapter. `setModel` returns `false` when the model has no credentials (`types.d.ts:1293-1298`): the session stays on its current model, the user gets a warning naming the phase and the model, and the phase status shows the model actually in use. A manual `/model` choice during a phase (seen as `model_select` with a user source, `types.d.ts:885-890`) wins until the next transition. Leaving `build` restores the `decide` model.

**`delegateOnly`.** `delegateOnly: true` becomes the `build` profile instead of a global default. Migration: if a settings file sets `delegateOnly: true` and no `main` key, keep today's behaviour for that user (delegate-only in every phase) and print a one-time notice; `delegateOnlyTools` becomes the default of `main.build.tools`.

## Resumable leads

The aim is that the main session can send a follow-up to a planner or reviewer that already answered, instead of starting a new one and re-briefing it.

**Option A: `hold` (recommended first step).** A `run_agent` item takes `hold: true`. When the agent replies, its in-process child session stays open in a new `idle` state instead of being disposed. `message_agent` resumes it with its full context through the existing `resume` path (`runner.ts:214-243`), the same way a between-turns message is delivered today (`runner.ts:954-956`). The timer and re-open logic reuse the grace mechanism (`armGrace`, `runner.ts:453-460`).
- Idle agents cost no tokens and hold no concurrency slot (`resume` acquires a slot per turn, `runner.ts:223`). A resumed turn re-sends the agent's context; whether the provider cache is still warm depends on the gap (unsourced).
- Closed by: an explicit close (there is no `stop_agent` tool today; stopping is the panel's `x` and the abort path in `tools.ts:240`, so this needs either a `close: true` flag on `message_agent` or a new tool), by main session end (`runner.shutdown`, `run-agent/index.ts:177-181`), or by a `holdMinutes` setting (default 30). A `maxHeld` setting (default 4) bounds memory.
- Registry and view: `AgentState` gains `idle` (a record state, separate from the runner's per-turn `live.turn = "idle"`); `isClosed` treats it as open for routing (`model/types.ts:9`). It must **not** count as busy, and `hasOpenAgents` derives busy from `isClosed` today, so it needs its own check, or held agents would block session-limits' automatic handoff, which waits while any `pi:busy` source is active (`plugins/agent-registry/index.ts:9, 17-20`; `extensions/session-limits/src/limits.ts:155-179`). The panel shows `idle · closes in 24m`; `agent_status` and `manifest.json` report `idle`; `/agents` shows the transcript as today. The batch's "all done" wake-up treats `idle` as finished.

**Option B: `resume: <agentId>` (phase 2).** A `run_agent` item names a finished agent; the runner reopens its JSONL with `SessionManager.open(path, sessionDir?, cwdOverride?)` (`PI/dist/core/session-manager.d.ts:378`) and passes it to `createAgentSession({ sessionManager })` (`PI/dist/core/sdk.d.ts:60`). This survives process restarts and `/reload`, and works for agents that were not held.
- More work: look up the manifest by id across the session's agent dir (`model/paths.ts:9-10`), restore cwd (a worktree may be removed by then), re-bind tools, skills and MCP from the current definition, and decide what a resumed handoff chain means (resume the chain terminal, `model/types.ts:11-15`).
- Registry and view: a resumed agent gets a new record linked to the old one (like `successorId`), so `/agents` shows it as a continuation (`#2`), and the old record stays closed.

Recommendation: A first, because it is a state and lifetime change inside the runner with no new persistence. B after A if follow-ups across restarts turn out to matter. The main-session prompt gains one rule: hold a planner or reviewer when you expect to ask it again; message it instead of starting a new one.

## Skills: where the list lives

| Option | What | Verdict |
| --- | --- | --- |
| A | Keep `skills:` in the agent definition and keep the call-time `skills` union (`runner.ts:112-116`) | **Recommended** |
| B | Call-time only; drop the frontmatter field | Rejected: loses static per-repo setup, and departs from every product (all bind at definition time) |
| C | Frontmatter only; drop the call-time parameter | Rejected: forces one agent per domain, or `skills: all` |

A matches every product's definition-time list (Claude Code `skills:`, Agent SDK `AgentDefinition.skills`, Deep Agents per-subagent `skills`). Per-repo differences come from a project override of the agent: a shadow file, or the per-field override below. The call-time parameter is this project's addition; no product has one (settings-and-skills-layering.md), so the README should say so plainly. With a capable main session the parameter becomes more useful, not less: the main session sees the whole catalog and can pick skills by fit. agent-workflow.md ("Dynamic skills") guarded against a weak coordinator picking skills by keyword with a rule to pass `skills` only when the user named one; the shipped prompt already asks for skills "whose descriptions fit the task" (`prompts/main-session.md:27`), and a capable main session is what makes that rule safe.

`general` keeps `skills: all`, mirroring Deep Agents' general-purpose subagent. The chores (scout, fetch, shell, image) take none.

**Shipping our own skills (optional).** An extension can contribute skill paths through pi's `resources_discover` event, which returns `skillPaths` (`PI/dist/core/extensions/types.d.ts:557-562`, applied in `PI/dist/core/agent-session.js:2655-2670`). Candidates: a brief-writing skill and a plan-format skill that the main session reads when it needs them, instead of `main-session.md` growing. Both would then be listed to the main session at one entry each and passable to agents. This is optional and not needed for the decision.

## Settings layering and per-field overrides

**Today.**
- Agent definitions: shipped < user `<agentDir>/agents` < project `<cwd>/.pi/agents` (trusted only), whole-file shadowing by name; the later layer wins at `definitions.set` (`plugins/agent-definitions/index.ts:25-33`, `loader.ts:164-199`, `:188`).
- `pi-subagents.json`: user `<agentDir>` and trusted project `<cwd>/.pi/`, merged `{ ...defaults, ...user, ...project }`; `disabledPlugins` is user-only (`model/settings.ts:79-98`).
- Pi's own settings: global and project `settings.json`, deep-merged with project winning, arrays replaced, `defaultTools` taking `+name` / `-name`, project only when trusted (`PI/dist/core/settings-manager.js:19-33, 78-85, 95-99, 257-259`).

**Add: per-field agent overrides** in `pi-subagents.json`:

```json
{
  "agents": {
    "implementer": { "model": "provider/id", "thinking": "high", "skills": ["+tdd"], "mcp": ["github"] },
    "scout": { "limit": 200000 }
  }
}
```

Fields: `model`, `thinking`, `skills`, `tools`, `mcp`, `limit`. Merge order: load the definition as today (shipped, user, project file), then apply the user override, then the project override, field by field. `thinking` replaces the `:thinking` suffix of the definition's `model`. List fields replace the definition's list, except that entries written `+name` or `-name` edit it, as pi's `defaultTools` does. Unknown agent names and fields are reported as settings errors, like other bad keys.

Why per-field beats copying the agent file into every repo: a shadow file freezes the shipped prompt at the time of copying, so prompt fixes in later releases never reach that repo. An override changes one field and keeps the shipped body. Gemini CLI's `agents.overrides` (model, maxTurns for built-in agents) is the only per-field precedent found; Claude Code, Codex, Cursor and Roo shadow whole files (settings-and-skills-layering.md). Kilo's "properties merge" is the other field-level precedent.

This also changes the settings merge: `main` and `agents` need a per-key deep merge (user then project per agent and per field), not the top-level spread at `settings.ts:97`, and the settings schema needs an object type (`core/manager/settings.ts:6-12` has number, list, boolean and choice rules today).

**Out of scope: a `.pi/pi-subagents.local.json` layer.** Claude Code has `settings.local.json`, but pi has no local layer for its own settings, and adding one only here would be the odd one out. Revisit if pi adds one.

## MCP per agent

Today MCP follows `tools`: a child gets `mcp__*`, codemode, tool search and the MCP resource tools unless its `tools` list is empty (`tools: all` included), and none with `tools: []` (`core/adapter/pi-child.ts:99-133`; README notes there is no per-agent filter).

Add `mcp: [serverName]` to agent definitions and to overrides. Absent keeps today's behaviour; `[]` means no MCP; a list is translated to `mcp__<server>__*` patterns in the child's `tools` list instead of `mcp__*`. Pi's `createAgentSession` accepts patterns (`PI/dist/core/sdk.d.ts:33-56`) and names server tools `mcp__<server>__<tool>` (`PI/dist/extensions/mcp/index.js:283-336`). Precedents: Claude Code's `tools` naming a server grants only that server's tools (2.1.299, 2026-10-14) and its `mcpServers` frontmatter; Gemini CLI's `mcpServers` and `mcp_server_*` wildcards.

Caveat: pi's default MCP exposure is `codemode` (`mcp/index.js:59-73`), where calls go through the `codemode` tool rather than `mcp__<server>__<tool>` names. A name pattern alone may not stop codemode from reaching other servers. Before claiming per-server scoping, verify how codemode resolves servers in a child, and if needed load the child's MCP extension with only the listed servers or force `direct` exposure for scoped agents. future-plans/plan-mode.md makes the same point about codemode and deferred tools crossing a policy check.

## `/agents setup` command

TUI only. In `rpc`, `json` and `print` modes it fails with a message that names the settings file to edit (`ctx.mode`, `types.d.ts:216-217`).

Flow:
1. **Scope:** user (`<agentDir>/pi-subagents.json`) or project (`<cwd>/.pi/pi-subagents.json`); project is offered only when the project is trusted.
2. **Target:** an agent name, or `main` (then pick `decide`, `plan` or `build`).
3. **Fields:**
   - model: from pi's model list filtered to providers with credentials (`core/adapter/pi-models.ts`, which already reads `hasConfiguredAuth`), plus "inherit";
   - thinking level: the levels the chosen model supports;
   - skills: multi-select from the main session's skill list;
   - MCP servers: names from `mcp.json` (user and project);
   - tools: the definition's list, deselect only;
   - limit.
4. **Write and show:** writes only the override keys that changed, then shows the merged result (definition plus user plus project) with the layer each field came from.

It takes effect at the next session start, or at once if the definitions loader and settings re-run on write (the loader already re-runs at each session start, `plugins/agent-definitions/index.ts:25-33`). A non-interactive form serves scripts: `/agents setup <agent> model=... thinking=... skills=a,b mcp=x scope=project`.

UI primitives: status, confirm, overlay and form (`core/adapter/contract.ts:181-185`), as listed in future-plans/plan-mode.md. The `/agents` command lives in the agent-view plugin and treats its argument as an agent id (`plugins/agent-view/index.ts:130-146`), so `setup` must be reserved as a subcommand there or the command given its own name.

Note that Claude Code removed its `/agents` wizard in 2.1.198 (2026-07-01) in favour of "ask Claude to create or manage subagents, or edit `.claude/agents/` directly" (settings-and-skills-layering.md). A capable main session could do the same by editing `pi-subagents.json`. The command is still worth having because it validates models against credentials and shows the merged result, which a model editing JSON does not.

## What changes in the current branch

| # | Work package | Depends on | Size | Needed for the decision |
| --- | --- | --- | --- | --- |
| 1 | **Settings schema**: object type in `core/manager/settings.ts`; `main.{decide,plan,build}.{model,thinking,tools}`; per-key deep merge for `main` and `agents`; `delegateOnly` migration notice | | M | Yes (`main` only) |
| 2 | **Adapter**: expose `setModel`, `setThinkingLevel`, `model_select`, a `tool_call` block hook and a per-phase tool restriction that composes with other owners (future-plans/plan-mode.md "Shared infrastructure") | | M | Yes (model and tools); the block hook is needed for `plan` |
| 3 | **Prompts**: split `main-session.md` into a `decide` variant (decides, reads one short file, scouts, briefs, judges, may suggest `/plan`) and a `build` variant (today's routing and batch rules); plan addendum later | | M | Yes |
| 4 | **Phase controller** in the run-agent plugin: apply the profile at session start, `/decide` and `/build` commands, return to `decide` on plan done, a `blocked` result or a reviewer verdict that asks for a decision, phase status line; `delegateOnly` becomes the `build` profile | 1, 2, 3 | M | Yes |
| 5 | **Runner `hold`**: `idle` state, `hold` item field, `holdMinutes`, `maxHeld`, close path, busy exclusion, panel and `agent_status` rows | | M | Follow-up (high value) |
| 6 | **Loader override merge**: apply `agents.<name>` user then project, `+`/`-` list edits, `thinking` suffix, errors | 1 | M | Follow-up |
| 7 | **MCP per agent**: `mcp` field in schema and overrides, pattern translation in `pi-child.ts`, codemode verification | 6 | M | Follow-up |
| 8 | **`/plan`**: plan store under the session dir, revisions, approval bound to revision, read-only guard, `run_agent` admission check for writing agents | 2, 4 | L | Follow-up |
| 9 | **`/agents setup`**: TUI flow and non-interactive form | 1, 6, 7 | M | Follow-up |
| 10 | **Resume by id** (Option B) | 5 | L | Later |
| 11 | **Tests and docs**: unit tests per package; live routing suite updated for `decide`; README (phases, overrides, `hold`, call-time skills as this project's addition), ARCHITECTURE.md, STRUCTURE.md (agent-workflow.md already carries a Status pointer to this document) | each | M total | Yes for 1 to 4 |

Minimum for the decision to take effect: 1 (only `main`), 2 (only model switching and tool restriction), 3 and 4, with their tests. The smallest possible step, if 1 to 4 must wait, is to set `delegateOnly` default to `false` and ship the `decide` prompt; that already makes the main session a deciding coordinator on the user's model.

## Open questions

1. Should `decide` keep `grep`, `find` and `ls`, or only `read` with everything else sent to scouts?
2. With no `main.build.model` set, should `build` stay on the `decide` model (proposed) or should the shipped defaults suggest a cheaper one?
3. Plan mode inside the subagents extension (proposed here, because phases share its settings and tool restriction) or the separate `extensions/plan-mode/` that future-plans/plan-mode.md proposes, with shared contracts in `core/manager`?
4. `hold` opt-in per call (proposed), or the default for `planner` and `reviewer`?
5. Command name: `/agents setup` with `setup` reserved as an id, or a separate command?
6. For users with `delegateOnly: true` in their own settings file: keep delegate-only in every phase with a notice (proposed), or map it silently to the `build` profile?
