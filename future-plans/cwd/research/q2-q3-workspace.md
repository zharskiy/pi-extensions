# Workspace and work items, revised to the owner's model (Q2, Q3)

Sources read: `future-plans/04-workspace-and-epic.md`, `00-overview.md`, the epic parts of `01-workflows.md`, `research/workspace-and-epic.md`, and `extensions/subagents/src/plugins/run-agent/{worktree,placement,runner,tools}.ts`.

## 1. What a workbench physically is

In the owner's model a workbench is **one folder per department** (FE, BE, QAA) that holds **one ordinary clone of each repo that department owns**. All work items share it; nothing is copied per item. So each repo exists exactly once on disk, and it has one working tree.

A git repo with one working tree can have only one branch checked out at a time. Worktrees exist so that several branches of the same repo can be checked out side by side. Without worktrees, two items that touch the same repo cannot both be checked out. You move between them by switching branches, and that needs a clean tree. Concurrent items in one repo are therefore impossible, only sequential ones.

The owner's point only works if **one developer works on one item at a time**. What it costs:

| Lost | Matters for one developer? |
|---|---|
| Two items in flight in the same repo, e.g. a hotfix during a big item | Sometimes. The developer commits WIP and switches. |
| A pristine `master/` reference while editing | Only during requirements for a new item while another item's branch is checked out. Rule: requirements run against the default branch; harness warns when a repo sits on another item's branch. |
| Two pi sessions working on two items that share a repo | Yes. Rule it out: one active item per repo. |
| Parallel implementers inside one repo | No. Existing `worktree: true` still works, branching off the item's branch (worktree.ts:37-62, placement.ts:31-47). |

Gained: no per-item `setup`, warm `node_modules` and build caches, IDE shows agents' edits directly, half the disk, one trust decision per repo.

## 2. Revised layout

```
<root>/
  pi-workspace.json
  .agents/skills/code-map/
  workbench/
    be/
      AGENTS.md                  optional, parent context file for every BE repo
      service-api/               ordinary clone
    fe/
      web-shell/
      web-orders/
    qaa/
      e2e-tests/
  changes/
    discount-v2/                 cwd of the item's main session
      change.md                  manifest (frontmatter) + status log, PR links
      requirements.md
      contract/                  optional for a single-repo change
      plan.md                    tasks per repo, merge order
    fix-rounding/
      change.md
      plan.md
```

Pi loads context files from the cwd and its parents, so `workbench/fe/AGENTS.md` applies to every FE repo.

**Masters are not needed.** The default branch on the remote is the reference. `/change new` runs `git fetch` in each repo and records `origin/<default>` as the base sha. "Master moved" detection becomes `git log <base>..origin/<default>`.

### `pi-workspace.json`

```json
{
  "workbench": "workbench",
  "changes": "changes",
  "branchPrefix": "change/",
  "trusted": true,
  "departments": {
    "be":  { "skills": ["backend-conventions"],
             "repos": { "service-api": { "remote": "git@host:org/service-api.git", "default": "main", "setup": "./gradlew assemble", "check": "./gradlew test" } } },
    "fe":  { "skills": ["frontend-conventions"],
             "repos": { "web-shell":  { "remote": "…", "default": "main", "setup": "npm ci", "check": "npm run check" },
                        "web-orders": { "remote": "…", "default": "main", "setup": "npm ci", "check": "npm run check" } } },
    "qaa": { "skills": ["qa-framework"],
             "repos": { "e2e-tests": { "remote": "…", "default": "main", "check": "npm run lint && npm run e2e -- --list" } } }
  }
}
```

- Repo names unique across departments.
- Departments replace free-text `tags`; optional `skills` list for agents whose cwd is in that department.
- `setup` becomes "after a branch switch, when the lockfile changed", or is dropped.

### Manifest (`changes/<name>/change.md` frontmatter)

```yaml
name: discount-v2
branch: change/discount-v2
ticket: PROJ-123
repos:
  be/service-api: { base: 3f2a1c9 }
  fe/web-orders:  { base: 8e01b44 }
  qaa/e2e-tests:  { base: c77d012 }
status: implementing
```

## 3. Naming

