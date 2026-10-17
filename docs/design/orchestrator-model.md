# Orchestrator model: a capable main session that decides and delegates

Status: proposal, 2026-10-17; revised 2026-10-17 round 2 (two modes, no hold, three-layer skills, codemode preserved); revised 2026-10-17 round 3 (plan mode deferred, UI and result work packages added); round 3, reviewed 2026-10-17 (see "Review round (2026-10-17)"). Branch `feat/agent-workflow-revamp`, pi 1.3.0. Supersedes the delegate-only default in agent-workflow.md; the roster, brief template, result contract, fetch tool and call-time skills from that design stay.

Research date: 2026-10-17. Evidence: [orchestrator-capability.md](../research/orchestrator-capability.md) (model tiers), [settings-and-skills-layering.md](../research/settings-and-skills-layering.md) (settings, skills, MCP), [nesting-modes-and-setup.md](../research/nesting-modes-and-setup.md) (nesting depth, mode switching, agent creation), [subagent-results.md](../research/subagent-results.md) (what a parent receives), [migration-portability.md](../research/migration-portability.md) (skills, MCP and agents from other tools). The removal itself is itemised in [delegate-only-removal.md](delegate-only-removal.md). The user's earlier plan-mode research is cited as future-plans/plan-mode.md, the user's local note (untracked). Repo references are `file:line` on this branch; `PI/` means `node_modules/@earendil-works/pi-coding-agent`, and `T`, `R` and `AS` mean `PI/dist/core/extensions/types.d.ts`, `PI/dist/core/extensions/runner.js` and `PI/dist/core/agent-session.js`. Model values in settings examples are placeholders (`provider/id`); they are user data, not code.

## Decision

The main session runs on a capable model and both decides and delegates. Delegate-only on a cheap model is not the default. Cost is controlled by delegating the work, not by weakening the decision maker.

Three pillars:

1. **The direct test failed.** Cognition ran a fast, cheaper sub-frontier primary with a strong planning helper, which is the shape agent-workflow.md proposes (cheap coordinator, strong `planner`): "the quality ceiling was set by the primary, and the primary wasn't strong enough"; making a weaker primary work is "still an open problem, and we think it's a training one" (Cognition, "Multi-Agents: What's Actually Working", 2026-04-22).
2. **The planner matters more than the executor.** "A weak planner degrades overall clean task performance more severely than a weak executor" (PEAR, arXiv 2510.07505, v4 2026-01-08). MAST (NeurIPS 2025) puts about 44% of multi-agent failures in specification and system design and about 24% in verification; both are the coordinator's decisions.
3. **Nobody ships it.** Claude Code, Codex, Cursor, Gemini CLI and Amp default to a capable main model with subagents inheriting it. Roo's delegate-only Orchestrator mode has no official model guidance, and Kilo, which shipped the same mode, now marks it deprecated (orchestrator-capability.md, verdict d).

The supporting pattern is the reverse split: a strong planner with cheaper executors. Claude Code's `opusplan` (strong model in plan mode, cheaper in execution), Aider architect/editor (2024-09-26: strong architect with a cheap editor matched or beat the strong model alone), Anthropic's research system (Opus lead, Sonnet workers, +90.2%, 2025-06-13), Cursor swarms (strong planner, cheap workers, $1,339 against $10,565, 2026-07-20) and Devin Fusion (frontier main agent "making the significant decisions", cheaper sidekick, about 60% lower cost, 2026-06-29).

What this changes in agent-workflow.md: its first goal ("The main session is a coordinator that can run on a cheap model") and its "Second opinion" verdict ("viable, but it is an experiment") are replaced. Its goal that the main-session prompt and tool list stay byte-stable within a session stands: with no plan mode, nothing changes the tool list (see "No plan mode for now"). Its non-goal "No per-agent MCP filter" is revised to a per-agent on/off switch (see "Codemode and MCP"). Its statement that docs/ is gitignored no longer holds: docs/ is tracked.

## The user's pros and cons, answered

**Cheap orchestrator, minus 1: not capable of decisions.** Agree. The routing table in `extensions/subagents/prompts/main-session.md:3-14` removes decisions only for requests that already have a clear shape. Its first row ("Multi-step, a design choice ... `planner`") is itself a judgement, as agent-workflow.md "Second opinion" admits. Validating a plan with the user, judging whether a result answers the brief, and deciding what to do with a `partial` result are decisions that no table removes. MAST's top modes (disobeying the task spec 11.8%, incorrect verification 9.1%) sit exactly there.

