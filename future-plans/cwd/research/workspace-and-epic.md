# Workspace layout and cross-repo epics

Date: 2026-10-17. Scope: research and design proposal only, nothing implemented. Covers (a) a multi-repo workspace layout with git worktrees, (b) how an orchestrating main session plans and runs a cross-repo epic with background agents, and (c) how requirements exploration over the "master" checkouts stays stable while implementation happens in per-epic worktrees. The motivating case (a backend service, one or more frontends on different stacks, a separate test-automation repo) is treated as a use case, not as built-in knowledge: nothing below names a company, stack, provider or model.

## 1. What pi-subagents does today

- `worktree: true` (`extensions/subagents/src/plugins/run-agent/worktree.ts`, `placement.ts`; `ARCHITECTURE.md` "Worktrees"; `extensions/subagents/README.md` "Worktree agents") creates **one worktree per agent run** at `<session cwd>/.pi/worktrees/<id>-<stamp>` on branch `pi-agents/<id>-<stamp>`, based on the **session's HEAD sha**, in the **single repo that contains the session cwd**. A handoff successor keeps it; at chain end it is removed without `--force` and the branch is deleted only if it never moved.
- `run_agent` items have `agent, task, description, files, model, skills` and **no `cwd`** (`run-agent/tools.ts` lines 140-175). Every agent runs in the session cwd (or its own worktree of that repo).
- Pi loads context files (`AGENTS.md`, `CLAUDE.md`) from the working directory **and its parents** (`node_modules/@earendil-works/pi-coding-agent/docs/configuration.md` line 43), and the working folder does not confine file access (`docs/security.md` line 19).
- The file-location rule (`AGENTS.md`, `ARCHITECTURE.md` "Persistence summary") allows writes only under pi's agent/session dirs, OS temp handoff dirs, `<cwd>/.pi/worktrees/`, and three `.pi/` project files on the user's command.

Fit for epics: poor. The current feature is the right tool for "parallel edits inside one repo, merged back by the caller". An epic needs worktrees that are **multi-repo, named per epic, based on the remote default branch, shared by sequential agents, and alive for days** until PRs merge. That is a different lifecycle, so it should be a separate, explicit mechanism, not an extension of `worktree: true`.

## 2. Findings

### 2.1 Worktrees and multi-repo tooling

