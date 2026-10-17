# Orchestrator model: a capable main session that decides and delegates

Status: proposal, 2026-10-17; revised 2026-10-17 round 2 (two modes, no hold, three-layer skills, codemode preserved). Branch `feat/agent-workflow-revamp`, pi 1.3.0. Supersedes the delegate-only default in agent-workflow.md; the roster, brief template, result contract, fetch tool and call-time skills from that design stay.

Research date: 2026-10-17. Evidence: [orchestrator-capability.md](../research/orchestrator-capability.md) (model tiers), [settings-and-skills-layering.md](../research/settings-and-skills-layering.md) (settings, skills, MCP), [nesting-modes-and-setup.md](../research/nesting-modes-and-setup.md) (nesting depth, mode switching, agent creation). The removal itself is itemised in [delegate-only-removal.md](delegate-only-removal.md). The user's earlier plan-mode research is cited as future-plans/plan-mode.md. Repo references are `file:line` on this branch; `PI/` means `node_modules/@earendil-works/pi-coding-agent`, and `T`, `R` and `AS` mean `PI/dist/core/extensions/types.d.ts`, `PI/dist/core/extensions/runner.js` and `PI/dist/core/agent-session.js`. Model values in settings examples are placeholders (`provider/id`); they are user data, not code.

## Decision

The main session runs on a capable model and both decides and delegates. Delegate-only on a cheap model is not the default. Cost is controlled by delegating the work and, optionally, by a cheaper model after a plan is approved, not by weakening the decision maker.

Three pillars:

1. **The direct test failed.** Cognition ran a fast, cheaper sub-frontier primary with a strong planning helper, which is the shape agent-workflow.md proposes (cheap coordinator, strong `planner`): "the quality ceiling was set by the primary, and the primary wasn't strong enough"; making a weaker primary work is "still an open problem, and we think it's a training one" (Cognition, "Multi-Agents: What's Actually Working", 2026-04-22).
2. **The planner matters more than the executor.** "A weak planner degrades overall clean task performance more severely than a weak executor" (PEAR, arXiv 2510.07505, v4 2026-01-08). MAST (NeurIPS 2025) puts about 44% of multi-agent failures in specification and system design and about 24% in verification; both are the coordinator's decisions.
3. **Nobody ships it.** Claude Code, Codex, Cursor, Gemini CLI and Amp default to a capable main model with subagents inheriting it. Roo's delegate-only Orchestrator mode has no official model guidance, and Kilo, which shipped the same mode, now marks it deprecated (orchestrator-capability.md, verdict d).

The supporting pattern is the reverse split: a strong planner with cheaper executors. Claude Code's `opusplan` (strong model in plan mode, cheaper in execution), Aider architect/editor (2024-09-26: strong architect with a cheap editor matched or beat the strong model alone), Anthropic's research system (Opus lead, Sonnet workers, +90.2%, 2025-06-13), Cursor swarms (strong planner, cheap workers, $1,339 against $10,565, 2026-07-20) and Devin Fusion (frontier main agent "making the significant decisions", cheaper sidekick, about 60% lower cost, 2026-06-29).

What this changes in agent-workflow.md: its first goal ("The main session is a coordinator that can run on a cheap model") and its "Second opinion" verdict ("viable, but it is an experiment") are replaced. Its goal that the main-session prompt and tool list stay byte-stable within a session is relaxed: the system prompt stays byte-stable, and the tool list changes only on entering and leaving plan mode. Its non-goal "No per-agent MCP filter" is revised to a per-agent on/off switch (see "Codemode and MCP"). Its statement that docs/ is gitignored no longer holds: docs/ is tracked.

## The user's pros and cons, answered

**Cheap orchestrator, minus 1: not capable of decisions.** Agree. The routing table in `extensions/subagents/prompts/main-session.md:3-14` removes decisions only for requests that already have a clear shape. Its first row ("Multi-step, a design choice ... `planner`") is itself a judgement, as agent-workflow.md "Second opinion" admits. Validating a plan with the user, judging whether a result answers the brief, and deciding what to do with a `partial` result are decisions that no table removes. MAST's top modes (disobeying the task spec 11.8%, incorrect verification 9.1%) sit exactly there.