**Cheap orchestrator, minus 2: over-spawning leads because finished agents cannot be followed up.** The user is right about the code.
- `message_agent` (`extensions/subagents/src/plugins/run-agent/tools.ts:280-314`) routes through `route` (`runner.ts:920-957`), which rejects closed agents: "closed agents cannot receive messages. Start a new agent instead." (`runner.ts:929-934`). Every state except `queued`, `running` and `grace` is closed (`model/types.ts:7-9`).
- On finish the child session is disposed (`runner.ts:555-556`, ending in `child.dispose()` at 299). The child's JSONL stays on disk (`core/adapter/pi-child.ts:225-227`), but only the read-only `/agents` view reads it.
- Consequence: every follow-up to a planner or reviewer is a fresh spawn with a re-brief. With a capable main session this matters less than it did for a cheap one, and the answer for now is not to hold agents (see "No resumable or held leads for now").

**Cheap orchestrator, minus 3: needs a nested interactive plan session.** Agree that one-shot planning is not enough: every vendor keeps planning interactive in the user-facing thread (orchestrator-capability.md, "Plan-mode interaction loops"; nesting-modes-and-setup.md, B). Disagree that it needs a second pi process overlaid on the TUI. Pi has no nested interactive session API; session switching replaces the main session (`T:292-323`), and the repo builds only non-interactive children (`pi-child.ts:261`, `mode: "print"`). A capable main session plans with the user in its own thread, with the `planner` lead for the deep dive.

**Cheap orchestrator, plus 1: good for executing an approved plan.** Agree. Once the plan fixes the decisions, execution is routing and status-checking. Cursor's swarm planner splits and delegates while cheaper workers execute (2026-07-20); Aider's cheap editors applied a strong architect's plan (2024-09-26); `opusplan` runs execution on the cheaper model. Without plan mode there is no approval point to switch on, so a cheaper execution model is not pursued for now; cheap executors are the chores and the `implementer` lead, picked per agent.

**Capable orchestrator, minus 1: expensive.** Partly. Two things cap the cost: session-limits hands the main session off at 0.75 of the context window (`extensions/session-limits/src/settings.ts:5-10`, `limits.ts:79-105`); and scouts do the reading, so the main context stays small. The cost is still real: in Cursor's swarm the strong planner was about two thirds of the $1,339 even with cheap workers (2026-07-20). That spend is where quality is decided, which is why it is the last place to save.

**Capable orchestrator, minus 2 and 3: the user may pick a weak model; the main session carries more responsibility.** Agree; both are acceptable. The main model is pi's own choice (`/model`, defaults in pi's settings), and the extension never switches it. Note that this machine's pi default model is a small model (`~/.pi/agent/settings.json`, per [model-tiers.md](../research/model-tiers.md)), so taking this decision means setting a capable default.

**Capable orchestrator, plus 1: no plan mode needed.** Agree for now. Every vendor ships a read-only mode (nesting-modes-and-setup.md, B), but each is entered by hand, and users forget to switch, so the benefit they see is small. Claude Code's own guidance says "If you could describe the diff in one sentence, skip the plan" and "Plan mode ... adds overhead", so even there it is opt-in. A capable model can decide by itself when a task needs a plan first, and a skill can carry the procedure. See "No plan mode for now".

**Capable orchestrator, plus 2: skills work far better.** Agree. Pi lists each skill as one `<skill>` entry in the system prompt and the model reads the file on demand (`PI/dist/core/skills.js:278-303`, `system-prompt.js:105-108`). A capable main session sees every skill at about 100 tokens each and passes the fitting ones per task through `run_agent`'s `skills` (see "Skills: three layers").

## Delegate-only removal

