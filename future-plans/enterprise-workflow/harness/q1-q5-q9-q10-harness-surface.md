# Owner pushback: harness surface (Q1, Q5, Q9, Q10)

## Q9. What checks an implementer's work today?

The expensive reviewer checks it. Nothing else does.

- `extensions/subagents/prompts/main-session.md:7`: "A change whose files or behaviour are named, or 'run the checks and fix what fails': `implementer`, then `reviewer` on the change."
- `extensions/subagents/agents/leads/planner.md:19`: "Every implementer row is followed by a reviewer row in a later batch."
- `agents/leads/implementer.md:4` cheap family at medium; `agents/leads/reviewer.md:4` strong family at high; chores cheap at low.
- No verifier agent exists. `prompts/base-system-prompt.md:18` requires a `Verification:` line but "none" is accepted. `main-session.md:33` only says "check that it meets the Goal".
- The `shell` chore could run the check command cheaply; never named as a post-implementer step.

Under the plan, `main-session.md:7` and `planner.md:19` change only inside workflows (01 line 135 swaps the "plan first with planner" sentence but leaves line 7).

Recommendation: ship `verifier` as step 1 regardless of workflows. Change `main-session.md:7` to "`implementer`, then `verifier` with the Done-when list. Add `reviewer` only when the change touches several modules or public interfaces, or the user asks." Relax `planner.md:19` the same way.

## Q1. Why `code-map` if the company has a master-indexed MCP?

05 gives: Roots table, Layers, Glossary, ADR pointers, Known gaps. Scout reads map first, translates into each stack's names, searches every root locally.

A master-indexed MCP covers most of "which repo, which file". 05 already treats such a server as an add-on (line 69 onward).

What the map still provides:
1. Local paths on the developer's machine. In a workspace `pi-workspace.json` already does this (05 line 50). Adds nothing in a workspace.
2. Branch divergence: MCP indexes master; a scout on a branch sees renamed/new symbols. 05 line 75 "confirm each hit locally" is a scout prompt rule, not a map feature.
3. Vocabulary before the first query: the glossary ("discount eligibility" is `DiscountPolicy`, `useDiscount`, `@discount`). A semantic MCP narrows this; a keyword MCP does not.
4. Cost and latency: each MCP call is a network round trip, plus a `tool_search` step with `deferred` exposure. The map is ~1k tokens in the cached prompt.
5. Layer routing for parallel scouts: the planner needs repo-to-layer facts before briefing scouts.
6. Offline and access control; matters less in an enterprise.

With a company MCP: Roots redundant in a workspace; Layers and ADR pointers nice to have; Known gaps a symptom. The real residue is the glossary and a one-line purpose per repo. Points 2 and 4 are better handled by scout prompt rules.

Recommendation: shrink, do not drop. Optional convention with two sections: repo-purpose table (only where `pi-workspace.json` does not carry it) and the cross-stack glossary. Drop Layers, Decisions, Known gaps and the shipped refresh brief. Keep scout prompt changes rewritten around the MCP: query it first for discovery, confirm every hit with local grep on the current checkout, use the glossary. Keep `agents.<name>.mcp` override (06): without it the MCP is unreachable from `scout` (frontmatter `mcp: false`; override schema accepts `model`, `thinking`, `skills` only).

## Q5. Is the workflow too strict? Plain research, other doc locations, superpowers, OpenSpec?

### How the three frameworks work

