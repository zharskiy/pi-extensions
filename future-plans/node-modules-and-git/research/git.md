# Where git runs and who owns `.git`

## Question

Today every repository's `.git` reaches the agent container through Apple's virtio-fs share, read-write, with the work tree. The owner says this seems problematic and asks: what if all git interactions are handled on the host, while the agent can still use git in the container? What are the options, what does the industry do, and what is the most logical and elegant solution?

Each claim below is marked: a URL (sourced), an experiment E1 to E8 on the Mac (tested here, see Experiments), a lab section on a Colima VM ("lab L2" and so on, in [lab-vm.md](lab-vm.md)), or "inferred". Facts about pinata come from [current-behaviour.md](current-behaviour.md) (CB) and [prior-attempts.md](prior-attempts.md) (PA).

## Short answer

1. **All git on the host, behind a shim: no.** Git's argv, environment and repository-selected hooks are a code-execution surface (six vectors in E6), the Mac's credentials become reachable, and tools that read `.git` without calling git break. No sandbox product forwards git argv to the host.
2. **What is problematic, in measured order.** (a) The `git status` walk over the work tree is the descriptor cost, not `.git`: one walk over 20,420 tracked files adds about 20,830 Mac descriptors whether `.git` is shared or private; the two differ by 11 (lab L3). (b) Two kernels on one index: while the Mac rewrites its index, the container reads it as empty and `commit -am` can commit the deletion of every file. It is real and frequent: 890 of 900 container reads were bad while a Mac loop rewrote the index continuously (lab L2). (c) Agent-writable config and hooks, which the Mac's git and IDE run; the threat model accepts this today (CB 52).
3. **The options** are A (keep the shared `.git`, harden or guard it), B and C (brokers to the Mac's git), D (a git dir private to the sandbox over the same live work tree), E (a separate clone) and F (make git cheap). One question decides between the two coherent ones, A and D: may the developer's git and the agent's git hold different state (HEAD, index) over the same live work tree?
4. **Industry standard** has two halves. For a work tree shared live (Dev Containers, Docker Sandboxes' direct mode): one shared `.git` with nothing added. For isolation (cloud agents, Docker Sandboxes' clone mode): a repository owned by the sandbox, with results crossing through git's transport. Local tools that protect `.git` (Claude Code's sandbox, Codex CLI) run on the host's own kernel and have no empty-index window.
5. **Most logical and elegant: D with an fsmonitor hook answered by a watcher on the Mac.** It removes the empty-index hazard and the walk, keeps the agent's writes out of the Mac's `.git`, and has the same shape as the `node_modules` answer: a VM-disk volume mounted over a folder each side keeps to itself, with only git's transport crossing. It works end to end on the VM (lab L2). Its price: a window in which the two HEADs or indexes disagree and the agent commits the revert of its own work (tested here), a host-side sync, per-repository volumes, a newer git than the image ships, and the reversal of commit `f7a62a98`.
6. **Order:** do not build a broker; build a container-side index guard now, because the hazard exists today; write D's spec next, starting from the HEAD policy and a tested answer to the stash and branch-switch case, and build D only after that.

## What is problematic about a shared `.git`

### Descriptors: the walk, not `.git`

Apple's share holds one Mac descriptor per inode the guest has cached (PA: 1.00 per inode). This Mac allows 61,440 per process (`kern.maxfilesperproc`, PA).

| What the guest touches | Mac descriptors | Source |
|---|---|---|
| `.git` of a 40,000-file repository after `git log -p`, unpacked / packed | 5,011 / 909 | PA |
| one cold `git status`, 20,420 tracked files, shared `.git` / private `.git` | +20,839 / +20,828, 1.8 s | lab L3 |
| the same, private `.git`, `core.untrackedCache` plus a stub fsmonitor hook | +7, 0.05 s | lab L3 |