- **Semantics.** A linked worktree has its own working tree, HEAD and index but shares objects, refs, config, hooks and stash with the main repo; a branch can be checked out in only one worktree at a time ([git-worktree docs](https://git-scm.com/docs/git-worktree), current). Consequence: the master checkout must stay on the default branch and the epic branch lives only in the epic worktree.
- **Pitfalls** ([workmux caveats](https://workmux.raine.dev/guide/git-worktree-caveats/), 2026; [Claude Code worktrees](https://code.claude.com/docs/en/worktrees), fetched 2026-10-17): gitignored files (`.env`, `node_modules`) are absent; symlinking `node_modules` breaks once dependencies diverge, so install per worktree; build dirs such as Rust `target/` must not be shared (use a compiler cache instead); worktrees do not prevent merge conflicts; hooks are shared and fire in every worktree; submodules need a per-worktree checkout; repo-local LFS/filter drivers are a security concern; IDE indexers can follow `.git` back to the main repo.
- **Prior art for setup.** Claude Code copies gitignored files listed in `.worktreeinclude`, branches subagent worktrees from the remote default branch unless `worktree.baseRef: "head"`, and lets a `WorktreeCreate` hook place worktrees elsewhere (same page). Conductor runs a per-repo `setup` script in every new workspace and exposes the root and workspace paths as env vars ([conductor.json](https://docs.conductor.build/core/conductor-json), 2026).
- **Manifest tools.** Google `repo` and Zephyr `west` keep many repos under one parent directory described by one manifest file ([west repo-tool](https://docs.zephyrproject.org/2.3.0/guides/west/repo-tool.html)); `vcstool` reads a `.repos` file and keeps no state beyond the checkouts ([vcstool](https://mirror.umd.edu/roswiki/vcstool.html)); `mani` uses a `mani.yaml` with projects, tags and tasks, and `mani init` auto-discovers subfolders with `.git` ([mani](https://github.com/alajmo/mani), last push 2024). Common shape: **one root folder, one small file listing repos with path, remote, tags and commands, discovery as a bootstrap**.
- **Agents across repos (2025-2026).** Cursor 3.2 added multi-root workspaces in the Agents window ([changelog](https://cursor.com/changelog/04-24-26), 2026-04-24), but worktrees require a single git root ([forum request for "Etz"-style coordinated worktrees](https://forum.cursor.com/t/feature-request-etz-style-unified-worktree-branch-support-for-multi-repo-non-git-root-folders/155985), 2026-03-26; [bug report](https://forum.cursor.com/t/3-17-8-auto-move-agent-to-root-treats-local-multi-root-as-multi-repo-cloud-agent/169046), 2026-08). Etz scans a parent folder of repos and creates same-named worktrees under a shared workspace directory, which is exactly the owner's "workbench" idea. Codex CLI is single-repo with `--add-dir` as a workaround; the recommended patterns are one session per repo, contracts referenced from each repo's AGENTS.md, and sequenced runs "spec first, then backend, then frontend" ([Vaughan](https://codex.danielvaughan.com/2026/05/19/codex-cli-cross-repository-development-multi-repo-sessions-coordination-patterns/), 2026-05-19). Vibe Kanban keeps independent git state per repo, opens one PR per repo with cross-references and merges in dependency order ([docs](https://www.vibekanban.com/docs/workspaces/multi-repo-sessions), 2026). Devin clones several repos into `~/repos/` per environment ([docs](https://docs.devin.ai/onboard-devin/new-repo-setup)). The BeyondSWE benchmark reports a large capability gap on cross-repo tasks ([arXiv 2603.03194](https://arxiv.org/pdf/2603.03194), 2026-03), which argues for strong structure (contract, per-repo checks) over agent autonomy.
- **The agent-per-worktree pattern** is now standard (Conductor, Crystal, opentree, Superset, Cursor, Claude Code `isolation: worktree`; [noqta guide](https://noqta.tn/en/blog/git-worktrees-parallel-ai-coding-agents-guide-2026), 2026). Nobody mainstream yet does "one epic = N coordinated worktrees"; Etz and Vibe Kanban come closest.

### 2.2 Cross-repo coordination

- **Contract first.** Define the interface (API spec, event schema, shared types) as a machine-readable file, then backend, frontend and tests proceed in parallel against it, frontends against mocks ([LaunchDarkly](https://launchdarkly.com/docs/tutorials/the-beauty-of-contract-first-api-design); [Specmatic with Codex](https://codex.danielvaughan.com/2026/04/23/contract-driven-api-development-codex-cli-specmatic-mcp/), 2026-04-23, which also runs contract tests outside the agent so it cannot game them).
- **Additive first, then producer, then consumers, remove last;** save the approved plan in the workspace; one agent chat per repo so each diff is one PR; merge in dependency order; record linked PRs, merge order and gate results in one place ([Cursor multi-repo workflows](https://developertoolkit.ai/en/cursor-ide/advanced-techniques/multi-repo-workflows/), 2026).
- **Pass decisions through files, not through the orchestrator's prose.** Anthropic's multi-agent research write-up has subagents write outputs to the filesystem and pass references, to avoid a "game of telephone" ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system), 2025-06-13). For an epic that is the contract file in the epic folder.

### 2.3 Workspace definition

Two families: an explicit manifest (`repo`, `west`, `vcstool`, `mani`, `.code-workspace`, `conductor.json`) or discovery (Etz, `mani init`). Practice converges on **discover once, then keep a small explicit file the user can edit**, because discovery cannot know check commands, stack tags or which repo is the test suite.

### 2.4 Worktree lifecycle

Per-epic worktrees on one branch name across repos (Etz, `repo start <branch>`), per-worktree dependency install (workmux, Conductor), fetch the default branch before branching (Claude Code `baseRef: "fresh"`), and keep worktrees that hold work until the PR merges (Claude Code's sweep keeps worktrees with unpushed commits). Sequential agents in one repo should share the epic worktree; parallel agents in the **same** repo are rare in an epic and can use pi's existing `worktree: true` off the epic worktree's HEAD.

### 2.5 Plan stability

The requirements explorer reads only master checkouts and writes a requirements/impact document with the **commit sha of each master** it read. When master moves, a validator re-reads only the files the plan cites (diff `sha..origin/default` restricted to those paths) and appends a "revalidated at" note or a list of drifted points; the plan is rewritten only if a cited fact no longer holds. This mirrors how lockfile-style pinning works and keeps the plan stable for the user's review.

## 3. Proposed layout

```
<root>/                               chosen once by the user, e.g. ~/work
├── master/                           read-only reference checkouts, always on the default branch
│   ├── AGENTS.md                     workspace-wide notes (optional, loaded as a parent context file)
│   ├── service-api/                  git clone (backend)
│   ├── web-shell/                    git clone (frontend A)
│   ├── web-orders/                   git clone (frontend B, other stack)
│   └── e2e-tests/                    git clone (test automation)
└── workbench/
    └── <epic>/                       one folder per epic
        ├── epic.md                   request, repos in scope, status, PR links
        ├── requirements.md           explorer output, with master shas
        ├── contract/                 interface decisions: spec, schemas, shared types
        ├── plan.md                   stages, per-repo tasks, checks
        ├── service-api/              git worktree of master/service-api, branch epic/<epic>
        ├── web-orders/               git worktree, branch epic/<epic>
        └── e2e-tests/                git worktree, branch epic/<epic>
```

The workspace definition sits beside `master/` (option B below). Only repos the epic touches get a worktree. Because pi reads parent context files, starting the main session in `workbench/<epic>/` lets every agent whose cwd is a repo worktree see both the repo's own `AGENTS.md` and the epic folder's notes.

## 4. Epic flow

| # | Who | Directory | Does | Artefact |
|---|-----|-----------|------|----------|
| 1 | User | anywhere | `/epic new <name>` with the request text | `workbench/<epic>/epic.md` |
| 2 | Main session (harness command) | `master/*` | `git fetch` + fast-forward every master checkout; refuse if one is dirty or off its default branch | shas recorded in `epic.md` |
| 3 | Explorer agents (read-only, parallel, one per repo or one overall) | `master/*` | Read the request, find impacted code, propose which repos are in scope | `requirements.md` (impact per repo, cited files, master shas) |
| 4 | Main session + user | epic folder | Confirm scope and requirements; this is the stable plan | `epic.md` scope list |
| 5 | Planner agent | reads `master/*`, writes epic folder | Draft the contract (additive changes first) and per-repo tasks with checks | `contract/*`, `plan.md` |
| 6 | Harness command `/epic worktrees` | `master/<repo>` → `workbench/<epic>/<repo>` | `git worktree add -b epic/<name> <path> origin/<default>` per scoped repo, then that repo's `setup` command | worktrees |
| 7 | Implementer agents, parallel, one per repo | `workbench/<epic>/<repo>` | Implement against `contract/`; backend implements, frontends code against contract/mocks, test agent writes scenarios; run the repo's own checks; commit | commits on `epic/<name>`, handoff result |
| 8 | Main session | epic folder | Judge results; a contract change goes back through the planner and is broadcast to running agents (`message_agent`) | updated `contract/`, `plan.md` |
| 9 | Integration agent | test worktree + others | Run the test repo against locally started services (if the workspace defines how), report failures per repo | `integration.md` |
| 10 | Reviewer agent, then user | worktrees | Review each repo's diff; user approves push; open one PR per repo, each linking the others and stating merge order (contract/producer, then consumers, then tests) | PR links in `epic.md` |
| 11 | `/epic close` | master + workbench | When all PRs merged: `git worktree remove` (no force), delete merged branches, fast-forward masters, archive the epic folder | — |

Requirements (step 3) only ever read `master/`; implementation (steps 7-9) only ever writes worktrees. If master moves mid-epic, step 2 reruns and a validator checks `requirements.md` against the diff (section 2.5); worktrees are rebased only on the user's command.

## 5. Workspace definition: options

**A. Pure discovery.** Every git repo directly under `master/` is a workspace repo; default branch from `origin/HEAD`; no checks known. Zero setup, but the harness cannot run checks or install dependencies, and agents must guess the stack each time.

**B. One small file at the root, bootstrapped by discovery (recommended).** `<root>/pi-workspace.json` (or `.pi/workspace.json` under the root, which would fit pi's project-config convention), written by `/workspace setup` from a scan and then edited by the user:

```json
{
  "master": "master",
  "workbench": "workbench",
  "repos": {
    "service-api": { "remote": "git@host:org/service-api.git", "default": "main", "tags": ["backend"], "setup": "...", "check": "..." },
    "e2e-tests":   { "remote": "...", "default": "main", "tags": ["tests"], "setup": "...", "check": "..." }
  }
}
```

Tags are free text the planner reads ("backend", "frontend", "tests"), never interpreted by code. `remote` lets setup clone missing repos, like `repo sync` or `mani sync`. Small, explicit, diffable, and shareable across a team as its own tiny repo.

**C. A prose `workspace.md` read by agents.** Flexible and readable, but the harness cannot reliably extract paths and commands for steps 2, 6 and 11, which are exactly the steps that must be deterministic.

B also can carry a free-text `notes` file or rely on `master/AGENTS.md` for the prose that C would hold.

## 6. Changes this implies for pi-extensions (for later, not now)

1. `run_agent` gains an optional `cwd` per item, limited to paths inside the declared workspace, so an agent can run in `workbench/<epic>/<repo>` and pick up that repo's context files and project config (subject to project trust).
2. A new extension or subagents plugin owning `/workspace setup` and `/epic new|worktrees|status|close`; worktree creation and cleanup are harness code, not agent shell commands.
3. The file-location rule gains one entry: the workspace file, the `workbench/<epic>/` folder and its worktrees, written on the user's command. Epic artefacts belong there rather than in the session dir because an epic spans many sessions and the user and PR reviewers read them; session-dir copies would be lost on a new session.
4. `worktree: true` stays as is for intra-repo parallelism; inside an epic worktree it branches off the epic branch HEAD, which is what is wanted.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Lockfile and dependency drift**: two agents or a rebase change lockfiles; shared `node_modules` breaks | Per-worktree install via the repo's `setup`; never symlink dependency or build dirs; only the repo's own agent touches its lockfile; conflicts in lockfiles resolved by regenerating, not by hand |
| **Stale master**: requirements read old code | Fast-forward before exploring; record shas in `requirements.md`; revalidate on drift instead of rewriting |
| **Long-running epic branches**: conflicts grow, other teams change the contract | Contract changes additive first; rebase worktrees on user command at stage boundaries; keep epics short and land the producer early behind a flag |
| **Contract divergence between agents** | Single `contract/` folder is the only source; agents told to stop and report rather than change it; main session broadcasts changes |
| **Secrets**: `.env` files copied into worktrees, agents reading or committing them | Setup copies or links only listed files; worktree `.gitignore` already excludes them; reviewer step checks diffs for secrets; never copy secrets into the epic folder |
| **Dirty or detached master** used as a base | Harness refuses to fetch/branch when a master checkout is dirty or off default; masters are read-only to agents by instruction and by placement (agents' cwd never under `master/`) |
| **Leftover worktrees and branches** | `/epic status` lists `git worktree list` per repo; `/epic close` removes without force and reports what it kept, as `worktree: true` does today |
| **Shared hooks** fire in every worktree | Document; per-repo `setup` handles hook tools; no harness hook installation |
| **Integration needs running services** | Optional `run` command per repo in the workspace file; otherwise integration testing is left to CI and reported as not run |

## 8. Open questions for the owner

1. Is one workspace per machine enough, or do you need several (different products or clients)?
2. Should the workspace file live at `<root>` as its own small git repo shareable with the team, or stay personal?
3. Who opens PRs: the harness via the forge CLI, or the user? Is a draft-PR-first policy wanted?
4. Do frontends consume the backend contract through a generated client or package that must be published first (adds a stage), or through a spec file copied into each repo?
5. Can the test-automation repo run locally against locally started services, or only against a shared environment?
6. Should exploration of several masters be one explorer agent or one per repo (cost vs. coverage)?
7. Is it acceptable to extend the file-location rule with the workbench folder, or should epic artefacts live in the session dir and be copied out on demand?
8. When master moves mid-epic: rebase automatically at stage boundaries, or only on command?