The `delegateOnly` and `delegateOnlyTools` settings go (`extensions/subagents/src/model/settings.ts:23-24, 47-48, 71-72`), and so does their only use, the `restrictTools` call in `run-agent/index.ts:166-174`. With plan mode deferred, the restriction mechanism has no consumer left, so it goes too: `Host.restrictTools` (`core/adapter/contract.ts:271`), `createToolRestriction` and its `restricted-tools` session entry (`core/adapter/pi-adapter.ts:93-160`, wiring at 271, 305, 321, 472-474, 571-572), the fake host fields (`core/test/helpers/fakes.ts:56-57, 198-199, 409-414`), `core/test/adapter/pi-restrict-tools.test.ts` and the restriction conformance tests (`core/test/adapter/conformance.test.ts:233-286`). `parentTools` (`pi-adapter.ts:162-169`) stays, because it is the `activeTools` source for `tools: all` children (`pi-adapter.ts:584`); it drops the removed set and returns pi's active tools. `main-session.md` becomes a normal-mode prompt: role rows as guidance instead of first-match, "understand the request; read one short file or run one orienting command yourself; otherwise delegate; judge results; for multi-step or ambiguous work, work out a plan first with the planner lead and the user before implementing". The full REMOVE / KEEP list, tests and doc sentences are in [delegate-only-removal.md](delegate-only-removal.md).

## No plan mode for now

Decision: no plan mode in this round. The round 2 design (a `normal` and a `plan` mode with a guarded tool set, a plan artifact and an approval gate) is not implemented.

Why:
- users forget to switch into a plan mode, so it gives no benefit they can see;
- the same behaviour comes from the model deciding when it needs to plan, which is the point of a capable main session;
- a skill can carry the planning procedure without a mode;
- keep things simple: no tool switching, guard, artifact, approval state or persistence to maintain.

What replaces it: the normal-mode prompt tells the main session to work out a plan first with the `planner` lead and the user before implementing multi-step or ambiguous work (see "Delegate-only removal"). A plan skill is the first candidate under "Shipping our own skills (optional)".

When to revisit: if a very cheap classifier model could enter a read-only mode automatically when a request needs planning. No product ships that today; every product checked enters plan mode by hand, through Shift+Tab or `/plan` (nesting-modes-and-setup.md, verdict B).

