# Worktrees for agents

> Status: open, to be decided. Date: 2026-11-10. A thinking document. It sets up a decision and makes none. The owner's words: "I need to think how exactly I'd want to use such a thing". Part of [workflow-mechanics](README.md); the cwd plan is [cwd/spec.md](cwd/spec.md).

## 1. What exists today

One switch: `worktree: true` in an agent `.md` file. The `run_agent` call cannot set it, and neither can `.pi/pi-subagents.json`. No shipped agent uses it; the shipped chores and the reviewer say `worktree: false`. Code: `extensions/subagents/core/run-agent/worktree.ts` and `placement.ts`; tests in `extensions/subagents/tests/plugins/run-agent/worktree.test.ts`; behaviour in the [Worktrees section of the subagents ARCHITECTURE.md](../../extensions/subagents/ARCHITECTURE.md#worktrees).

- You write an agent file with `worktree: true` and the main session starts that agent. This happens: git makes the branch `pi-agents/<agent id>-<stamp>` and a checkout at `<session cwd>/.pi/worktrees/<agent id>-<stamp>` from the HEAD commit. The agent runs there, in the same subfolder the session cwd is in.
- You have uncommitted edits and start such an agent. This happens: the agent does not see them. It sees the last commit.
- The agent finishes without changing anything. This happens: the checkout and the branch are removed. The result says `Worktree: removed`.
- The agent commits. This happens: the checkout is removed and the branch is kept. The result says `Worktree: removed; branch pi-agents/… kept`. Nothing is merged into your branch.
- The agent leaves uncommitted edits. This happens: checkout and branch are kept. The result says `Worktree: kept: <path> (branch …)`.
- pi is killed while the agent runs. This happens: checkout and branch stay. Nothing removes them later: no sweep at session start, no `git worktree prune`.
- The agent runs out of context and hands off. This happens: the successor works in the same checkout.
- You start pi in a folder that is not a repository. This happens: the agent fails with `worktree failed: …`.
- You start pi in `packages/app` of a repository. This happens: the checkout lands in `packages/app/.pi/worktrees/`, not at the repository root, and the agent runs in `packages/app` inside it.

## 2. What is unclear or weak

- **Results never come back on their own.** No merge, no cherry-pick, no diff. The main session gets one line with a branch name or a path. Bringing the work over is the user's job, with git.
- **The agent does not see uncommitted work.** The base is HEAD. If the user has been editing for an hour, the agent works on the code as it was before.
- **Leftovers pile up.** Kept checkouts stay under `.pi/worktrees/`, kept branches under `pi-agents/`. A hard kill leaves both. Nothing lists or removes them.
- **The switch lives only in the agent file.** A role is either always isolated or never. The main session cannot say "this one task needs its own checkout".
- **Nested agents do not follow their caller.** Placement always uses the main session's cwd (`runner.ts` passes `session.cwd`). A worktree agent's nested worktree agent starts from the main checkout's HEAD, not from its caller's checkout. A plain scout it starts runs in the main checkout, so it cannot see the caller's changes. Both are read from the code; no test covers them.
- **The checkout lacks what git does not track.** Submodules are empty. Ignored files such as `node_modules` and `.env` are missing, so an implementer cannot run the checks without installing first.
- **The checkout sits inside the main working tree.** It is gitignored, but tools that do not read `.gitignore` see a second copy of the repository. Context files load from the agent's cwd and its parents ([harness-side.md item 3](../enterprise-workflow/harness/harness-side.md#item-3-cwd)), so the agent probably gets the main checkout's `AGENTS.md` as well as its own copy (inferred, untested).
- **The main session is told almost nothing.** It learns the outcome line, not which files changed, how many commits there are, or whether the branch still applies to the current HEAD. The main-session prompt never mentions worktrees; its only collision rule is "never two editing agents on the same files".

## 3. Use cases to choose between

Each case says what it needs from the mechanics, what today gives, and what is missing. They are not exclusive, but each one pulls the design a different way.

**A. Parallel implementers on one repository.** You ask for three independent changes and want them done at once without the agents overwriting each other. Needs: one checkout per agent from the same base, dependencies installed in each, results as branches or patches, and someone to merge them in an order. Today: separate checkouts, and a branch kept when the agent commits. Missing: the switch per call, installing dependencies, telling the agent to commit, any way to combine the results, and scouts that look at the right checkout.

**B. A risky experiment you may throw away.** You ask an agent to try a large refactor and decide afterwards. Needs: isolation, a diff to judge, a one-step keep and a one-step discard. Today: isolation, and the branch or checkout is kept. Missing: the diff, and both keep and discard are manual git.

**C. A long-running agent while you keep editing.** You start an agent on a slow task and go on working in the same repository. Needs: neither side sees the other's half-done edits; at the end the agent's work lands on a checkout that has moved. Today: isolation works. Missing: your uncommitted edits at launch are absent from the agent's base, and nothing rebases or merges the result onto where you are now. Conflicts are left to you.

**D. A reviewer or verifier on a clean checkout of a given commit.** You ask for a review of a PR branch or of the commit before last, while your checkout holds other work. Needs: a base the caller names, no edits, removal at the end, dependencies for running checks. Today: the base is always HEAD, and the shipped reviewer and verifier do not use worktrees. Missing: choosing the base, and the install step.

**E. One agent per repository in a multi-repository folder.** You start pi in a folder that holds `be/` and `fe/` repositories and want one agent in each. Needs: `cwd` per `run_agent` item, and a worktree, if any, built from the repository at that `cwd`. Today: there is no `cwd`; a worktree agent in a folder that is not a repository fails. The [cwd spec](cwd/spec.md) plans `cwd` below the session cwd and a worktree from the target's repository. Missing: `cwd` itself, and the decision whether `cwd` may leave the session cwd.

**F. A main session that itself runs in a worktree.** You make a worktree by hand, or a tool makes one, and start pi in it. Needs: agents branch from that checkout, branch names do not collide with other sessions on the same repository, leftovers stay findable. Today: probably works. `git worktree add` from a linked worktree registers in the shared git dir, and the stamp keeps branch names apart (inferred, untested). Missing: little; cleanup is as weak as anywhere. This case is also the alternative to per-agent worktrees: one pi session per worktree, isolation managed by the user.

**G. No worktrees at all: agents share the checkout and take turns.** Editing agents run one after another; read-only agents run in parallel. Needs: the prompt rule, which exists. Today: this is the default. Missing: nothing, except that two agents can never edit the same files at once and nothing enforces the rule beyond the prompt.

## 4. Design questions

Options and trade-offs, no choice made.

**Who turns it on.**
- Agent file only (today): a role decides once; the main session needs no judgement and cannot get it wrong. A role cannot be isolated for one task only.
- Call argument: the main session decides per task, which fits A to D. The prompt has to say when, and a model may ask for a checkout it does not need; each one costs a checkout and an install.
- Both: the file gives a default and the call overrides it. Most flexible, most surface to document and test. A settings override, the way models are overridden, is a variant of this.

**Base.**
- HEAD (today): simple and reproducible. Misses uncommitted work.
- HEAD plus uncommitted changes, for example from `git stash create`: the agent sees what you see. Untracked files need a separate decision, and the two copies diverge from the start, so bringing the result back is a three-way merge against your own edits.
- A named commit or branch: needed for D. The caller has to know the name, and an unknown ref must fail cleanly.
- The caller's worktree: the natural base for nested agents. Only committed state transfers unless the uncommitted option is taken too.

**How results come back.**
- Text only (today): no surprises. The user does all the git work.
- Branch name plus a summary (commit list, diff stat) in the result: cheap. The main session can decide and tell the user what to run.
- The diff in the result, or a patch file in the session dir: the main session can read and apply it. Large diffs hit the inline result limit, and a patch may not apply to a moved checkout.
- Automatic merge or cherry-pick into the current branch: no manual step. It touches your checkout without asking, conflicts with your edits, and needs an order when several agents finish together. Hard to undo.

Whichever is chosen, the agent has to commit for most of these to work. That is a rule in the agent body (the [implementer-agent](../implementer-agent/README.md) plan does this on the Claude Code side) or something the harness does for it at the end.

**Who cleans up, and when.**
- At the end (today): handles the clean cases. Leaves the rest.
- At session start, a sweep of `pi-agents/*` with no live agent: catches hard kills. It must not delete work the user still wants, so it needs to know which entries it owns, for example from the agent manifests.
- A command, for example under `/agents`, that lists checkouts and branches and removes on request: the user stays in control. Nothing happens unless asked.
- Never, documented: the user runs `git worktree prune` and `git branch -D`. Honest and cheap; the leftovers stay.

**Where the checkout lives.**
- `<cwd>/.pi/worktrees/` (today): inside the folder the launcher mounts, matches the AGENTS.md file rule. One folder per subfolder the session starts in, and a second copy of the code inside the working tree.
- `<repository root>/.pi/worktrees/`: one place per repository, still inside the mount. The AGENTS.md file rule changes wording.
- Outside the repository, for example beside it or under pi's agent dir: the main working tree stays clean. Invisible in the sandbox, and the AGENTS.md file rule needs a new exception.

**Interplay with `cwd`.** The [cwd spec](cwd/spec.md) builds the worktree from the repository at the target, under `<target>/.pi/worktrees/`. [harness-side.md](../enterprise-workflow/harness/harness-side.md#4-open-decisions-for-the-owner), open decision 5, offers refusing the combination in a first version. Further questions: is `cwd` resolved inside the caller's worktree when the caller has one; and if `cwd` may leave the session cwd, the worktree goes with it into a repository the session was not started in.

**Interplay with the sandbox.** The launcher (`launcher/`) runs the whole session in a container with the repository mounted at its host path. The owner decided to change nothing in the launcher for now. What follows is inferred and untested:
- `git worktree add` inside the sandbox works, and the result is valid on the host, because paths match.
- A worktree created during a session is not protected by the launcher. One that exists at the next launch is, and then its entry probably cannot be removed from inside the sandbox, because its pointer files are bind mounts. A cleanup that runs inside the sandbox fails on those.
- An agent `cwd` outside the mounted folder does not exist inside the sandbox.
- Known and accepted: a worktree checkout outside the mounted folder is invisible in the container, so `git worktree prune` from inside would treat it as stale. The owner considers outside worktrees out of scope.

**Whether to drop the feature.** Nothing shipped uses it, the prompt already keeps editing agents apart, and case F gives isolation without it. Dropping it removes `worktree.ts`, the placement branch, the cleanup wait in the runner, the 21 cases of `worktree.test.ts` and a live test, and closes every question above but the `cwd` ones. It gives up A to D inside one session.

## 5. What the owner needs to answer

1. Which of the cases A to G should work, and which may stay unsupported? If the answer is only F and G, dropping the feature becomes an option.
2. Who turns a worktree on: the agent file, the `run_agent` call, or both?
3. What does the agent start from: HEAD, HEAD plus your uncommitted changes, a commit the caller names, or its caller's checkout?
4. How does the work come back: a text line as today, a branch with a summary, a diff or patch, or an automatic merge into your checkout?
5. Who removes leftovers, and when: only at the end, a sweep at session start, a command you run, or you with git?
6. May an agent's `cwd`, with or without a worktree, point outside the session cwd?
