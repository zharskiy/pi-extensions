# The company side as the primary design

This report designs what a company builds on top of pi-extensions for the `feature` and `epic` workflows, then derives what the harness must provide. It follows the owner's ten decisions, which override `future-plans/`. A complete example package sits next to this file in `example/`; section A describes it and section B explains the two workflows in it.

Line references to `extensions/subagents/README.md` use the file's own line numbers. "pi docs" means `node_modules/@earendil-works/pi-coding-agent/docs/`.

## A. What a company builds and where it lives

### A.1 Shape: one pi package plus one script

The company keeps one private repo, installed as a pi package. pi packages carry extensions, skills, prompt templates and themes only (pi docs `packages.md`, "Pi packages install and distribute extensions, skills, prompt templates, and themes"). So skills load from the package today. Agent files do not: subagents reads only its own `agents/`, `<agentDir>/agents` and a trusted project's `.pi/agents` (`extensions/subagents/src/plugins/agent-definitions/index.ts:42-48`, `src/model/paths.ts:15-17`). The example therefore ships a copy script for its one agent (see C.2).

```
acme-pi/
  README.md                         install and use
  package.json                      pi manifest: "skills": ["./skills"]
  departments.json                  departments, repos, branch scheme, check commands, workbench root
  departments/{be,fe,qaa}/AGENTS.md department context, copied into each workbench
  agents/tech-lead.md               the MCP-enabled company lead
  skills/
    workbench/SKILL.md              user-invoked: new, add, branch, list
    feature/SKILL.md                user-invoked: the feature workflow
    epic/SKILL.md                   user-invoked: the epic workflow
    tracker/SKILL.md                model-invoked: how the company uses its work-management MCP
    requirements-interview/SKILL.md model-invoked: grilling, adapted
    write-spec/SKILL.md             model-invoked: to-spec, adapted
    write-contract/SKILL.md         model-invoked: cross-department interface
    task-briefs/SKILL.md            model-invoked: to-tickets plus AGENT-BRIEF
    review-axes/SKILL.md            model-invoked: two-axis review, passed to reviewer agents
  templates/
    workbench-AGENTS.md  WORKBENCH.md  requirements.md  contract.md  brief.md  pr-body.md
  scripts/
    workbench.sh                    clone repos into a workbench, create department branches
    install-agents.sh               workaround: copy agents/ into <agentDir>/agents/acme/
```

### A.2 Inventory

| File | Purpose | Read by | Contents |
|---|---|---|---|
| `departments.json` | Single source for repos and branch naming | `workbench.sh`, `workbench` and `task-briefs` skills | per department: name, branch pattern (`feature/{ticket}-{slug}`, `feat/{ticket}/{slug}`, `qa/{ticket}_{slug}`), repos with remote, default branch, check command |
| `departments/<dept>/AGENTS.md` | Department rules every agent in that department sees | pi as a context file, for any session or agent whose cwd is under `<workbench>/<dept>/` | stack, where contracts live, selector rules, branch scheme, merge position |
| `agents/tech-lead.md` | The only agent with company MCP access besides the main session | main session via `run_agent` | read-only tools, `mcp: true`, `skills: [tracker]`, `subagents: [scout, fetch]`; never writes to the tracker; returns a cited Digest, a Draft, Gaps |
| `skills/workbench` | Workbench lifecycle | main session, on `/skill:workbench` | layout, commands, how to propose repos from the epic |
| `skills/feature`, `skills/epic` | The workflows | main session, on `/skill:feature KEY` and `/skill:epic KEY` | resume rule, stage table, per-stage instructions, gates, tracker writes |
| `skills/tracker` | The one place that knows the work-management tool | main session; `tech-lead` (frontmatter) | ticket hierarchy, statuses the workflows may set, where documents go, "write only after approval" |
| `skills/requirements-interview` | Interview in rounds over the decision frontier | main session (agents cannot ask the user, README:44) | Pocock's grilling rules, coverage list, done-when |
| `skills/write-spec` | Synthesis without re-interviewing | main session | to-spec rules, template pointer |
| `skills/write-contract` | Cross-department interface | `tech-lead` (passed per task) | interfaces with owner, consumers, door type, test ids, merge order |
| `skills/task-briefs` | Tracer-bullet split and AGENT-BRIEF | main session, optionally `tech-lead` for a first split | split rules, quiz step, brief rules, coverage check |
| `skills/review-axes` | Spec and Standards axes kept apart | `reviewer` (passed per task) | Pocock's code-review axes |
| `templates/*` | Artefact shapes | the skills above | see A.5 |
| `scripts/workbench.sh` | Mechanical workbench steps | `workbench` skill via bash | `new`, `add`, `branch`, using `jq` over `departments.json` |