**Cheap orchestrator, minus 2: over-spawning leads because finished agents cannot be followed up.** The user is right about the code.
- `message_agent` (`extensions/subagents/src/plugins/run-agent/tools.ts:280-314`) routes through `route` (`runner.ts:920-957`), which rejects closed agents: "closed agents cannot receive messages. Start a new agent instead." (`runner.ts:929-934`). Every state except `queued`, `running` and `grace` is closed (`model/types.ts:7-9`).
- On finish the child session is disposed (`runner.ts:555-556`, ending in `child.dispose()` at 299). The child's JSONL stays on disk (`core/adapter/pi-child.ts:225-227`), but only the read-only `/agents` view reads it.
- Consequence: every follow-up to a planner or reviewer is a fresh spawn with a re-brief. With a capable main session this matters less than it did for a cheap one, and the answer for now is not to hold agents (see "No resumable or held leads for now").

**Cheap orchestrator, minus 3: needs a nested interactive plan session.** Agree that one-shot planning is not enough: every vendor keeps planning interactive in the user-facing thread (orchestrator-capability.md, "Plan-mode interaction loops"; nesting-modes-and-setup.md, B). Disagree that it needs a second pi process overlaid on the TUI. Pi has no nested interactive session API; session switching replaces the main session (`T:292-323`), and the repo builds only non-interactive children (`pi-child.ts:261`, `mode: "print"`). What is needed works in the same session: `setActiveTools`, a `tool_call` guard, `before_agent_start` messages, `setModel` and `setThinkingLevel`, status, widget and form UI. So plan mode is a mode of the same session (see "Modes").

**Cheap orchestrator, plus 1: good for executing an approved plan.** Agree. Once the plan fixes the decisions, execution is routing and status-checking. Cursor's swarm planner splits and delegates while cheaper workers execute (2026-07-20); Aider's cheap editors applied a strong architect's plan (2024-09-26); `opusplan` runs execution on the cheaper model. This becomes an optional model switch on approving a plan, not a mode of its own.

**Capable orchestrator, minus 1: expensive.** Partly. Three things cap the cost: session-limits hands the main session off at 0.75 of the context window (`extensions/session-limits/src/settings.ts:5-10`, `limits.ts:79-105`); scouts do the reading, so the main context stays small; and execution of an approved plan may switch to a cheaper model (`plan.approved.model`). The cost is still real: in Cursor's swarm the strong planner was about two thirds of the $1,339 even with cheap workers (2026-07-20). That spend is where quality is decided, which is why it is the last place to save.

**Capable orchestrator, minus 2 and 3: the user may pick a weak model; the main session carries more responsibility.** Agree; both are acceptable. The main model is pi's own choice (`/model`, defaults in pi's settings), and `plan` settings make any switch explicit. Note that this machine's pi default model is a small model (`~/.pi/agent/settings.json`, per [model-tiers.md](../research/model-tiers.md)), so taking this decision means setting a capable default.

**Capable orchestrator, plus 1: no plan mode needed.** Partly disagree. A capable model still benefits from a read-only mode with an approval gate; every vendor ships one (nesting-modes-and-setup.md, B). Claude Code's own guidance also says "If you could describe the diff in one sentence, skip the plan" and "Plan mode ... adds overhead", so it is opt-in. It stays small: a tool set, a guard, a prompt message, an artifact and a gate, not a new process.

**Capable orchestrator, plus 2: skills work far better.** Agree. Pi lists each skill as one `<skill>` entry in the system prompt and the model reads the file on demand (`PI/dist/core/skills.js:278-303`, `system-prompt.js:105-108`). A capable main session sees every skill at about 100 tokens each and passes the fitting ones per task through `run_agent`'s `skills` (see "Skills: three layers").

## Delegate-only removal