Not "epic" (implies large, split into stories) and not "story" (implies small, user-facing, one team; clashes with the tracker). **Recommendation: "change"**: `changes/<name>/`, `/change new|status|close`, workflow `change`, branch prefix `change/`. Size-neutral, names what comes out, prior art in OpenSpec. Tracker key goes in `ticket:`.

## 4. `cwd` on `run_agent`

`SpawnSpec.cwd` already exists (core/adapter/contract.ts:333); `run_agent` items have no `cwd` today (tools.ts:146-175).

- Values: `"<repo>"` or `"<dept>/<repo>"` resolves to `workbench/<dept>/<repo>`. `"<dept>"` only for read-only agents. Absolute paths only under `workbench/` or the change folder.
- Only repos in the manifest for editing agents.
- Branch on first use, by harness code: already on branch, run; branch exists and clean, `git switch`; missing and clean, `git switch -c <branch> <base>`; dirty or on another change's branch, refuse. Never auto-stash. After return, check HEAD is still on the change branch.
- "`master/` is read-only" becomes a stage rule: requirements and contract/plan run read-only.
- Parallel implementers in one repo use `worktree: true`.

## 5. Flow without integration

| Step | Who | Where | Artefact | Gate |
|---|---|---|---|---|
| 1 new | `/change new <name>` | each repo: `git fetch`, refuse if dirty | `change.md` | none |
| 2 requirements | main, read-only, one scout per repo | checkouts on default | `requirements.md` | user |
| 3 contract and plan | planner, read-only | | `contract/` (optional), `plan.md` with per-repo tasks and merge order | user |
| 4 implement | one implementer per repo, parallel, `cwd: <repo>` | each checkout on `change/<name>` | `implement.md` per repo | verifier per repo, retries 1 |
| 5 review | one reviewer per repo, diff `<base>...<branch>` | | `review.md` per repo | user |
| 6 pull requests | main + `shell` chore | | PR links in `change.md`; bodies link the others and state merge order | user |
| 7 CI (optional, future) | | | CI result in `change.md` | user |
| 8 close | `/change close` | | status `closed`; switch back to default when clean; branches kept | user |

Verifier per repo: `check` exits 0; implementer's `Verification:` matches what was re-run; diff stays in that repo and task; code conforms to contract as far as static reading shows. For `e2e-tests`: compile, lint, dry-run listing, never a run against an environment.

`e2e-tests` is just another QAA repo; its implementer writes autotests from acceptance criteria and the contract. PR usually last in merge order.

CI later: optional `ci` stage, either (a) per-repo `"ci": { "trigger", "status" }` shell commands run by the `shell` chore, or (b) a user gate "paste the CI link and result". (b) ships now at zero cost.

## 6. Removed or changed in spec 04

- `master/`, fast-forward, `"master"` key, "path under `master/` for read-only agents".
- Per-change worktrees, worktree-on-first-use, `setup` once per worktree, disk-growth risk.
- `/epic close` removing worktrees.
- Step 5 integration, `integration.md`, open question 1, overview open question 3.
- `tags` replaced by `departments`.
- The term "epic".
- Kept: `worktree: true`, `pi-workspace.json`, trust flag, contract-first, one PR per repo with merge order, code map.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Developer switches branch while agents run | Branch checked at spawn and after return; mismatch reported |
| Dirty tree blocks a switch | Refuse with file list; never auto-stash |
| Stale dependencies after a switch | `setup` after switch when lockfile differs |
| Requirements read the wrong branch | Refuse when a repo is on another change's branch |
| Two sessions, two changes, one repo | One active change per repo, recorded in `change.md` |
| No integration signal before merge | Merge order in PR bodies, tests repo last, optional CI gate |
| Contract drift | Implementers never edit `contract/` |

## 8. Open questions for the owner

1. Is one change per repo at a time a hard rule? Opt-in `isolated: true` falling back to worktrees later?
2. Is "change" acceptable? Does the company impose branch naming (ticket keys)?
3. Should departments carry more than a label (skills, reviewer agent, AGENTS.md)?
4. Who fills `workbench/`: user cloning by hand, or `/workspace init` cloning from `remote`?
5. Should `/change close` switch repos back to default?
6. Which local `check` is meaningful for the QAA repo?
7. Is the "paste the CI link" gate wanted now?