User-invoked skills carry `disable-model-invocation: true` (pi docs `skills.md`) so they cost no prompt space and never start by themselves. Step skills are model-invoked with "Use when" descriptions, so a workflow can say "follow the `write-spec` skill" and the main session can pass them to agents through `run_agent` `skills` (README:89).

### A.3 Company agents

- `tech-lead` is the owner's "MCP-enabled lead". It exists to keep tracker and wiki reading out of the main context: the main session asks it for a digest of a ticket tree or a contract draft, and receives a cited result. It writes nothing to the tracker by prose rule; the main session writes after a user gate. Its frontmatter fits today's schema (README:59-69). It uses `model: inherit:high` so the example names no model.
- No department implementers. Local implementation, when it happens, uses the shipped `implementer` with the department's AGENTS.md in reach (context file or brief pointer). CI implementers are the company's CI setup, not pi agents in this package.
- No requirements interviewer agent. An agent cannot talk to the user (README:44), so the interview has to run in the main session. A skill is the right form.
- `scout` stays local-only (`agents/chores/scout.md:10`, `mcp: false`), as the owner decided.

### A.4 Workbench convention

```
~/work/SHOP-812/                one workbench per epic key (feature key when there is no epic)
  AGENTS.md                     generated: which epic, where things are, how to resume, handoff rule
  WORKBENCH.md                  manifest (frontmatter) and stage log
  docs/                         working copies: context.md, requirements.md, contract.md, contract/, <FEATURE>/spec.md, <FEATURE>/briefs/
  be/AGENTS.md                  copy of departments/be/AGENTS.md
  be/order-service/             ordinary clone, default branch
  fe/AGENTS.md
  fe/web-orders/
  qaa/AGENTS.md
  qaa/e2e-tests/
```

- Clones, not worktrees. The same repo in two workbenches is two clones, so two pi sessions on one repo never share a working tree.
- Branches: clones stay on the default branch for research. `workbench.sh branch <dept> <TICKET> <slug>` creates the department-scheme branch only for local implementation. For CI, the brief carries a `Branch:` line computed from the scheme with the task key.
- How a session knows where it is: pi loads context files from the cwd and every parent (pi docs `configuration.md`, "Context files"). The main session runs in the workbench root and gets the workbench `AGENTS.md`. A session or agent started inside `be/order-service/` also gets `be/AGENTS.md` and the workbench `AGENTS.md`, so it knows the department and the epic without any harness code. Today's subagents keep the context files of the main session's cwd, because agents run in it (`src/plugins/run-agent/placement.ts:31-32`); see C.3.
- Several sessions in one workbench: one per department feature is safe because departments own different repos; each session edits only its own section of the stage log.

### A.5 Templates

- `requirements.md`: Problem, Solution, numbered user stories, `WHEN … THE SYSTEM SHALL …` criteria, testing seam, decisions with door type, Out of scope, Open questions. Used for an epic's requirements and a feature's spec.
- `contract.md`: per interface the owner, consumers, shape with a pointer to a schema fragment, errors, compatibility, door, covered criteria; test ids and data; merge order.
- `brief.md`: AGENT-BRIEF form (Current behaviour, Desired behaviour, Key interfaces, Acceptance criteria, Out of scope) plus a header line with task, feature, repo, branch, blocked-by, spec and contract links. No paths or line numbers.
- `pr-body.md`: Summary, Evidence, Merge danger (door, blast radius, merge order).
- `WORKBENCH.md` and `workbench-AGENTS.md`: the manifest and the generated context file.

## B. The two workflows

### B.1 Chosen form: prose skills, with the stage table written in Markdown

Each workflow is one user-invoked skill. Its body holds a Markdown stage table (stage, who, output, gate) and a short paragraph per stage. Step skills hold the reusable practice. State lives in two places the company already controls: `WORKBENCH.md` and the tracker's statuses.

Why not a declarative file the harness runs: every field such a file needs (stage ids, gates, tracker writes, artefact roots, department fan-out) is company-specific, so the harness would need a schema for things it must not know. The model already follows a Markdown table reliably, a gate is just "wait for the user's approval" in a conversation the main session owns, and resuming is "read the log, find the first open stage". A skill also composes: `epic` stage 5 runs `feature` once per department without any engine support for nested workflows. The cost is that nothing enforces stage order. With a developer in the loop that failure is visible and cheap, and the earlier research found prose gates adequate for this setting (q4-q8 report, "Risk in the owner's setting"). Mixed forms were rejected because a parsed header would bring back the loader and validator of `future-plans/01-workflows.md` for no gain.

### B.2 Where outputs live