The `delegateOnly` and `delegateOnlyTools` settings go (`extensions/subagents/src/model/settings.ts:23-24, 47-48, 71-72`), and so does their only use, the `restrictTools` call in `run-agent/index.ts:166-174`. The restriction mechanism stays for plan mode, with a new restore operation: `Host.restrictTools` (`core/adapter/contract.ts:271`) only removes tools and never re-adds them, so the host contract becomes `setTools(keep)` plus `restore()`. `main-session.md` becomes a normal-mode prompt: role rows as guidance instead of first-match, "understand the request; read one short file or run one orienting command yourself; otherwise delegate; judge results; suggest `/plan` for multi-step or ambiguous work". The full REMOVE / KEEP / KEEP-FOR-PLAN list, tests and doc sentences are in [delegate-only-removal.md](delegate-only-removal.md).

## Modes: normal and plan

Two modes, not three phases. The earlier draft had `decide`, `plan` and `build`. The difference between decide and plan was only this: decide was the ordinary mode; plan is the ordinary mode plus read-only enforcement, a plan artifact and an approval gate. So the names collapse to `normal` and `plan`. `build` is not a mode: approving a plan leaves plan mode. Every product checked does it this way (Claude Code Shift+Tab and `/plan`, `opusplan` going cheaper on exit; Codex "Implement this plan?"; Cursor Build; Cline Plan/Act models; Gemini model routing), and none has a distinct third state (nesting-modes-and-setup.md, verdict B).

| Mode | Entered by | Model | Tools | Produces |
| --- | --- | --- | --- | --- |
| `normal` (default) | session start; approving or cancelling a plan; `/plan` toggle | the user's model | full set (pi's active tools plus the agent tools) | answers, briefs, delegations, a suggestion to `/plan` |
| `plan` | `/plan`, ctrl+alt+p | `plan.model`, else unchanged | plan set, guarded | a versioned plan file, approved by revision |

**Entry.** `/plan` toggles the mode; `/plan approve` and `/plan cancel` end it. A shortcut through `pi.registerShortcut` (`T:1233`) on ctrl+alt+p, the key pi's own example uses (`PI/examples/extensions/plan-mode/index.ts:158`). Shift+tab is reserved by pi for the thinking-level cycle and cannot be taken by an extension (`R:9-28`, dropped with "Skipping" at `R:463-465`); a user may rebind keys in `<agentDir>/keybindings.json` (`PI/docs/keybindings.md:12-32`). A status badge through `setStatus` (`T:84`) and a widget with the plan title and revision through `setWidget` (`T:101-102`).

**Enforcement.** Two layers, as in future-plans/plan-mode.md.
- Tool set: `setActiveTools` to `read`, `grep`, `find`, `ls`, `write` (guarded), `run_agent`, `message_agent`, `agent_status`, `questionnaire`, through the existing restriction with the new restore. `write` is needed for the artifact and the session handoff, so it stays, guarded. Removing `bash` and `edit` from the active set removes them from codemode too: codemode can call direct tools only while they are active (`AS:1145-1151`).
- Guard: a `tool_call` handler (`T:1224`, returns `{ block, reason }`, `T:1089-1097`; a thrown error also blocks) that blocks the main session's own `bash` entirely; allows `write` and `edit` only to the current plan path and the session handoff path; and blocks `run_agent` items whose definition has `edit` or `write` in its tools, or `tools: all`. The guard also sees nested calls made from codemode scripts, which run through the same hooks (`PI/docs/extensions.md:149`).
- Agents allowed in plan mode: `scout`, `planner`, `reviewer`, `fetch`, `shell` and `image`; blocked: `implementer` and `general`. Bash-capable read-only agents (`reviewer`, `shell`) stay allowed because plan mode is a workflow boundary, not an OS sandbox: future-plans/plan-mode.md says the policy "protects tool-mediated workflow behavior" and is "not an OS sandbox", and pi's example plan-mode extension keeps bash behind a read-only allowlist rather than removing it (`PI/examples/extensions/plan-mode/index.ts:214-216`).
- Gap: MCP tools with codemode exposure stay callable whatever the active set is (`AS:1145-1151`), and some MCP tools write. The guard should block `mcp__*` calls in plan mode unless the user allows a server; to be decided in WP-E.

**Prompt.** No system prompt swap, so the main prompt stays byte-stable and the prompt cache survives. `before_agent_start` returns a message (`customType`, content "[PLAN MODE] ...", `T:1125-1129`) on user turns only (`messageType === "user"`, `T:720-742`), as pi's example does (`index.ts:203-215`). The message says: read-only, explore with scouts and the planner, write the plan to `<path>`, ask the user, and do not implement.