Where the design lives if revisited: future-plans/plan-mode.md (the user's local note, untracked) and this document's git history; commit 3bf5c13 has the full two-mode design (entry, enforcement, prompt, artifact, approval, persistence, settings).

## Nesting depth stays at 3

Keep `maxDepth: 3` (`settings.ts:35`): main, lead, chore. Chores spawn nothing (`subagents: []`). Keep `maxChildrenPerAgent` (`settings.ts:49`, enforced at `runner.ts:722`). WP-B adds to the lead prompts a rule that a lead reports `Status: partial` rather than re-delegating its whole task; today only per-lead scout limits exist (for example `agents/leads/planner.md:14`). Evidence (nesting-modes-and-setup.md, A): Claude Code defaults to three layers below the main conversation since 2.1.219 (2026-07-24), after briefly disabling nesting in 2.1.217; Cursor 2.5 has exactly our shape (main and direct subagents spawn, grandchildren cannot); Codex and Gemini CLI default to no nesting. The literature is neutral: arXiv 2512.08296 tested flat topologies only (centralized 4.4x against independent 17.2x error amplification) and calls hierarchy "an open question"; Anthropic warns "errors compound"; ReDel names agents that re-delegate the task they were given as the failure mode.

## Skills: three layers, narrowing down the tree

An agent's skills come from three layers:
- (a) the `skills:` list of its definition (shipped or own agent);
- (b) replaced by the `/agents setup` override for that agent when one exists (user file, then project file, project winning);
- (c) plus the call-time `skills` its caller passes on `run_agent` (`runner.ts:112-116`).

(b) replaces (a) rather than adding to it. The setup form is pre-filled from the frontmatter, so "unselect all" must be able to give an agent no skills; a union, as the user sketched, would make that impossible.

Rule at every depth: a caller may pass only skills in its own effective set. The main session's set is every skill pi loaded. Today `runner.ts:767-774` (`skillError`, `runner.ts:692`) validates against `runtime.skillNames()`, which is the main session's list at every depth (`pi-child.ts:369`), so a lead with `skills: []` can pass any skill to its scout. This becomes caller-aware: the runner validates against the caller's effective set (a, b and c of that caller). The effective set is stored on each record at spawn, with `skills: all` resolved to skill names at that point, and the runner's error names the caller's effective set. Chores keep `skills: []` and normally receive none; `general` keeps `skills: all`.

Precedent (settings-and-skills-layering.md): every product binds skills at definition time (Claude Code `skills:`, Agent SDK `AgentDefinition.skills`, Deep Agents per-subagent `skills`), and no product has a call-time parameter; that is this project's addition and the README should say so. Claude Code's `skills:` preloads bodies and does not narrow (unlisted skills stay invocable). The Agent Skills spec leaves scoping to the client ("Hide filtered skills entirely from the catalog").

**Shipping our own skills (optional).** An extension can contribute skill paths through `resources_discover` (`T:552-562`), instead of growing `main-session.md`. The first candidate is a plan skill: when to plan first, how to use the `planner` lead, the plan's shape and how to confirm it with the user. A brief-writing skill would follow. Not needed for the decision.

## Codemode and MCP

Codemode exposes every callable tool, not only MCP (`PI/docs/codemode.md:1-3, 34`; `PI/dist/extensions/codemode/tool.js:83`). Today `pi-child.ts:108` (`wantsMcp`, true for `tools: all` and any non-empty list) ties codemode, `tool_search` and MCP together: it adds the MCP tool names (`childToolNames`, `pi-child.ts:115`) and the three extensions (`mcpExtensions`, `pi-child.ts:120-133`). Split them:
- codemode and `tool_search`: every agent with `tools: all` or a non-empty tool list, as today;
- the MCP extension: only agents with `mcp: true` in their frontmatter.

MCP stays shared across agents as configured in `mcp.json` (user plus project), with no per-server filtering, so codemode over MCP is untouched. Shipped defaults: leads `mcp: true`, chores `mcp: false`. If per-server scoping is ever wanted, `createMcpExtension({ loadConfig })` can filter servers per child (`PI/dist/extensions/mcp/index.d.ts`, `McpExtensionOptions`); out of scope.

Why the switch matters today: each child session loads its own MCP extension (`core/adapter/pi-child.ts:120-133`, added at 217), and pi connects every enabled server when a session starts (`PI/docs/mcp.md:100`), so every scout spawns every stdio MCP server. `mcp: false` on the chores stops that. Details:
- files that omit `mcp` default to `true`, which is today's behaviour; the loader warns about unknown keys and ignores them (`plugins/agent-definitions/loader.ts:33-40`);
- `mainTools()` already strips MCP tool names from the parent's active tools (`pi-child.ts:148-152`), so `tools: all` with `mcp: false` only means not adding the MCP tool names and the MCP extension;
- `SpawnSpec` (`core/adapter/contract.ts:331-343`) gains an `mcp` field, with the fake runtime (`core/test/helpers/fakes.ts`) and a conformance test;
- `extensions/subagents/test/live/grants.live.test.ts` sets `mcp: true` in its fixture.

## Settings layering and agent overrides

**Today.** Agent definitions: shipped < user `<agentDir>/agents` < project `<cwd>/.pi/agents` (trusted only), whole-file shadowing (`plugins/agent-definitions/index.ts:25-33`). `pi-subagents.json`: user and trusted project, merged `{ ...defaults, ...user, ...project }` (`model/settings.ts:84-98`). Both load at session start (`src/index.ts:16-27`, `agent-definitions/index.ts:25`).

**Add: `agents.<name>` overrides** with `model` (`provider/id:thinking`), `thinking` and `skills`. Merge: definition, then user override, then project override, field by field; each field replaces. Tools are not overridable (create an own agent instead). Unknown agent names are reported as settings errors. Why override instead of a shadow file: a shadow file freezes the shipped prompt, so prompt fixes never reach that repo. Gemini CLI's `agents.overrides` is the precedent (settings-and-skills-layering.md). The settings schema needs an object rule and a per-agent deep merge instead of the top-level spread at `settings.ts:97`.

**Order.** Shipped < user shadow < project shadow decides which file defines the agent (whole file); then user override < project override applies field by field on whatever file won.

**Checked at session start.** An override `model` is resolved through `runtime.resolveModel` (`core/adapter/contract.ts:411`) and override `skills` are checked against the loaded skills. A failure warns and drops that override field, instead of every spawn of that agent failing with "Nothing was started" (`runner.ts:773`) or `pickSkillFiles` (`pi-child.ts:138-139`) silently filtering the skill out. An override for an agent that exists only in an untrusted project's `.pi/agents` gives an info message, not a warning on every start.

## `/agents setup` and `/agents create`

Both are first-word subcommands of the existing `/agents` command (`plugins/agent-view/index.ts:130-146`, which today treats any argument as an agent id). `complete` offers `setup` and `create` plus the live agent ids.

**`/agents setup`.** TUI only (`ctx.mode`); in other modes it fails with a message naming the file to edit. It writes `<cwd>/.pi/pi-subagents.json` `agents.<name>` and needs a trusted project; the user-level file stays hand-editable. The form runs on `Host.ui.showForm` (`core/adapter/contract.ts:185`, `core/adapter/pi-form.ts`):
- one tab per agent: leads, chores, then own agents; tab bar and tab keys come from the questionnaire (`extensions/questionnaire/src/form.ts:113-118`, `render.ts:116`), which must first move into `core/manager`, because extensions never import each other (ARCHITECTURE.md:10, enforced by `test/architecture.test.ts`);
- model: a picker from pi's model list filtered to providers with credentials, stored as `provider/id:thinking`. This needs a new contract API for the model catalogue, with its fake and a conformance test: the runtime exposes only `resolveModel` (`core/adapter/contract.ts:411`), and `core/adapter/pi-models.ts:17` computes `authenticated` but nothing lists models to extensions;
- thinking level;
- skills: a new multi-select component (checkbox rows, space toggles, `a` all, `n` none, scroll window), pre-filled from the definition;
- tools, read-only, with the line "Tools are fixed per agent. To change tools, create your own agent with /agents create.";
- MCP as an info line: "MCP servers are shared by all leads as configured in mcp.json: <names>. Chores do not see MCP.";
- a Submit tab that writes the file and shows the merged result.

It takes effect at the next session start. An immediate reload is feasible: settings and definitions are both plain loads run from `onSessionStart` (`src/index.ts:16-19`, `agent-definitions/index.ts:25-33`), so a `reload()` that re-runs both after the write applies to agents started afterwards; running agents keep their config. A one-line form serves scripts: `/agents setup <agent> model=... thinking=... skills=a,b|all|none`.

**Review recommendation (pending the user's decision): defer the form.** It is a form over a five-line JSON file, and size L is understated: it needs the multi-select component, the questionnaire tab code moved into `core/manager`, the model-catalogue API with its fake and conformance test, the settings object rule, the reload path and the one-line parser. A README example of `agents.<name>` does the job for a small team until the override has been used. See open question 2.

**`/agents create <name> [from <agent>]`.** No wizard: products dropped them (Claude Code removed its `/agents` wizard in 2.1.198, 2026-07-01, "ask Claude to create or manage subagents, or edit `.claude/agents/` directly"; Cursor says "ask Agent to create one"; Codex is TOML only; Gemini's `/agents config` tunes existing agents only; nesting-modes-and-setup.md, C). The command scaffolds `<cwd>/.pi/agents/<name>.md` from a template, or from a copy of a shipped agent with `from`, with every frontmatter field documented in comments in the body (`name`, `description`, `model`, `limit`, `tools`, `skills`, `subagents`, `mcp`, `worktree`). It then tells the user to edit the file, or to ask the main session to, since the main session has `write`.

**Review recommendation (pending the user's decision): shrink it.** Either `/agents create <name> from <agent>` only (copy a shipped file), or no command and a README section with the annotated frontmatter. The shipped files already declare every field in order and double as reference files (`extensions/subagents/README.md:57`), and the main session has `write`.

## No resumable or held leads for now

The earlier draft recommended `hold: true` (keep a finished lead's session open in an `idle` state for `message_agent`). Dropped for now:
- the capable main session holds the planning context itself, so the planner lead is a deep-dive helper, not the loop;
- a re-review is better done fresh, without the first reviewer's framing;
- fixes go to the implementer with the reviewer's findings in the brief;
- results persist on disk (`result.md`, and the Agent folder line in the task header, `run-agent/task.ts:12`), so a re-brief can point at them in `files`;
- `hold` adds an idle state that interacts with `pi:busy` (`plugins/agent-registry/index.ts:9, 17-20`), the session-limits handoff (`limits.ts:155-179`), caps and timeouts, which is the fragility the user fears.

`message_agent` stays as is. Revisit only with a measured re-brief cost.

Footnote: if resuming is ever needed, a finished agent's JSONL can be reopened with `SessionManager.open(path, sessionDir?, cwdOverride?)` (`PI/dist/core/session-manager.d.ts:378`) and passed to `createAgentSession({ sessionManager })` (`PI/dist/core/sdk.d.ts:60`).

## Child results: what the parent receives

Evidence: [subagent-results.md](../research/subagent-results.md). Today:
- The result is the child's last assistant message (`core/adapter/pi-child.ts:360`, read at `run-agent/runner.ts:403`).
- It is always written in full to `result.md` in the agent folder (`run-agent/result.ts:42-53`).
- The batch message inlines it when it is at most `inlineResultChars` (default 4,000, `src/model/settings.ts:39`); above that it is replaced by `Result file: <path> (<N> chars)` and a 300-character preview (`result.ts:102-112`).
- The Status / Verification / Open shape is prompt-only (`prompts/base-system-prompt.md:12-22`); nothing parses it.
- Failed entries carry no text (`result.ts:94-98`); a stopped entry carries text only when it has some.
- No 8 KB limit exists. Pi's only `8 * 1024` is `NESTED_CALL_LIMITS.maxArgumentBytesPerCall`, the per-call cap on argument records of nested tool calls (`PI/dist/core/nested-tool-calls.js:18`).

Decisions:
- **R1.** Default `inlineResultChars` becomes 8,000. The contract's ceiling is about 1,500 tokens, roughly 6,000 characters, so a result that follows it always arrives inline, and four parallel agents cost at most about 8,000 tokens per batch.
- **R2.** Above the limit, inline the head up to the limit, cut at the last newline before it, followed by one marker line `Result file: <path> (<N> more chars)`, instead of the 300-character preview. The marker keeps today's `Result file:` wording (`result.ts:109`) so existing prompt text still matches. The Status line and the first section always arrive. The planner rule in `prompts/main-session.md:41` ("read its result file if it is not inline") becomes: if the entry ends with a marker line, read the file before running any batch. A planner result over the limit now arrives half inline, and a main session that runs batch 1 from the head and never reads the tail loses batches silently.
- **R3.** Failed and stopped entries show the child's last text under the same rule, with an `(unverified partial output: <error>)` note, because `prompts/main-session.md:38` tells the model to retry a failed agent and it must not treat the fragment as a result. `resultPath` is stored for failed and stopped children too, so `agent_status` shows it.
- **R4. Zero-turn shape scan.** The result is the last assistant text of the child's final run (after its last prompt or wake) that carries a `Status:` line, matched leniently: within the first five lines, case-insensitive, `**Status:**` tolerated. It is read through one adapter method over the child's session entries; the adapter already reads them for `ownUsage` (`core/adapter/pi-child.ts:359`). When no text of the final run carries a Status line, the result is the last text with a `(shape: no Status line)` note. No extra turn and no runtime state. This covers a child that writes its result and then ends on a tool call or a one-line sign-off.
- **R4, to confirm during implementation:** the boundary of "the final run", the last user message or `pi-subagents:wake` custom entry. Wakes and routed messages reach a child through `deliver` (`pi-child.ts:324`, `wake` at 356), which prompts the child when it is idle (`prompt` at 319-322), so in the child they appear as user messages; the `pi-subagents:wake` custom entry is what the main session receives (`run-agent/index.ts:38`). A message steered into a running child is also a user message and must not cut the run short.
- **Why not a retry (review).** The earlier draft sent a child without a `Status:` line one follow-up asking for the Result shape. The review dropped it: it would add a sub-state between settled and closed that must re-acquire a slot through `resume` (`runner.ts:214-243`), skip handoff, grace, aborted and failed children, and survive a `message_agent` steered into the retry turn; and a strict check fires on cosmetic variants, costing a turn each time. The retry is the fallback if the live suite shows that the scan misses cases.

## Agent list and row rendering

**(I) The `/agents` list keeps the session's history.** Today `visibleRecords` (`extensions/subagents/src/plugins/agent-view/list-model.ts:34-83`, linger rule at 45-59) hides closed roots after `lingerMs` (default 30,000, `src/model/settings.ts:16, 40`). The registry itself never removes records (`src/plugins/agent-registry/registry.ts:54`, `close` at 123-136). Pi builds a fresh extension instance, and with it the registry, for every session (`/new`, `/resume`, `/fork`, `/reload`; ARCHITECTURE.md:24); the registry is created when the plugin is enabled (`src/plugins/agent-registry/index.ts:14`). So the list already starts empty after `/new`, and no session start reason is needed. Change:
- the list overlay drops the `lingerMs` filter from `visibleRecords` (`list-model.ts:45-59`); the below-editor panel keeps its own `doneLingerMs` and `failedLingerMs` (`agent-panel/model.ts:19-33`);
- the `x` key still hides a row through the `cleared` set (`agent-view/list.ts:211-219`);
- order stays: Running first, then Completed roots by `endedAt`, newest first (`list-model.ts:91-110`);
- a cap of about 200 closed roots, oldest dropped first, bounds memory, because records keep `lastText` and `resultText` (`types.ts:63-64`); pruning removes whole subtrees and whole chains, since `chainLinks` (`src/model/types.ts:17-24`) walks closed predecessors.

`lingerMs` then serves nothing in the list. Its only other readers are the list wiring (`agent-view/index.ts:41, 48`, `agent-view/list.ts:19, 52`) and the settings themselves (`src/model/settings.ts:16, 40, 64`); the panel reads `doneLingerMs` and `failedLingerMs`, not `lingerMs`. So the setting can be removed, together with its README sentence (`extensions/subagents/README.md:40`), the ARCHITECTURE.md line (ARCHITECTURE.md:107) and the two linger cases in `test/plugins/agent-view/list.test.ts:414, 547`. `test/live/routing.live.test.ts:28` uses `lingerMs` only as the subject of a routing request ("rename the `lingerMs` setting") and needs another setting as its example.

Consumers that must see only open agents already filter: the busy flag with `isClosed` (`agent-registry/index.ts:9`), `route` with `isClosed` (`runner.ts:920-958`), and stop-all by state `queued` or `running` (`agent-view/list.ts:222-225`).

**(J) Static name column.** The pointer `›` (`src/components/agent-row.ts:147`, two columns, `POINTER_COLS` at 26) is drawn only on the selected row, and `rowLayout` reserves the two columns only while something is selected (`agent-row.ts:124`, `renderRow` at 146), so names shift right by two when a selection appears. Change: always reserve the pointer columns and render two spaces when not selected, so names stay put and the pointer appears in place. Tests to update: `test/components/agent-row.test.ts:337, 348`; `test/plugins/agent-panel/agent-panel.test.ts:443-444, 569`; `test/plugins/agent-view/list.test.ts:115`.

## Migration from other tools

Evidence: [migration-portability.md](../research/migration-portability.md).
- **Skills.** Pi implements the Agent Skills spec and reads `~/.pi/agent/skills` and `.pi/skills` (`PI/dist/core/skills.js:355-356`) plus `~/.agents/skills` and `.agents/skills` (`PI/docs/skills.md:61`; `PI/dist/core/package-manager.js:297, 2023`), not `.claude/skills` or `.codex/skills`. `.agents/skills` is also read by Codex, Cursor, Gemini, Copilot CLI, Amp, Roo and Kilo, so it is the one location that needs no conversion.
- **MCP.** Pi's file is `mcp.json` (user `~/.pi/agent/mcp.json`, project `.pi/mcp.json`, `PI/docs/mcp.md:32`) with the shared `mcpServers` shape. Claude Code, Cursor, Cline, Amp and Copilot entries copy over; Codex TOML, Gemini and Kilo need a rewrite; `sse` is rejected (`PI/docs/mcp.md:79`); OAuth servers need `pi mcp login` again.
- **Instructions.** Pi reads AGENTS.md and CLAUDE.md (`PI/dist/core/resource-loader.js:116`).
- **Agent definitions** do not port: other formats lack `limit`, `tools`, `skills` and `subagents` as this project defines them, and Codex uses TOML.

Decisions:
- Advise teams to keep skills in `.agents/skills`.
- No `.claude/skills` registration. A Claude Code user adds the path to pi's `skills` setting (`"skills": ["~/.claude/skills"]` in `~/.pi/agent/settings.json`, or a project path in `.pi/settings.json`; `PI/docs/settings.md:148-161`) or moves the folders to `.agents/skills`. Registering it through `resources_discover` would load another tool's skills into every session with no off switch and duplicate pi's own setting.
- No `from-file` converter. Model aliases cannot be mapped in code under the no-provider rule, which leaves tool-name mapping as the only mechanical part. The README gets a field table and the main session converts a file on request.
- The team story: commit `.pi/mcp.json`, `.pi/agents`, `.pi/pi-subagents.json` and `.agents/skills`; a colleague trusts the project and has the setup.
- The README gets a "Coming from another tool" section (WP-H).

Effort per user (review estimate): skills take minutes. MCP takes 10 to 20 minutes from Claude Code, Cursor, Cline or Amp (copy `mcpServers`, run `pi mcp list` and `pi mcp login`, convert timeouts from ms to s, rewrite Cursor's `${env:X}`), up to an hour from Codex TOML, Gemini or Kilo; `sse` endpoints are a hard stop. Agent definitions take 10 to 15 minutes each by hand. Instruction files are free for AGENTS.md and CLAUDE.md, and take 15 to 30 minutes to merge `.claude/rules/`, `CLAUDE.local.md`, imports, `.cursor/rules` and GEMINI.md.

## Review round (2026-10-17)

A senior review of this design concluded:
- Worth implementing, with the changes recorded above.
- A, B, R, C and D carry the value; I shrinks to the list filter and a cap; J is trivial.
- F and G are recommended for deferral (F) or shrinking (G), pending the user's decision.
- Order: A, B, R, D, C, I, J, with H alongside.

## Work packages

| WP | Work | Depends on | Size | Needed for the decision |
| --- | --- | --- | --- | --- |
| A | **Removal**: drop `delegateOnly` settings and the restriction call; remove the restriction machinery (`Host.restrictTools`, `createToolRestriction`, the `restricted-tools` entry, fake host fields, `pi-restrict-tools` and restriction conformance tests; `parentTools` reduced to active tools); delete `delegate-only.test.ts`; strip `settings.test.ts` ([delegate-only-removal.md](delegate-only-removal.md)) | | S | Yes |
| B | **Normal-mode prompt** with the plan-first sentence, routing live suite adaptation (full tool set, relax "exactly one agent"), and the lead rule to report `Status: partial` rather than re-delegate the whole task | A | S | Yes |
| C | **Skills**: caller-aware validation in the runner, with the effective set stored per record at spawn (`skills: all` resolved to names) and named in the runner's error; `agents.<name>` overrides (model, thinking, skills) merged in the loader in the stated order; override `model` and `skills` checked at session start (warn and drop the field; info for agents only in an untrusted project); settings object rule and per-agent merge | | M | No |
| D | **Codemode split**: `mcp` frontmatter field (leads `true`, chores `false`, omitted means `true`), codemode and `tool_search` as today, MCP tool names and extension only with `mcp: true` in `pi-child.ts`; `SpawnSpec.mcp` with contract, fake runtime and conformance test; `grants.live.test.ts` fixture sets `mcp: true` | | S | No |
| F | **`/agents setup`** form, multi-select component, questionnaire tab code moved to `core/manager`, model-catalogue contract API, one-line form, reload. Deferred pending user decision (review): a form over a five-line JSON file, a README example serves until the override is used | C, D | L | No |
| G | **`/agents create`** scaffold and template. Scope pending user decision (review): shrink to `from <agent>` only, or a README section | D | S | No |
| I | **List history**: drop the `lingerMs` filter from the list overlay (and the setting, if nothing else reads it), keep `x`, cap of about 200 closed roots pruned by whole subtrees and chains | | S | No |
| J | **Pointer columns**: always reserve the two pointer columns in `rowLayout` and `renderRow`; update the five row tests | | S | No |
| R | **Results**: R1 default 8,000, R2 head plus marker line, R3 partial text for failed and stopped entries, R4 zero-turn shape scan over the child's final run | | M | No |
| H | **Docs**: README, ARCHITECTURE.md, STRUCTURE.md per WP; README says call-time skills are this project's addition, gains a "Coming from another tool" section, and describes the new result inlining; fix "all seven have `skills: []`" (`extensions/subagents/README.md:84`) for the eight-agent roster | each | M total | Yes for A, B |

The decision takes effect with A and B: the main session runs on the user's model with its full tool set and the normal-mode prompt. The review's order for the rest is R, D, C, I, J, with H alongside; F and G wait for the user's decision. Implementation is deferred to a later step; this document is the plan.

## Open questions

1. Should `/agents setup` also write the user-level file (a scope choice in the form), or stay project-only?
2. Build the `/agents setup` form now, or ship the `agents.<name>` override with a README example first (the review recommends the example first)?
3. `/agents create`: keep the scaffold with a template, shrink it to `from <agent>`, or replace it with a README section (the review recommends shrinking)?

Answered: R4 (the review chose the zero-turn scan over the retry, see R4); `.claude/skills` registration and the `from-file` converter (both no, see "Migration from other tools").