| Output | Working copy | Record | In a repo? |
|---|---|---|---|
| Intake digest | `docs/[<FEATURE>/]context.md` | none | no |
| Epic requirements, feature spec | `docs/requirements.md`, `docs/<FEATURE>/spec.md` | tracker attachment on the epic or feature, replaced per revision | no |
| Contract | `docs/contract.md`, `docs/contract/*` | tracker attachment on the epic | yes, through the contract owner's first brief (for example `api/openapi.yaml`) |
| Briefs | `docs/<FEATURE>/briefs/NN-slug.md` | task description, label `agent-ready`, `blocks` links | no |
| Progress | `WORKBENCH.md` stage log | ticket statuses | no |

The workbench is the editing surface, the tracker is the record, and repos receive only what code needs. CI agents never see the workbench, so a brief points at tracker links, never at `docs/`.

### B.3 Feature (`skills/feature/SKILL.md`)

| # | Stage | Who | Output | Gate | Tracker |
|---|---|---|---|---|---|
| 1 | intake | `tech-lead` plus one `scout` per repo, one batch | `context.md` | none | read ticket, parent, links |
| 2 | requirements | main session with the user | decisions in the conversation | user confirms shared understanding | set `Specifying` |
| 3 | spec | main session | `spec.md` | user approves the file | attach `spec.md`, set `Specified` |
| 4 | briefs | main session, `tech-lead` for a multi-repo first split | split, then briefs | user approves the split, then the briefs | create tasks, `blocks` links, `agent-ready` |
| 5 | handover | main session | none | none | set `Ready for agent` |

Optional after 5, only on request: local implementation per brief (`implementer`, then `verifier` with the repo's check command and the brief's criteria, then `reviewer` with `review-axes` for wide changes), and review of PRs that CI opened (`reviewer` with `review-axes` and the brief).