`status`, `diff`, `add -A`, `checkout`, `stash` and `commit -a` lstat every tracked file and the untracked scan reads every folder. A work tree past about 60,000 tracked files and folders cannot be walked cold without approaching the limit, whoever owns `.git` (inferred from the 1.00 ratio; the real workspace's counts were never measured, PA). Only avoiding the walk removes this cost.

### Correctness: two gits on one index through the share

- When Mac git replaces a file in `.git` by rename (index, refs), the guest cannot read it for 440 to 500 ms. A missing index reads as empty: `git status` shows every file deleted and `git commit -am` committed the deletion of all 40,006 files without an error; 1 in 166 commits hit it against a Mac `git status` loop every 2 s (PA, attempt 1).
- The lab reproduced it under heavier load: a Mac loop of 400 iterations rewrote the index about 3 times each, in about 20 s (roughly 60 rewrites a second, inferred from those figures), and 890 of 900 container reads were bad: 825 an empty index, 62 an empty index with every file listed, 3 every file reported changed. Meanwhile 33 Mac commits failed on `index.lock`. A Mac-local reader on the same `.git` saw 0 bad reads, and with the Mac idle the container read all entries (lab L2). With rewrites every ~17 ms and a window of about half a second after each, the window never closes, which explains 97% against attempt 1's 1 in 166 (inferred). The real rate depends on how often the Mac writes its index: commits, staging, checkouts and IDE refreshes.
- Stat data differs between the macOS and Linux views, so each side rewrites all entries unless both set `core.checkStat=minimal` and `core.trustctime=false`; `core.untrackedCache`, `core.fsmonitor` and `feature.manyFiles` must stay off in shared config, because each side drops the other's index extensions (PA). `core.ignorecase` differs, decomposed Unicode names show as renames, and a guest clock behind the Mac hid same-second edits (PA).
- `git worktree prune` on the Mac deletes records of worktrees the Mac cannot see (PA).

Nothing pinata can set removes the window while one index is shared (PA). A guard can only detect it (design A2).

### Safety: code execution on the Mac

Git runs commands named in repository config and files in the git dir. A container that can write `<repo>/.git` decides what the Mac's git and IDEA run next.

| Vector | What runs | Source |
|---|---|---|
| `core.fsmonitor` | a command on every `status`, also in IDE background refreshes | `man git-config` 2.50.1; CVE-2022-24765 used it ([GitHub blog](https://github.blog/open-source/git/git-security-vulnerability-announced/)) |
| `core.sshCommand`, `core.pager`, `core.editor`, `diff.external`, `diff.<driver>.command`, `merge.<driver>.driver`, `filter.<driver>.clean/smudge/process`, `credential.helper`, `alias.*` with `!`, `include.path` | a command when that feature is used | `man git-config` 2.50.1 |
| `core.hooksPath`, `.git/hooks/*`, config-defined hooks (2.55) | hooks on commit, checkout, merge, rebase, push, ref updates | `man git-config`; E6; [2.55 release notes](https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.55.0.adoc) |
| `objects/info/alternates`, `commondir`, a `.git` file's `gitdir:` | redirect git to another repository inside the root | CB 54 |

Git honours some variables (`uploadpack.packObjectsHook`, `safe.directory`) only from protected configuration, "a safety measure against fetching from untrusted repositories" (`man git-config`). The class keeps producing CVEs: CVE-2022-24765, CVE-2024-32002 ([Red Hat](https://access.redhat.com/security/cve/CVE-2024-32002)), CVE-2025-48384, on CISA's exploited list ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-48384)).

Pinata accepts this risk on purpose. Commit `f7a62a98` (`feat(launcher)!: run every project from one shared workspace root`) removed the read-only binds over each repository's `hooks`, the git report after the session, and workspace mode's per-repository checks (at most 128 repositories), saying "Git validation and the read-only git protections are removed: the root holds the user's own repositories" (`git show f7a62a98`, its `REMOVED-DEFAULTS.md` rows "`.git/hooks` read-only inside: Writable" and "The git report … Gone"; CB 41). That was a trust and scale decision: one root of the user's own projects, no per-repository mounts.

Residual vectors outside `.git` survive every design that keeps the work tree live: husky sets `core.hooksPath` to `.husky/_` in the work tree, whose stubs run tracked scripts ([husky source](https://raw.githubusercontent.com/typicode/husky/main/index.js); E6), and build files, `.idea` run configurations, `package.json` scripts and planted nested repositories are agent-written code the Mac runs (CB 52).

## Lock errors

*Added 2026-11-27.* The owner sometimes sees a git lock error from the container. The exact message was not captured, so which lock and which command are unknown.

What is known:

- Locks are honoured across the two systems: `add`, `commit` and `checkout` take `index.lock` and fail at once while the other side holds it (PA). Lab L2's loop made 33 Mac commits fail on `index.lock`.
- A background `git status` takes the index lock to write refreshed stat data back, an optional step ([git-status, Background refresh](https://git-scm.com/docs/git-status#_background_refresh)).
- The stat mismatch between the macOS and Linux views makes each side rewrite the whole index (above; 40,000 files in 0.8 s on the Mac, 4 s in the container, PA), which holds the lock longer.

From the code, checked 2026-11-27 (grep, tests and build output excluded):

- Nothing in `launcher/`, `extensions/` or `platform/` sets `GIT_OPTIONAL_LOCKS`, `core.checkStat`, `core.trustctime`, `safe.directory`, `gc.auto` or `maintenance.*`. `core.fsmonitor` appears once, as `-c core.fsmonitor=false` on the host's own identity read (`launcher/hostpi/tools/git.ts:7`), never in the container.
- The host runs no git against the workspace: one `git config --global --includes --get-regexp '^user\.(name|email)$'` per launch (`launcher/hostpi/tools/git.ts:27-29`), which reads the global file only.
- In the container, the subagents extension runs per `worktree: true` agent `rev-parse HEAD --show-prefix` and `worktree add -b` at the start, and `worktree remove`, `rev-parse <branch>` and, when the branch still points at its base, `branch -D` at the end (`extensions/subagents/core/run-agent/worktree.ts:38`, `:55`, `:66`, `:72`, `:78`). Nothing serialises parallel agents: `placement.ts:35` calls it directly. The shipped agents all say `worktree: false` (CB 58), so this arises only with a user's agent.

Not researched:

- Stale lock files left by a killed git.
- Lock collisions between parallel subagents on refs, `packed-refs` or `config`; `worktree add -b` writes a branch ref and `.git/worktrees/<id>` (inferred, untested).
- Whether `git gc --auto` runs in the container and holds locks there.
- Which Mac tools run `status` with optional locks. IDEA sets `GIT_OPTIONAL_LOCKS=0` for itself since 2019.1 (PA); others were not checked.

### What each setting changes and costs

| Setting | What it changes | Cost |
|---|---|---|
| `GIT_OPTIONAL_LOCKS=0` | Read-only commands such as `status` no longer write refreshed stat data to the index, so they take no `index.lock`. | Files whose timestamps changed are compared again on every `status` until a real write refreshes the index. |
| `core.checkStat=minimal` | Only the size and the whole-second mtime are compared; inode, owner and sub-second times are ignored. | A same-size edit within the same second can be missed; attempt 1 saw it with the guest clock behind (PA). |
| `core.trustctime=false` | ctime is ignored. | None in practice. |

Sources: https://git-scm.com/docs/git (`GIT_OPTIONAL_LOCKS`), https://git-scm.com/docs/git-config (`core.checkStat`, `core.trustctime`), https://git-scm.com/docs/git-status (Background refresh). The owner decided on 2026-11-27 that pinata applies them through its commands, and a design is proposed, not agreed: see the [Decision](../README.md#decision) section of the README and [git-settings-proposal.md](../git-settings-proposal.md).

## What the industry does

| Who | Where git runs, what happens to `.git` | Source |
|---|---|---|
| VS Code Dev Containers | Live tree and `.git` bind-mounted; git runs in the container; nothing special for `.git`. Credentials forwarded by helper and SSH agent. For speed: a volume for `node_modules`, or "clone repository in container volume". | [credentials](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials), [performance](https://code.visualstudio.com/remote/advancedcontainers/improve-performance) |
| Docker Sandboxes | Direct: live host tree through a "filesystem passthrough" with virtiofs caching on by default, both sides run git, nothing special (see [below](#docker-sandboxes-direct-mode)). Clone: "a separate Git clone inside the sandbox", host repo readable at `/run/sandbox/source`, host fetches from a remote `sandbox-<name>` "through the daemon socket". Host worktrees: git on the host, the sandbox "can't commit, branch, or check status". Mountless: branches pushed to a remote. | [git workflows](https://docs.docker.com/ai/sandboxes/workflows/git.md) |
| Codex CLI | Host kernel, no share: `.git` "protected as read-only" in `workspace-write`. | [docs](https://learn.chatgpt.com/codex/agent-approvals-security) |
| Claude Code sandbox | Host kernel, no share: `.git/hooks` and `.git/config` write-denied, the rest writable. | [docs](https://code.claude.com/docs/en/sandboxing) |
| WSL users | A shell function calls `git.exe` for `/mnt` paths, for speed; the user is trusted. | [Windows-Dev-Performance#87](https://github.com/microsoft/Windows-Dev-Performance/issues/87), [wsl-git](https://pkg.go.dev/github.com/haitaow/wsl-git) |
| Flatpak IDEs | `flatpak-spawn --host git`; the permission lets an app "circumvent sandbox". | [flatpak-spawn(1)](https://man7.org/linux/man-pages/man1/flatpak-spawn.1.html), [gnome-software#704](https://gitlab.gnome.org/GNOME/gnome-software/issues/704) |
| container-use (Dagger) | A branch per environment, brought to the host repository by `log`, `diff`, `merge`, `apply`. | [README](https://github.com/dagger/container-use), [workflow](https://container-use.com/environment-workflow) |
| Sculptor, vibe-kanban, claude-squad | A worktree or branch per agent; no live view of uncommitted edits. | PA |
| Claude Code on the web, Cursor cloud agents | A clone in a cloud VM, results pushed as a branch; credentials stay outside the VM. | [Claude Code](https://code.claude.com/docs/en/claude-code-on-the-web), [Cursor](https://cursor.com/docs/cloud-agent) |
| Copilot coding agent | A cloud clone with git; it pushes only to its `copilot/` branch and "cannot directly run `git push`": a limit on push credentials and branches, not git on the host. | [docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations) |
| Scalar, VFS for Git, Sapling | Monorepo settings on normal git; nothing for two machines on one repository. | [scalar](https://git-scm.com/docs/scalar), [VFSForGit](https://github.com/microsoft/VFSForGit), [Sapling](https://sapling-scm.com/docs/introduction/) |

Gemini CLI, OpenHands and Conductor were not checked.

Nobody forwards an agent's git argv to the host; where git stays on the host (Docker host worktrees), the agent gets no git. Pinata's case, a live tree through a share between two kernels, matches the live-tree peers, which add nothing for `.git`; none of them combines the isolation pattern with a live work tree.

### Docker Sandboxes' direct mode

*Added 2026-11-27.* Read in the raw pages [architecture](https://docs.docker.com/ai/sandboxes/architecture/), [git workflows](https://docs.docker.com/ai/sandboxes/workflows/git/) and [troubleshooting](https://docs.docker.com/ai/sandboxes/troubleshooting/):

- Direct mode is a live mount: the directory "is mounted into the sandbox through a filesystem passthrough", and "changes in either direction are instant with no sync process involved" (architecture).
- "Virtiofs caching is enabled by default for directly mounted workspaces on all operating systems." (architecture)
- The only coordination advice: "Both you and the agent can use Git, so agree on who manages branches and commits. Switching branches from either side changes the files both sides see." (git workflows)
- Troubleshooting: "If you experience Git index corruption or unexpected file content, disable caching with the kill switch and recreate the sandbox", the switch being `DOCKER_SANDBOXES_ENABLE_VIRTIOFS_CACHE=0`.
- Nothing on `index.lock`, `GIT_OPTIONAL_LOCKS` or stat settings in the three pages.

Reported by a research agent through a summarising fetch, not checked against the raw pages: Docker's security pages advise reviewing `.git/hooks/` by hand and treating files the agent changed like an untrusted pull request; clone mode states that the agent cannot modify any byte under the host's `.git/`; Docker Desktop's bind-mount docs have no git guidance; Synchronized file shares list `.git` only as something one may exclude; VS Code Dev Containers copy the local `.gitconfig` and advise cloning into a volume for speed.

Not verified: issue trackers were searched, not read; the Sandboxes release notes before 0.51 were not read.

Conclusion: no product found ships protections for the shared mode. The industry's fix is the separate clone.

## Designs

### A. Shared `.git`, as today

**A1, hardened by binds.** Pinata binds `config`, `hooks`, `info` and `objects/info` read-only per repository. With `chflags uchg` standing in for a read-only bind (E3), `git remote add` and `git config` fail, and `branch --set-upstream-to`, `checkout --track` and `push -u` print "could not write config file" yet exit 0. The list is open-ended (`packed-refs`, `commondir`, `worktrees/*/config.worktree`, new keys). It needs binds per repository, keeps the window and the walk, and is what `f7a62a98` removed (CB 41).

**A2, guarded against the empty index.** Two container-only pieces, undesigned and untested:

- A `git` wrapper in the image, ahead of the real git on `PATH`. Before a verb that reads or writes the index, it checks whether `.git/index` is missing or has zero entries (the count in its header) while `HEAD^{tree}` is not empty; if so it retries for about a second (the window is 440 to 500 ms, PA) and then refuses. Limits: a gap between its check and git's own open, which a Mac writing continuously can hit (lab L2's loop would); tools that bypass it (JGit, libgit2, go-git, anything that runs `/usr/bin/git` by path).
- A container-only pre-commit check, installed by `core.hooksPath` through `GIT_CONFIG_COUNT`, that refuses a commit whose tree deletes every tracked file. Limits: it replaces a repository's own `core.hooksPath` (husky), so it must chain to it; `--no-verify` skips it; it does not catch a partial loss.

With them go attempt 1's container settings by `GIT_CONFIG_COUNT` (`core.checkStat=minimal`, `core.trustctime=false`, `core.ignorecase=false`, `GIT_OPTIONAL_LOCKS=0`, PA) and `safe.directory`, which pinata sets nowhere today (CB 49) and the lab needed (lab L2). The user's `env.set` can also set `GIT_CONFIG_COUNT` (CB 48), so the two must be merged (inferred).

*2026-11-27:* the proposal for the lock settings puts the two `core` keys in the rendered `~/.gitconfig` instead, to avoid that merge, and leaves `core.ignorecase` and `safe.directory` out ([git-settings-proposal.md](../git-settings-proposal.md)). It is not agreed.

A2 keeps one HEAD and one index, the property attempt 1 chose a single `.git` for (PA). It does nothing for the walk: an fsmonitor hook over the shared index is unmeasured and probably fights the Mac's git, which drops the index extension when it rewrites the index without the setting (inferred; PA rules fsmonitor out of shared config).

### B. Host-side git broker

A `git` in the container sends argv, cwd, stdio and the exit code to a Mac process that runs the real git in the Mac repository; `.git` is absent in the container.

For it: git runs natively with the Mac's fsmonitor daemon, so no guest walk; one index, one kernel.

Against it:

- Argv is code. Each of these created a file on the Mac (E6): `-c alias.st='!cmd'`, `-c core.fsmonitor=cmd`, `fetch --upload-pack=cmd`, `GIT_EXTERNAL_DIFF`, `log --output=<any path>`, and a plain `git commit` with husky's `core.hooksPath` running a work-tree script. Documented, untested here: `rebase --exec`, `bisect run`, `submodule foreach`, `difftool`, `GIT_SSH_COMMAND`. A denylist must follow every release; an allowlist is a narrow tool, not git.
- Hooks run on the Mac with the developer's rights, from the agent-written work tree. Turning them off also turns off the checks the agent relies on.
- `push` and `fetch` run with the Mac's keychain and SSH agent, so the agent can push anywhere (inferred).
- Interactive commands need an editor in the container while git runs on the Mac.
- JGit, libgit2 and go-git break without `.git` ([ZEPPELIN-4304](https://issues.apache.org/jira/browse/ZEPPELIN-4304)); tools that spawn git (nx, turbo, lint-staged) pay a round trip per call (inferred).

Rejected.

### C. Read-only `.git` plus a broker for writes

`commit`, `checkout`, `branch`, `stash`, `rebase`, `push` go to the broker. It inherits B's worst risks (`commit` runs hooks, `push` the credentials), and reads still see the empty-index window. Rejected.

### D. Sandbox-private git dir, Mac objects borrowed, results cross by transport

How it works (E1, E7, E8; lab L2):

1. At launch, for each repository, pinata creates a docker volume on the VM's disk and mounts it over `<repo>/.git` in the container. The Mac's whole git dir is bound read-only at a pinata path (`/host-git` in the lab); the lab chowned the volume to uid 1000 with `--cap-add CHOWN` (lab L2).
2. A setup step in the container: `git init`, `objects/info/alternates` pointing at `/host-git/objects`, `git fetch /host-git '+refs/heads/*:refs/remotes/host/*'` (copies no objects: E1, lab L2), HEAD set to the Mac's branch, `git reset --mixed` (work tree untouched). About 0.2 s for 3,020 files, 1.3 to 3.1 s for 20,420 (lab L2).
3. The agent runs real git in its own git dir; new objects land on the VM's disk.
4. A host step on the Mac fetches the sandbox's refs into `refs/pi/*` over a command transport, `ext::<script>` running `docker exec -i -u 1000 <c> git-upload-pack <path>`, with `protocol.ext.allow=always`, `fetch.fsckObjects=true`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`: 0.44 s for a two-file commit (lab L2).
5. If the Mac's branch is an ancestor of the fetched one and the Mac's index equals its HEAD, the host step fast-forwards the branch and runs `read-tree` plus `update-index --refresh`. In the lab both sides then showed a clean status, and the agent's files kept their content, mtime and inode (lab L2; E1, E8). Otherwise it leaves `refs/pi/<branch>` and says so.
6. When the developer commits on the Mac, the sandbox fetches `host/*` and replays its commits onto them without touching the work tree (E8). A real conflict exits 1 and is left to a human (E8).
7. Subagent worktrees are made in the sandbox git dir (lab L2: 722 ms for 3,021 files, commit works, the Mac's fetch brings `refs/pi/wt1`).

What IDEA sees: the same live files; agent commits appear after step 5; agent branches under `refs/pi/`.

Descriptors: `.git` moves off the share except for Mac objects read through alternates; the gain is 11 descriptors per walk (lab L3). D pays off on descriptors only with the hook: with `core.untrackedCache` and a hook that answered "nothing changed", a `git status` over 20,420 files cost +7 descriptors and 0.05 s against +20,828 and 1.8 s (lab L3; E4 on the Mac). The hook needs a watcher on the Mac, because guest inotify does not see Mac writes on virtio-fs ([virtio-fs list](https://listman.redhat.com/archives/virtio-fs/2021-January/002544.html)); container writes do raise FSEvents on the Mac, about 10 ms after the write (lab L4). The Mac's part ("what changed since this token") is the sound form of the owner's idea: the host does the watching, the container keeps a real git. A real watcher, its cookie barrier against a write just before `status`, and their race were not run (lab-vm.md, "Not run"). A hook at a path the container cannot see made git print "cannot exec" and fall back silently to the full walk (lab L3), so the setup must check it.

Correctness: each index has one writer on one kernel. With the private index the container read a good index 1,200 of 1,200 times under the loop that broke 890 of 900 shared reads, and the Mac saw no `index.lock` message (lab L2). While the Mac ran `repack -ad`, `gc`, `gc --aggressive` and incremental-repack maintenance in turn, 1,378 container iterations of `log -p -50`, a read of all 3,754 reachable objects and `status` had 0 failures (one printed "pack index unavailable" and still succeeded), and 100 of 100 `commit -am` succeeded (lab L2). `git fsck --connectivity-only` in the container failed often during the repack (498 of 847, mostly "multi-pack-index file exists, but failed to parse", against 55 of 954 Mac-local); part of that came from the loop itself, and fsck with the Mac idle passed (lab L2). So fsck through alternates is not a usable health check while the Mac maintains its repository.

Surprises from the lab (lab L2): virtio-fs reports ownership as whoever looked first, so git refused the repository as "dubious ownership" until `safe.directory` was set; the first commit after setup wrote 105 loose objects instead of about 6, unexplained.

#### The two-state window

D gives the work tree two HEADs and two indexes. Steps 5 and 6 cover only "one side is behind". They do not cover the Mac changing the work tree with git between the agent's commit and the sync. Tested here on 2.50.1, E8's setup: the agent commits `f1`; the Mac runs `git stash` (an IDE shelve, a rollback or a branch switch does the same to the work tree); the sandbox now shows ` M f1`, and its next `git commit -am` commits the revert of its own work. After a Mac `git checkout other`, the sandbox stays on `main` with the other branch's files showing as its own modifications. The review reproduced the same failure independently. The reverse also holds: a sandbox `checkout` rewrites the live files under IDEA while the Mac's HEAD stays put. This is attempt 1's objection to two indexes, that each side stages the other's commits as reverts (PA).

So the HEAD policy is part of D, not a follow-up. Candidates, all undesigned: "follow" (the host step moves the Mac's HEAD with the agent's, `symbolic-ref` plus `read-tree`, only when the Mac's index is clean); "review" (the Mac never moves; agent commits arrive as `refs/pi/*`); and in either, a rule against Mac-side work-tree git (stash, checkout, reset, IDE shelve) during a session, enforced or only documented. Whatever is chosen needs a sync triggered on every ref change on both sides, and a test of the stash and branch-switch cases.

#### Other hard parts

- **gc with alternates.** If the Mac deletes a branch and prunes, sandbox objects that point into it go missing (E7: "invalid sha1 pointer", "bad object topic"). Step 4 protects them, but as tested its refspec covers `refs/heads/*` only (E7, lab L2). It misses the sandbox's `refs/stash`, its remote-tracking refs, detached worktree HEADs and reflogs, which can all point at Mac objects. A fuller fetch (`+refs/*`) covers named refs; detached HEADs and reflogs need another answer (inferred). gc's two-week prune expiry narrows the window (inferred).
- **Mac refs through the share.** Setup and refreshes read the Mac's refs and `packed-refs` through `/host-git`, which the rename window also hits; a missing ref fails loudly (PA), a missing `packed-refs` would hide refs (inferred).
- **The image's git.** `launcher/image/Dockerfile` line 1 is `FROM node:24-bookworm-slim` and line 10 installs Debian 12's `git`, which is 2.39.5 (the package version; not run in the image). The lab image was alpine 3.24 with 2.54.1, so the lab's "new enough" verdict does not apply to pinata's image (lab-vm.md, Versions). `git replay` needs 2.44, is marked experimental (`man git-replay` 2.50.1: "THE BEHAVIOR MAY CHANGE"), and later releases changed its default from printing ref updates to applying them (review finding, not checked here), so E8's `replay | update-ref --stdin` depends on the version. Relative worktree paths need 2.48 (E5); the Linux fsmonitor daemon 2.55. Two ways out: ship a newer git in the image, or replay without `replay`: `merge-tree --write-tree --merge-base=<c>^ <onto> <c>` plus `commit-tree` per commit (tested here on 2.50.1: correct tree, exit 1 on a conflict; `--merge-base` needs 2.40, inferred), or on 2.39 `cherry-pick` in a scratch worktree on the volume (inferred).
- **Worktrees on the Mac.** A sandbox-made worktree's `.git` file points at `<repo>/.git/worktrees/<id>`, which on the Mac is the Mac's own git dir, so the Mac's `git status` there fails with "not a git repository" and the main repository shows `?? .pi/` (lab L2).
- **Combined with the `node_modules` design.** With a VM mount at the worktree's `node_modules`, `git worktree remove --force` fails with "Resource busy", rc 255, drops the worktree metadata anyway and leaves an orphaned folder (lab L2; node-modules.md). The subagents extension's `worktree remove` (CB 56) must therefore unmount first or be told how.
- Repositories created during a session and submodules are not covered (PA).

#### What D does and does not protect

Nothing the agent writes in a covered repository's git dir is read by the Mac's git. That is less than it sounds:

- A repository cloned or initialised in the container during a session gets an agent-written `.git` on the Mac, because only repositories known at launch get a volume.
- A nested `.git` planted anywhere in the tree is picked up by the IDE.
- A repository whose config was already changed under today's model stays changed.
- The host step forces off hooks and fsmonitor only; `include.path`, filters (`update-index --refresh` can run a clean filter on agent-written files) and other config still apply (inferred). The residual vectors outside `.git` remain.

D also reverses `f7a62a98` by bringing back per-repository mounts, and it adds a host-side step that runs git in the Mac repository, which attempt 1 refused to do because the sandbox could write `.git/config` (PA). Safety is therefore not the main reason for D; correctness (no empty index) and, with the hook, descriptors are.

Precedent: `git clone --shared` (alternates), Docker Sandboxes' clone mode, container-use, cloud agents.

### E. Separate clone in the VM

The agent works in a clone on the VM's disk. Safest and fastest, but IDEA sees the work only as fetched branches, which fails the live-work-tree constraint. Worth keeping as a mode.

### F. Make git cheap

- Scalar-style settings cannot be shared between two gits (PA); `skipHash` and split index are safe on 2.40 or later (PA).
- Git's Linux fsmonitor daemon (2.55, [release notes](https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.55.0.adoc)) uses guest inotify, which misses Mac writes on virtio-fs ([virtio-fs list](https://listman.redhat.com/archives/virtio-fs/2021-January/002544.html); lima's `mountInotify` is experimental, [lima docs](https://lima-vm.io/docs/config/mount/)): a wrong status, not a slow one.
- The hook protocol backed by a Mac watcher skips the walk (E4, lab L3). It needs an index no other git rewrites, hence D.
- Packing on the Mac cuts `.git` descriptors from 5,011 to 909 (PA).

F is not a design on its own; its hook is part of D.

## Experiments

On this Mac, `git version 2.50.1 (Apple Git-155)`, throwaway repositories in the session scratchpad (`git-lab/`), `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`. APFS on both sides; the share and Linux are covered by lab L2 to L4.

| # | What | Commands (abridged) | Result |
|---|---|---|---|
| E1 | Private git dir over a shared work tree, Mac objects read-only | `chmod -R a-w mac/.git/objects`; `git init --bare sbx.git`; alternates; `fetch mac '+refs/heads/*:refs/remotes/host/*'`; `reset --mixed`; `commit -am` with `--git-dir=sbx.git --work-tree=mac` | fetch copied 0 objects; sandbox commit wrote 3 loose objects in its own dir; after the Mac's fetch, `update-ref`, `read-tree`, `update-index --refresh`: Mac status empty, HEAD at the agent commit |
| E2 | Transport | `GIT_SSH_COMMAND=<local runner> git -c fetch.fsckObjects=true fetch ssh://sandbox/<path>`; `ext::`; sandbox repo with `core.fsmonitor`, `core.pager`, `post-checkout`, `reference-transaction` that touch a file | command transport works; `ext::` refused unless `protocol.ext.allow=always`; nothing touched. This only confirms that a remote's config never runs on the fetching side, which is git's design; it says nothing about the Mac repository's own config |
| E3 | Read-only config | `chflags uchg .git/config`, then each command | commit, checkout, stash, rebase, worktree add, push, fetch, gc work; `remote add`, `config` fail; `--set-upstream-to`, `--track`, `push -u` print an error and exit 0 |
| E4 | fsmonitor hook skips stats | 20,000 files; hook v2 printing a token and `$FSM_CHANGED`, `core.untrackedCache=true` | status empty until the hook reported the paths; trace2 `apply_count:0` |
| E5 | Relative worktree paths | `git worktree add --relative-paths …`; move the repository | worktree works after the move |
| E6 | Broker argv surface | `-c alias.st='!touch …'`; `-c core.fsmonitor=…`; `log --output=<path>`; `fetch --upload-pack=…`; `GIT_EXTERNAL_DIFF`; husky-style `core.hooksPath` | all six created their file |
| E7 | gc with alternates | sandbox fetches Mac branch `topic`; Mac `branch -D topic`, `reflog expire --expire=now --all`, `gc --prune=now` | sandbox `fsck`: "invalid sha1 pointer"; with the Mac's `fetch sbx '+refs/heads/*:refs/pi/*'` first: intact |
| E8 | Concurrent commits, one work tree | agent commits `f1` in sbx, user commits `f2` on the Mac, each with a pathspec; sandbox `fetch`, `git replay --onto host/main main~1..main \| update-ref --stdin`, `read-tree`; Mac guarded fast-forward | each side first saw the other's commit as ` M`; after replay both clean, work tree byte-identical, graph `B, U, A`; both commit `f3` differently: `replay` exit 1. The pathspec commits on disjoint files avoid the realistic `commit -am`, which would have committed the other side's change as a revert (see "The two-state window") |

## Fit for pinata

### Ranking

| Rank | Design | Role | Reason |
|---|---|---|---|
| 1 | D with the fsmonitor hook | target; spec next, build after the HEAD policy is tested | Removes the empty-index hazard (lab L2) and the walk (lab L3), keeps agent writes out of the Mac's `.git`, full git in the container; same shape as the `node_modules` answer. Price: the two-state window, a host sync, per-repository volumes, a newer git, reversing `f7a62a98`. |
| 2 | A2, shared `.git` with an index guard | build now | The only arrangement with one HEAD and one index. Cheap and container-only; detects the empty index but cannot remove it; nothing for the walk. Undesigned and untested. |
| 3 | D without the hook | not on its own | All of D's price for the correctness gain only; 11 descriptors (lab L3). |
| 4 | E, clone in the VM | optional mode | Best isolation and speed; no live work tree. |
| 5 | A1, read-only binds | no | Open-ended list, silent config failures, keeps the window and the walk, reverses `f7a62a98` for little. |
| 6 | C, read-only plus write broker | no | B's risks on the verbs that matter. |
| 7 | B, full host broker | no | Moves code execution from config to argv, exposes Mac credentials, breaks `.git` readers. |

### Conclusion

"All git on the host" behind a shim stays rejected (E6, B). The problems, in measured order, are the walk (descriptors), the empty-index hazard of a shared `.git` (real and frequent while the Mac writes its index), and agent-writable config and hooks (accepted by the threat model today).

There are two coherent arrangements, and the deciding question is whether the developer's git and the agent's git may hold different state over the same live work tree. If not, one shared `.git` (today) is the only answer, made safer by A2's guard, with the walk left as it is. If so, D with the hook is the more logical and elegant target: each side owns its git dir, only git's transport crosses, and the shape matches `node_modules`.

Recommended order:

1. Do not build the broker.
2. Build the index guard (A2) now, with attempt 1's container-only settings and `safe.directory`, because the hazard exists today whatever is decided later.
3. Treat D with the hook as the target and write its spec next, starting from the HEAD policy and a tested answer to the stash and branch-switch case. Do not build D before that.

*Owner's decision, 2026-11-27:* the settings that reduce lock collisions are to be applied and removed by pinata through its commands, globally on the Mac; nothing else is decided for git. See the [Decision](../README.md#decision) section of the README.

*Recommendation, 2026-11-27, not an owner decision:* given the recorded end state of the code in the VM, git would move with it. A clone on the VM's disk with results fetched as branches (E) becomes the end state rather than an optional mode, and neither the index guard (A2) nor D is worth building in the interim. Until then one risk remains: a real Mac-side write at the same moment as an agent commit can still produce the commit that deletes every file. `git commit` does not touch the work tree, so that commit can be undone. The ranking above stays as the record of what was found.

### What D changes in the launcher

- Discovery lists repositories under the root (lstat only, as attempt 1 proposed) and creates per repository a volume over `.git`, a read-only bind of the Mac's git dir, and a root exec to chown the volume. Volume subpaths (Docker 26 or later; pinata requires 28, CB 64) could make it one volume (inferred, not tried).
- A setup exec per repository at start (lab L2's script), with `safe.directory`, the hook, and a check that the hook is reachable.
- A host-side sync: fetch into `refs/pi/*` with a refspec wider than `refs/heads/*`, the HEAD policy, guarded fast-forward, notice on divergence, triggered by ref changes on both sides. New host code that runs git and writes refs and the index in the user's repositories, so `THREAT-MODEL.md` and "Files written" change.
- A Mac watcher behind the hook, with a cookie barrier.
- A git in the image of 2.44 or later, or a replay step without `git replay`.
- The subagents extension's worktree removal must unmount a mounted `node_modules` first (lab L2).

### Costs and what breaks

- A volume, a bind and a setup exec per repository, dozens of repositories, at every launch (0.2 to 3.1 s each, lab L2).
- Agent commits reach IDEA after a delay; divergence leaves a `refs/pi/` branch; objects not yet fetched are lost with the VM (`pinata restart`).
- The Mac and the agent no longer share stash, branches, config or the index. Mac-side work-tree git during a session is unsafe until the HEAD policy handles it.
- Repositories created or renamed during a session, submodules and Mac-made linked worktrees are not covered at first; sandbox-made worktrees do not work from the Mac (lab L2).

### Decisions for the owner

1. Whether the two gits may hold different state over one live work tree (A2 or D).
2. For D: the HEAD policy ("follow" or "review", with or without a rule against Mac-side work-tree git).
3. Alternates over the share against a one-time copy of the objects to the VM's disk (no share reads, no gc coupling; copy time and disk per `restart`).
4. A newer git in the image against a replay step that works on 2.39.

## Not verified

| Claim | Check |
|---|---|
| A2's wrapper and pre-commit check catch the empty index | Lab L2's shared-`.git` loop with the guard in place: count refused, retried and bad commands. |
| D's HEAD policy handles stash, shelve, rollback and branch switch on the Mac | Script each between an agent commit and the sync; the agent's next `commit -am` must not revert. |
| A real Mac watcher behind the hook is correct | FSEvents watcher answering the hook; write-then-status race with a cookie file, 1,000 tries (lab-vm.md, "Not run"). |
| A fuller refspec protects stash, remote-tracking refs, detached HEADs, reflogs from the Mac's gc | E7 with each kind of ref. |
| The 105 loose objects after the first commit | Repeat lab L2's first commit with `GIT_TRACE2_PERF`. |
| Fetch speed after a large agent commit | `time` the lab L2 fetch after a 3,000-file commit. |
| The replay step on pinata's image git | Run E8 with `merge-tree` or `cherry-pick` on 2.39.5. |
| IDEA's behaviour | IDEA open while the sync fast-forwards and rewrites the index: prompts, `index.lock` errors. |
| The real counts | `git ls-files \| wc -l`, `find .git -type f \| wc -l` per repository on the failing machine (PA). |

## Sources

- git-config, git 2.50.1 man page, local (`man git-config`); https://git-scm.com/docs/git-config
- git-replay, git 2.50.1 man page, local (`man git-replay`)
- git fsmonitor daemon: https://git-scm.com/docs/git-fsmonitor--daemon
- Git 2.55 release notes: https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.55.0.adoc
- Scalar: https://git-scm.com/docs/scalar
- CVE-2022-24765: https://github.blog/open-source/git/git-security-vulnerability-announced/
- CVE-2024-32002: https://access.redhat.com/security/cve/CVE-2024-32002, https://security-tracker.debian.org/CVE-2024-32002
- CVE-2025-48384: https://nvd.nist.gov/vuln/detail/CVE-2025-48384, https://dgl.cx/2025/07/git-clone-submodule-cve-2025-48384
- Codex sandbox: https://learn.chatgpt.com/codex/agent-approvals-security
- Claude Code sandbox: https://code.claude.com/docs/en/sandboxing
- Claude Code cloud sessions: https://code.claude.com/docs/en/claude-code-on-the-web
- Docker Sandboxes git: https://docs.docker.com/ai/sandboxes/workflows/git.md, https://docs.docker.com/ai/sandboxes/workflows/git/
- Docker Sandboxes architecture and troubleshooting: https://docs.docker.com/ai/sandboxes/architecture/, https://docs.docker.com/ai/sandboxes/troubleshooting/
- git and git-status (`GIT_OPTIONAL_LOCKS`, background refresh): https://git-scm.com/docs/git, https://git-scm.com/docs/git-status
- container-use: https://github.com/dagger/container-use, https://container-use.com/environment-workflow
- VS Code Dev Containers: https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials, https://code.visualstudio.com/remote/advancedcontainers/improve-performance
- WSL git: https://github.com/microsoft/Windows-Dev-Performance/issues/87, https://pkg.go.dev/github.com/haitaow/wsl-git
- Flatpak: https://man7.org/linux/man-pages/man1/flatpak-spawn.1.html, https://gitlab.gnome.org/GNOME/gnome-software/issues/704
- Cursor cloud agents: https://cursor.com/docs/cloud-agent
- Copilot coding agent: https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations
- VFS for Git: https://github.com/microsoft/VFSForGit
- Sapling: https://sapling-scm.com/docs/introduction/
- husky: https://raw.githubusercontent.com/typicode/husky/main/index.js
- git-commit-id `useNativeGit`: https://issues.apache.org/jira/browse/ZEPPELIN-4304
- virtio-fs and inotify: https://listman.redhat.com/archives/virtio-fs/2021-January/002544.html, https://lima-vm.io/docs/config/mount/
- Commit `f7a62a98` (`git show f7a62a98`, its `launcher/REMOVED-DEFAULTS.md` and `launcher/THREAT-MODEL.md` diffs)
- Lab on the VM: [lab-vm.md](lab-vm.md); pinata facts: [current-behaviour.md](current-behaviour.md); earlier measurements: [prior-attempts.md](prior-attempts.md)