obra/superpowers (https://github.com/obra/superpowers): skills plus a bootstrap hook; plugin folders for 16 harnesses, Pi among them ("a small extension that injects the `using-superpowers` bootstrap at session startup and again after compaction"). `using-superpowers`: "If you think there is even a 1% chance a skill might apply … you ABSOLUTELY MUST invoke the skill"; "User instructions (CLAUDE.md, AGENTS.md …) take precedence over skills". Documents in repo: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` ("User preferences for plan location override this default"). Hard gate: "Nothing gets built until your human partner approves". Chains brainstorming, writing-plans, subagent-driven-development or executing-plans. Assumes git worktrees and a test runner. Its Pi reference says "Pi core does not ship a standard subagent tool", names a different `pi-subagents` package with a `subagent` tool (https://raw.githubusercontent.com/obra/superpowers/main/skills/using-superpowers/references/pi-tools.md).

OpenSpec (https://github.com/Fission-AI/OpenSpec): CLI generating slash commands for 30+ tools: `/opsx:explore`, `/opsx:propose`, `/opsx:apply`, `/opsx:archive`. Documents: `openspec/specs/`, `openspec/changes/<name>/` with `proposal.md`, `specs/` deltas, `design.md`, `tasks.md`; archive under `openspec/changes/archive/<date>-<name>/`. SHALL and WHEN/THEN wording (same as 01). "No rigid phase gates"; advises a clean context before implementation.

GitHub spec-kit (https://github.com/github/spec-kit): `specify` CLI installs `/speckit-*` commands ("agent skills, not terminal commands"): constitution, specify, plan, tasks, implement, converge. State in `.specify/` (`memory/constitution.md`, `feature.json`). Feature docs `spec.md`, `plan.md`, `tasks.md`. Numbered git branches opt-in.

Common: enter through skills or commands pi already loads; own their document root inside the repo, committed; own their stage sequence and gates; assume a subagent primitive and a harness that stays out of the process.

### Where 01 conflicts

- A second stage engine (`start_workflow` / `finish_stage` plus a prompt section) competes with superpowers' mandatory skill chain for the same turn.
- The main session picks a workflow by itself (line 114); superpowers/OpenSpec users get 01 stages applied anyway.
- Artefact location hard-coded to `<session folder>/workflow/<stage>.md` (not committed); the frameworks keep artefacts in the repo. Duplicates; a successor would not find `openspec/changes/x/tasks.md`.
- `mode: plan` tied to harness-enforced read-only; superpowers and OpenSpec write their design/proposal during planning.
- The main prompt replaces pi's system prompt wholesale; customising means editing the package checkout; no setting to disable or soften.
- `feature` as default for multi-step work; a plain research question risks the three-gated `research` workflow.

Harmless or helpful: verifier and `Verification:` shape note; named agents with model-per-agent; `run_agent`; project override of workflow files; questionnaire; `retries`. Explicit `/workflow` is harmless.

### Hard-code vs configurable

Hard-code: `run_agent`, agent roles, result contract; verifier and `Verification:` rule; read-only enforcement as an available tool (entering optional); one generic way to record progress (stage id plus artefact path) that survives handoff.

Configurable: workflows off by default (run on `/workflow <name>` or `workflows.auto: true`); no mandatory stage loop, research is a plain conversation (drop `research` from the shipped set or ship as example); artefact root as a setting (`workflows.artefactRoot`, default session folder; can point at `docs/plans/`, `openspec/changes/<name>/`); plan-mode allow-list for writes under the artefact root; main-prompt sections that can be disabled or replaced from settings or a package path.

Recommendation: treat 01 as an opt-in engine. Automatic selection off, no workflow section unless one is active, configurable artefact root, `research` as conversation. Keep `feature` and `bug-fix` as examples and company template. Document side by side with superpowers and OpenSpec: "their skills for process, pi-subagents for agents and verification." The harness is the substrate, not a competitor.

## Q10. Company-side workflows: what must the harness provide?

Packaging: pi packages ship extensions, skills, prompt templates and themes only (`node_modules/@earendil-works/pi-coding-agent/docs/packages.md`). Skills and prompts load today (`core/adapter/pi-adapter.ts:490–494`; passed to children `pi-child.ts:202`). Agent files do not: loader reads bundled, `<agentDir>/agents`, `.pi/agents` only (`extensions/subagents/src/model/paths.ts:15–17`). Workflow files would not either (01 § User surface). `pi-subagents.json` is user and project only. So `company-conventions/` in 00 lines 88–102 assumes discovery that does not exist for `agents/`, `workflows/`, `pi-subagents.json`, `pi-session-limits.json`, `mcp.json`.

### (a) Primitives

| Primitive | Status |
|---|---|
| Run an agent with role and task, batches, woken on completion | Exists: `run_agent` |
| Read-only agents | Exists: `tools:` frontmatter |
| Cheap verifier with pass/fail | In plan (01, decision 7); missing today |
| `Verification:` required for `done` | Partial: "none" accepted; shape note planned |
| Status contract (done, partial, blocked, `Wrong agent:`) | Exists |
| Retry policy | Partial: "retry once" in `main-session.md:36`; per-stage `retries` planned |
| Record stage progress surviving handoff | In plan (`finish_stage` custom entry); today only the generic handoff file |
| Artefact path setting | In plan, hard-coded; configurable root missing |
| Gates that ask the user | Partial: questionnaire and `HostUi.confirm` exist; gate semantics planned |
| Harness-enforced read-only phase | In plan (02), needs `Host.onToolCall` |
| Per-agent `tools`, `mcp`, guards overrides | In plan (06); today `model`, `thinking`, `skills` only |
| `cwd`/repo per agent | In plan (04); today same-repo `worktree: true` |
| Load workflows, agents, settings from a package path | Missing. Needs a `paths` setting or discovery next to package skills |
| Append to or replace main-prompt sections from company data | Missing. README says edit the package checkout, which `pi update` overwrites |
| Workflow loader and validator | In plan (01 loader.ts, yaml-lite.ts) |

### (b) Company data

Stage lists; gates and retries; stage prompts and brief templates; document templates and artefact root; rules and conventions as skills; glossary and repo purposes; check commands per repo; model per agent, MCP servers, guards, idle-handoff tuning; company-specific agents.

Recommendation: yes, complicated workflows live company-side. Two gaps block a clean company package: (1) subagents cannot load agents, workflows or settings from a package path; (2) the main prompt cannot be extended without forking. Close those, plus make the verifier and a configurable artefact root real. Then the shipped workflow set becomes optional sample content.