**Artifact.** Markdown at `<sessionDir>/plans/<id>-r<n>.md`, inside pi's session dir (AGENTS.md storage rule). Written only through the guarded `write`; each write increments the revision. The widget shows title, revision and path; the user can open it with pi's external editor key. Exporting it to the workspace is an open question.

**Approval.** `/plan approve` or a confirm dialog; the approval binds to plan id, revision and a content hash and is appended as a custom entry. An edit after approval invalidates it. Ambiguous assent in chat, tool errors, missing UI and cancellation never approve (future-plans/plan-mode.md, "Recommended user experience", step 6). On approve:
1. restore the tools from before plan mode;
2. if `plan.approved.model` or `plan.approved.thinking` is set, call `setModel` and `setThinkingLevel` (`T:1298, 1305`); pi persists both as `model_change` and `thinking_level_change` entries (`AS:1986, 2096`). `setModel` returns `false` without credentials: stay on the current model and warn;
3. inject a user-visible message "Execute plan <id> r<n>: <path>" that starts the next turn.

**Persistence.** `appendEntry("subagents:mode", { mode, planId, revision, toolsBefore, modelBefore })` on every change. On `session_start` with reason `resume`, `fork` or `reload`, restore from the last entry on the current branch (`getBranch()`, not `getEntries()`, per `PI/docs/extensions.md:236`); on `new` start in `normal`. A session-limits handoff starts a new session, which does not inherit custom entries, so the handoff text carries the mode and the plan path, and the successor re-enters plan mode from them.

**Settings** (`pi-subagents.json`; model names here are user data):

```json
{ "plan": { "model": "provider/strong-id", "thinking": "high", "approved": { "model": "provider/cheaper-id", "thinking": "medium" } } }
```

Every field is optional. With no `plan` key the model never changes, matching future-plans/plan-mode.md ("Preserve the user's model and thinking settings"); switching is opt-in. Without `plan.approved`, leaving plan mode restores `modelBefore` if `plan.model` changed it. A manual `/model` during plan mode (`model_select`, `T:885-890`) wins and is not undone.

## Nesting depth stays at 3

Keep `maxDepth: 3` (`settings.ts:35`): main, lead, chore. Chores spawn nothing (`subagents: []`). Keep `maxChildrenPerAgent` (`settings.ts:49`, enforced at `runner.ts:722`). Add to the lead prompts a rule that a lead reports `Status: partial` rather than re-delegating its whole task; today only per-lead scout limits exist (for example `agents/leads/planner.md:14`). Evidence (nesting-modes-and-setup.md, A): Claude Code defaults to three layers below the main conversation since 2.1.219 (2026-07-24), after briefly disabling nesting in 2.1.217; Cursor 2.5 has exactly our shape (main and direct subagents spawn, grandchildren cannot); Codex and Gemini CLI default to no nesting. The literature is neutral: arXiv 2512.08296 tested flat topologies only (centralized 4.4x against independent 17.2x error amplification) and calls hierarchy "an open question"; Anthropic warns "errors compound"; ReDel names agents that re-delegate the task they were given as the failure mode.

## Skills: three layers, narrowing down the tree

An agent's skills come from three layers:
- (a) the `skills:` list of its definition (shipped or own agent);
- (b) replaced by the `/agents setup` override for that agent when one exists (user file, then project file, project winning);
- (c) plus the call-time `skills` its caller passes on `run_agent` (`runner.ts:112-116`).

(b) replaces (a) rather than adding to it. The setup form is pre-filled from the frontmatter, so "unselect all" must be able to give an agent no skills; a union, as the user sketched, would make that impossible.

Rule at every depth: a caller may pass only skills in its own effective set. The main session's set is every skill pi loaded. Today `runner.ts:767-774` (`skillError`, `runner.ts:692`) validates against `runtime.skillNames()`, which is the main session's list at every depth (`pi-child.ts:369`), so a lead with `skills: []` can pass any skill to its scout. This becomes caller-aware: the runner validates against the caller's effective set (a, b and c of that caller). Chores keep `skills: []` and normally receive none; `general` keeps `skills: all`.