Stages 2 to 4 stay in one session context on purpose (Pocock's phase-boundary rule). If session-limits hands off mid-way, the workbench `AGENTS.md` tells the model to put the workflow, ticket and stage first under Next, which the handoff template already has (`extensions/session-limits/prompts/handoff.md`, "## Next") and the main prompt already continues from (`extensions/subagents/prompts/main-session.md:45`).

### B.4 Epic (`skills/epic/SKILL.md`)

| # | Stage | Who | Output | Gate | Tracker |
|---|---|---|---|---|---|
| 1 | intake | `tech-lead` plus scouts over all repos | `docs/context.md` | none | read epic tree |
| 2 | requirements | main session with the user | `docs/requirements.md` | confirm understanding, approve file | set `Discovery`, attach |
| 3 | contract | `tech-lead` drafts (two or three in parallel on request), main session revises with the user | `docs/contract.md`, `docs/contract/*` | user approves, one-way door | attach, set `Contract agreed` |
| 4 | split | main session | one feature per department, merge order | user approves the list | create features with `Department`, link to contract |
| 5 | departments | `feature` workflow per department feature, in merge order, same or separate sessions | specs and briefs | as in feature | as in feature |
| 6 | close-out | main session | none | none | comment merge order and keys, set `In delivery` |

FE plus BE plus QAA: the contract comes first and is fixed for stage 5. The contract owner's feature starts with a brief that publishes the contract into its repo; every other department's first brief is `blocked by` it, so CI cannot start consumers before the contract exists in code. QAA goes last in merge order and writes scenarios from the acceptance criteria and the contract's test ids. A needed contract change goes back to stage 3 only through the user.

### B.5 Resume after a break

The user starts pi in the workbench and runs the same skill. The skill reads `WORKBENCH.md`, reports done stages, checks that the tracker status agrees, and continues at the first `open` stage. No harness state is involved, so this works after `/new`, after a session-limits handoff, on another day, or from a second session.

## C. What the company needs from the harness

Status words: **exists** (cite), **planned** (spec), **missing**, **not needed** (the company does it with files only).

1. **Skills from a company package, available to the main session and passable to agents.** Exists. pi loads package skills (pi docs `packages.md`); subagents passes the main session's skill files to children (`core/adapter/pi-child.ts:195-206`, README:87-89).

2. **Agent files from a company package path.** Missing. Loader dirs are fixed (`src/plugins/agent-definitions/index.ts:42-48`, `src/model/paths.ts:15-17`). Symlinking a company folder into `<agentDir>/agents/` does not help: the walk uses `readdirSync(..., { withFileTypes: true })` and keeps only `isDirectory()` and `isFile()` entries (`src/plugins/agent-definitions/loader.ts:168-177`), so a symlinked subfolder is skipped. Workaround in the example: `install-agents.sh` copies files, which goes stale after each package update. Smallest fix: an `agentDirs` list in the user `pi-subagents.json`, loaded as a source between user and project (or follow symlinks in the walk). `future-plans/00-overview.md:86-102` assumed this worked.

3. **`cwd` per `run_agent` item.** Missing in the tool schema (`src/plugins/run-agent/tools.ts:144-172`, `additionalProperties: false`), though `SpawnSpec.cwd` exists (`core/adapter/contract.ts:333`) and the child session already starts there (`core/adapter/pi-child.ts:198,230`). Placement always uses the session cwd unless the agent is a worktree agent (`placement.ts:27-32`). Needed so an agent in `be/order-service` loads that repo's and the department's AGENTS.md and project settings, and so `implementer` and `verifier` run commands in the repo. Without it, briefs pass absolute paths and tell the agent which AGENTS.md to read; that is fine for scouts and adequate for occasional local work. Planned in `future-plans/04-workspace-and-epic.md` "Where sessions run", but only the bare field is needed now: an absolute path or a path relative to the session cwd, inside the session cwd, with the session's trust. No workspace file, no branch logic, no worktree creation.

4. **Verifier chore.** Exists: `extensions/subagents/agents/chores/verifier.md:1-21` and the routing line in `prompts/main-session.md:9`. The company passes the check command from `WORKBENCH.md` and the brief's criteria.

5. **Workflow files loaded by the harness, a stage or gate engine, `start_workflow`/`finish_stage`.** Not needed. Workflows are skills (B.1). Recommend dropping the engine part of `future-plans/01-workflows.md` ("Selection and execution", loader, tools, state).

6. **Gates that ask the user.** Exists. The main session's own turn waits for the user; the `questionnaire` tool covers rounds of choices (`extensions/questionnaire/README.md`, "What it does").

7. **Extending the main-session prompt from company data.** Not needed. Subagents replaces only pi's preamble (`core/adapter/main-prompt.ts:64-74`, set through `core/adapter/pi-adapter.ts:229-237`); pi still appends `APPEND_SYSTEM.md` and context files after it (pi `dist/core/system-prompt.js:97-100`). The workbench `AGENTS.md` carries everything the workflows need. One soft conflict: `main-session.md:1` and `:7` tell the model to plan multi-step work with `planner`; the workflow skill is explicit, so it wins in practice. Replacing the main prompt is not needed.

8. **Progress that survives a session handoff.** Not needed. `WORKBENCH.md` and tracker statuses hold it; the handoff template's Next section and `main-session.md:45` carry the pointer.

9. **MCP for a company agent.** Exists: `mcp: true` connects every enabled server for that agent (README:69, README:95). A per-server or read-only filter is missing (README:95, "there is no per-server filter"). Nice to have so `tech-lead` cannot write to the tracker by accident; today that rule is prose. Not a blocker.

10. **`agents.<name>.mcp` override (06 spec).** Not needed. Overrides accept `model`, `thinking`, `skills` only (`src/model/agent-override.ts:6`), and the owner wants `scout` without MCP; the company ships its own MCP agent instead.

11. **Configurable artefact root.** Not needed. Skills say where files go; nothing in the harness writes workflow artefacts.

12. **Workbench support (workspace extension, `pi-workspace.json`, `/epic` commands).** Not needed beyond item 3. Layout, cloning and branch naming are the company's script and skill; context files come from pi.

13. **Result contract and per-task skills for agent briefs.** Exists (README:89, README:101; `prompts/base-system-prompt.md:12-24`).

14. **An `examples/company/` folder in this repo.** Not a harness feature, but the "value" the owner asks for: a tested, copyable starting point. Proposed content is `example/`.

Net harness work: item 2 (must), item 3 (should, small), item 9 filter (could). Everything else is documentation and the example.

## D. Open decisions for the owner

1. **How agents load from a company package.** Recommend an `agentDirs` setting in the user `pi-subagents.json`, read as a source between user and project. Alternatives: follow symlinks in the loader walk (smallest code, but relies on the user making the link), or discover an `agents/` folder inside installed pi packages (no setup, but subagents would have to know where pi installs packages, which is pi internals).

2. **Scope of `cwd`.** Recommend: allowed only inside the session cwd (the workbench), inheriting the session's trust, no git side effects. Alternative: any path, with a trust check per target directory, which needs adapter work and a confirmation flow.

3. **Who writes to the tracker.** Recommend the main session only, right after a user gate, with agents read-only by prose (and by filter once item 9 exists). Alternative: let `tech-lead` create tickets, which saves main-session context but puts writes where the user cannot confirm them (README:44).

4. **Record of specs and briefs.** Recommend the tracker as the record and the workbench `docs/` as the editing copy, nothing committed except contract schemas through the owner's first brief. Alternative: commit specs into a repo (`docs/specs/`) like superpowers or OpenSpec, which gives review in PRs but splits the record across departments' repos.

5. **Feature without an epic.** Recommend a workbench keyed by the feature's own ticket key, same layout. Alternative: require every feature to sit under an epic.

6. **Where the example lives.** Recommend `examples/company/` in this repo, not installed by `pi install`, with a README warning that it is a template. Alternative: a separate public repo, which keeps this package smaller but lets the example drift from the harness.