Precedent (settings-and-skills-layering.md): every product binds skills at definition time (Claude Code `skills:`, Agent SDK `AgentDefinition.skills`, Deep Agents per-subagent `skills`), and no product has a call-time parameter; that is this project's addition and the README should say so. Claude Code's `skills:` preloads bodies and does not narrow (unlisted skills stay invocable). The Agent Skills spec leaves scoping to the client ("Hide filtered skills entirely from the catalog").

**Shipping our own skills (optional).** An extension can contribute skill paths through `resources_discover` (`T:557-562`), for example a brief-writing or plan-format skill, instead of growing `main-session.md`. Not needed for the decision.

## Codemode and MCP

Codemode exposes every callable tool, not only MCP (`PI/docs/codemode.md:1-3, 34`; `PI/dist/extensions/codemode/tool.js:83`). Today `pi-child.ts:108` (`wantsMcp`, true for `tools: all` and any non-empty list) ties codemode, `tool_search` and MCP together: it adds the MCP tool names (`childToolNames`, `pi-child.ts:115`) and the three extensions (`mcpExtensions`, `pi-child.ts:120-133`). Split them:
- codemode and `tool_search`: every agent with `tools: all` or a non-empty tool list, as today;
- the MCP extension: only agents with `mcp: true` in their frontmatter.

MCP stays shared across agents as configured in `mcp.json` (user plus project), with no per-server filtering, so codemode over MCP is untouched. Shipped defaults: leads `mcp: true`, chores `mcp: false`. If per-server scoping is ever wanted, `createMcpExtension({ loadConfig })` can filter servers per child (`PI/dist/extensions/mcp/index.d.ts`, `McpExtensionOptions`); out of scope.

## Settings layering and agent overrides

**Today.** Agent definitions: shipped < user `<agentDir>/agents` < project `<cwd>/.pi/agents` (trusted only), whole-file shadowing (`plugins/agent-definitions/index.ts:25-33`). `pi-subagents.json`: user and trusted project, merged `{ ...defaults, ...user, ...project }` (`model/settings.ts:84-98`). Both load at session start (`src/index.ts:16-27`, `agent-definitions/index.ts:25`).

**Add: `agents.<name>` overrides** with `model` (`provider/id:thinking`), `thinking` and `skills`. Merge: definition, then user override, then project override, field by field; each field replaces. Tools are not overridable (create an own agent instead). Unknown agent names are reported as settings errors. Why override instead of a shadow file: a shadow file freezes the shipped prompt, so prompt fixes never reach that repo. Gemini CLI's `agents.overrides` is the precedent (settings-and-skills-layering.md). The settings schema needs an object rule and a per-agent deep merge instead of the top-level spread at `settings.ts:97`.

## `/agents setup` and `/agents create`

Both are first-word subcommands of the existing `/agents` command (`plugins/agent-view/index.ts:130-146`, which today treats any argument as an agent id). `complete` offers `setup` and `create` plus the live agent ids.

**`/agents setup`.** TUI only (`ctx.mode`); in other modes it fails with a message naming the file to edit. It writes `<cwd>/.pi/pi-subagents.json` `agents.<name>` and needs a trusted project; the user-level file stays hand-editable. The form runs on `Host.ui.showForm` (`core/adapter/contract.ts:185`, `core/adapter/pi-form.ts`):
- one tab per agent: leads, chores, then own agents; tab bar and tab keys reused from the questionnaire (`extensions/questionnaire/src/form.ts:113-118`, `render.ts:116`);
- model: a picker from pi's model list filtered to providers with credentials (`core/adapter/pi-models.ts`), stored as `provider/id:thinking`;
- thinking level;
- skills: a new multi-select component (checkbox rows, space toggles, `a` all, `n` none, scroll window), pre-filled from the definition;
- tools, read-only, with the line "Tools are fixed per agent. To change tools, create your own agent with /agents create.";
- MCP as an info line: "MCP servers are shared by all leads as configured in mcp.json: <names>. Chores do not see MCP.";
- a Submit tab that writes the file and shows the merged result.

It takes effect at the next session start. An immediate reload is feasible: settings and definitions are both plain loads run from `onSessionStart` (`src/index.ts:16-19`, `agent-definitions/index.ts:25-33`), so a `reload()` that re-runs both after the write applies to agents started afterwards; running agents keep their config. A one-line form serves scripts: `/agents setup <agent> model=... thinking=... skills=a,b|all|none`.

**`/agents create <name> [from <agent>]`.** No wizard: products dropped them (Claude Code removed its `/agents` wizard in 2.1.198, 2026-07-01, "ask Claude to create or manage subagents, or edit `.claude/agents/` directly"; Cursor says "ask Agent to create one"; Codex is TOML only; Gemini's `/agents config` tunes existing agents only; nesting-modes-and-setup.md, C). The command scaffolds `<cwd>/.pi/agents/<name>.md` from a template, or from a copy of a shipped agent with `from`, with every frontmatter field documented in comments in the body (`name`, `description`, `model`, `limit`, `tools`, `skills`, `subagents`, `mcp`, `worktree`). It then tells the user to edit the file, or to ask the main session to, since normal mode has `write`.

## No resumable or held leads for now

The earlier draft recommended `hold: true` (keep a finished lead's session open in an `idle` state for `message_agent`). Dropped for now:
- the capable main session holds the planning context itself, so the planner lead is a deep-dive helper, not the loop;
- a re-review is better done fresh, without the first reviewer's framing;
- fixes go to the implementer with the reviewer's findings in the brief;
- results persist on disk (`result.md`, and the Agent folder line in the task header, `run-agent/task.ts:12`), so a re-brief can point at them in `files`;
- `hold` adds an idle state that interacts with `pi:busy` (`plugins/agent-registry/index.ts:9, 17-20`), the session-limits handoff (`limits.ts:155-179`), caps and timeouts, which is the fragility the user fears.

`message_agent` stays as is. Revisit only with a measured re-brief cost.

Footnote: if resuming is ever needed, a finished agent's JSONL can be reopened with `SessionManager.open(path, sessionDir?, cwdOverride?)` (`PI/dist/core/session-manager.d.ts:378`) and passed to `createAgentSession({ sessionManager })` (`PI/dist/core/sdk.d.ts:60`).

## Work packages

| WP | Work | Depends on | Size | Needed for the decision |
| --- | --- | --- | --- | --- |
| A | **Removal**: drop `delegateOnly` settings and the restriction call; delete `delegate-only.test.ts`; strip `settings.test.ts` ([delegate-only-removal.md](delegate-only-removal.md)) | | S | Yes |
| B | **Normal-mode prompt** and routing live suite adaptation (tool set per mode, relax "exactly one agent") | A | S | Yes |
| C | **Skills**: caller-aware validation in the runner; `agents.<name>` overrides (model, thinking, skills) merged in the loader; settings object rule and per-agent merge | | M | No |
| D | **Codemode split**: `mcp` frontmatter field (leads `true`, chores `false`), codemode and `tool_search` as today, MCP tool names and extension only with `mcp: true` in `pi-child.ts` | | S | No |
| E | **Plan mode**: `setTools`/`restore` on the host, `/plan` and shortcut, guard, prompt message, artifact, approval, persistence, `plan` settings, lead rule against re-delegating the whole task | A | L | No |
| F | **`/agents setup`** form, multi-select component, one-line form, reload | C, D | L | No |
| G | **`/agents create`** scaffold and template | D | S | No |
| H | **Docs**: README, ARCHITECTURE.md, STRUCTURE.md per WP; README says call-time skills are this project's addition | each | M total | Yes for A, B |

The decision takes effect with A and B: the main session runs on the user's model with its full tool set and the normal-mode prompt. C to G can follow in any order allowed by the dependencies.

## Open questions

1. ctrl+alt+p as the plan shortcut, or ask users to rebind pi's thinking cycle off shift+tab and take shift+tab, as every other product does?
2. Should the plan artifact also be exportable to the workspace (Cursor's "Save to workspace"), and where?
3. Should `/agents setup` also write the user-level file (a scope choice in the form), or stay project-only?
4. Does `planner` stay a lead usable in normal mode, or become a plan-mode-only agent?
5. Approval UI: a confirm dialog when the plan is written, `/plan approve`, or both?
