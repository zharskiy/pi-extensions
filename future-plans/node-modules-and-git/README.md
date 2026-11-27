# `node_modules` and `.git` in the sandbox

## The questions

Today the launcher overlays `node_modules` only in the launch repository, and every `.git` reaches the container read-write through Apple's virtio-fs share. The owner asked: can `node_modules` never cross the share in either direction, and can git be handled on the host while the agent keeps git in the container? What is the industry standard, and the most logical design? The background is the open-file problem in [synced-workspace/README.md](../synced-workspace/README.md).

## Decision

Owner, 2026-11-27, after reading the research.

The end state is the code in the VM, not on the live share. It is not scheduled. [synced-workspace/](../synced-workspace/README.md) holds one design of that kind, attempt 1's synced copy; no design is picked. With a sync, `node_modules` is a name on the exclude list at any depth from the first second, so no path list and no scan are needed ([Relation to the synced-workspace attempts](#relation-to-the-synced-workspace-attempts)).

Until then, for `node_modules`, the current decision, owner, 2026-11-27, later the same day: "let's get rid of walk mechanism both for root and launch projects. remove mounts.autoOverlays completely. do not support backward compatibility. reflect these decisions in the plan and do not start implementing yet".

| Step | Built? |
|---|---|
| Today's overlay scan of the launch repository | To be removed, with `mounts.autoOverlays`. Not started. |
| 1. Whole-root overlay at launch | Not to be built. |
| 2. `rslave` plus on-demand mounts by a VM helper | Not to be built. |
| 3. seccomp trap on `mkdir`, strict mode | Not to be built. |

No shim or migration keeps the key working. The removal, its open points and what it costs are track B of [plan.md](plan.md#track-b-removal-of-the-build-output-overlays); its points put to the owner were answered on 2026-11-27 (below).

*Superseded the same day:* the owner's first decision on 2026-11-27 made step 1 the interim build and steps 2 and 3 not to be built, because they need a root helper in the VM or a supervisor in front of every `mkdir`, and moving the code into the VM replaces them. Its accepted gaps no longer apply: a new package or a subagent worktree installing onto the Mac, a tracked `node_modules` (which the code in fact hid; it showed as deleted inside), dependencies under another folder name. The measurement it asked for, the walk time and the mount count on the real workspace, is not needed; the tested commands are kept for the record in [node-modules.md](research/node-modules.md#2026-11-27-measurement-commands-kept-for-the-record). The lab's scale for many mounts stays in L5.

For git, owner, 2026-11-27, after asking about the lock errors the container sometimes reports ([git.md](research/git.md#lock-errors)):

- The git settings that reduce lock collisions are applied and removed by pinata itself, through its commands: `pinata install`, and others where needed, such as `pinata update` and `pinata uninstall`. Nobody sets them by hand, and nothing is applied until the plan is agreed.
- On the Mac they are global: a plain `export GIT_OPTIONAL_LOCKS=0` in the shell profile, and `core.checkStat=minimal` and `core.trustctime=false` in the global git config. Scoping them to the workspace was considered and declined: a zsh `chpwd` hook or direnv for the variable, `includeIf "gitdir:<root>/"` for the config.
- Every line pinata writes to a shell profile sits between marker lines. This is already the case: `launcher/cli/pinata/path-block.ts` writes `# pinata begin` … `# pinata end` and replaces the block as a whole.
- `pinata uninstall` removes them again, and only what lies between `# pinata begin` and `# pinata end`. Nothing outside the markers is touched, in the shell profile or in the global git config.
- In the container, pinata's own environment values and the user's `env.set` are two sources and nothing is merged. Where both name a variable, the `env.set` value replaces pinata's.
- Implementation has not started and does not start before the plan is agreed.

The design is in [git-settings-proposal.md](git-settings-proposal.md); of its open points, the `includeIf` form was agreed on 2026-11-27, the others stand as the plan's choices. *2026-11-27:* the plan steps for both, with a recommended answer to every open point, are in [plan.md](plan.md); the points put to the owner were answered on 2026-11-27 (below), and since the later decision the same day its `node_modules` track is the removal of the overlays, with no measurement or gate. Nothing else is decided for git; in particular the long-term arrangement is not. The research's recommendation below stands as written. A later recommendation, not an owner decision, is dated in [git.md](research/git.md#conclusion): with the code in the VM, git moves with it, and neither the index guard nor the private git dir would be built in the interim.

For the Mac's open-file limit, owner, 2026-11-27: "let's also increase the maxOpenFiles for the host during pinata install/session start (you decide) flow. Let's set it near 1M". So pinata itself raises the limit to about one million; install or session start was left open.

- *Choice delegated to the plan, 2026-11-27, agreed by the owner the same day ("agree"):* `pinata install` raises it and installs a boot-time job that restores it, since the value resets at every reboot and needs root, and a session start cannot always show a password prompt. Launches and `pinata doctor` only check the value. Details, and the recommended reading of "maxOpenFiles" as `kern.maxfiles` with `kern.maxfilesperproc` untouched, are track C of [plan.md](plan.md#track-c-the-macs-open-file-limit). The background is [synced-workspace/README.md](../synced-workspace/README.md#the-problem) and attempt 2's [proposal.md](../synced-workspace/attempt-2-live-share/proposal.md#the-mechanism-corrected) and [notes-vz-internals.md](../synced-workspace/attempt-2-live-share/notes-vz-internals.md).

Owner's answers, 2026-11-27, to the six points put to them, verbatim: "everything that is worth removing must be removed", then "1. correct" (`kern.maxfiles` only, the per-process limit left at 61,440), "2. okay" (pinata's first `sudo` and root-owned file on the Mac), "3. agree" (install, not session start), "4. we'll start working on all the tracks in parallel which we've been discussing" (order: all three tracks in parallel), "5. yes" (delete the daily volume cleanup and the mount-point record), "6. that's okay" (the `includeIf "gitdir:/"` form). *This session's reading, not the owner's words:* the opening sentence means all code the removal leaves dead goes in the same change and none is kept for one release; it adds no code that cleans up users' machines. The other recommendations stand as the plan's choices; implementation has not started and starts on the owner's word ([plan.md](plan.md#owners-answers-2026-11-27)).

## Answers

### `node_modules`

**Achievable for everything run in the container, as hygiene, not as a security boundary.** The agent has the whole root read-write, so it can still put Linux files on the Mac under any other name.

Industry standard: the Linux copy of the dependencies stays on the Linux side, by a volume mounted over `node_modules` at known paths or by a sync that excludes it. Native binaries are chosen per OS and CPU at install time, so a shared copy is wrong anyway.

The design the research recommends (see [Decision](#decision) for what is built of it):

1. At launch, a walk of the whole `workspaceRoot` on the Mac's own disk finds every folder with a `package.json` or lockfile. Each gets a VM-disk volume over its `node_modules`, tracked folders excepted.
2. The root bind gets `rslave`, so mounts made in the VM after start reach the running container.
3. When the Mac's FSEvents watch sees a new `package.json` or `node_modules`, a root helper in the VM mounts a volume there, only over a missing or empty folder.

Step 1 alone can ship first. A seccomp trap on `mkdir` closes the remaining race but puts a supervisor in front of every `mkdir`; a stuck one hangs the container. It is an optional strict mode for later, not the first build.

The owner's first decision, 2026-11-27: step 1 is the interim build. *Superseded the same day:* the walk is removed for the root and the launch repository and `mounts.autoOverlays` goes, so step 1 is not built either ([Decision](#decision)). Steps 2 and 3 (the on-demand mounts and the trap) are not to be built, because they need a root helper in the VM or a supervisor in front of every `mkdir`, and moving the code into the VM replaces them. The costs and gaps below are those of the full design. Step 1 alone has no root helper and no race, but a folder created during a session gets no overlay until the next launch.

What the full design gives up: a synchronous guarantee. An install that starts within the event and mount latency of its `package.json` appearing writes its first files to the Mac. Costs: a root helper acting on paths the agent can change, one mount per package, an empty `node_modules` on the Mac beside each, volumes lost on `pinata restart`. Not covered: the Mac IDE never sees the container's install, a shared lockfile still crosses, Maven `target/` cannot be overlaid. A mounted `node_modules` breaks `git worktree remove`, so subagent worktrees need a decision if on-demand mounts are ever built; step 1's walk does not enter `.pi`, so it mounts nothing inside `<repo>/.pi/worktrees/`.

### `.git`

**"All git on the host" behind a shim is rejected.** Git's argv and environment are a code-execution surface: six vectors, from `-c alias.x='!cmd'` to husky's `core.hooksPath`, each created a file on the Mac in a test. A broker also exposes the Mac's credentials and breaks tools that read `.git` directly. No sandbox product forwards git argv to the host.

What is costly is the `git status` walk over the work tree, not `.git`: a shared and a private `.git` differ by 11 descriptors per walk. And a shared `.git` has an empty-index hazard that is real today: while the Mac rewrites its index, the container can read it as empty, and `commit -am` can commit the deletion of every file.

Industry standard has two halves. For a work tree shared live (Dev Containers, Docker Sandboxes' direct mode): one shared `.git` with nothing added. For isolation (cloud agents, Docker Sandboxes' clone mode): a repository owned by the sandbox, results crossing through git's transport.

Recommended order:

1. No broker.
2. An index guard in the container now: a `git` wrapper that refuses on an empty index, a pre-commit check, attempt 1's container settings. It detects the hazard, cannot remove it, and does nothing for the walk. It is undesigned and untested.
3. The target: a sandbox-private git dir (a VM-disk volume over each `<repo>/.git`, the Mac's objects borrowed through alternates, results fetched to the Mac as `refs/pi/*`) with an fsmonitor hook answered by a watcher on the Mac. Its spec starts from the HEAD policy and a tested answer to the failure the review reproduced: after a Mac `git stash` or branch switch between an agent commit and the sync, the agent's next `commit -am` commits the revert of its own work. Not to be built before that.

The hook is the sound form of the owner's idea: the host does the watching, the container keeps a real git. Costs: that two-state window, a host-side sync that runs git in the user's repositories, a volume and setup step per repository (0.2 to 3.1 s each), a newer git than the image ships, and the reversal of commit `f7a62a98`. Not covered at first: repositories created during a session, submodules, Mac-made worktrees.

Both answers have the same shape: a VM-disk volume mounted over a folder each side keeps to itself.

## What was measured

| Claim | Number | `lab-vm.md` |
|---|---|---|
| An `rslave` root bind receives a mount the VM makes after start | seen by a uid-1000 container with no capabilities; not seen with default propagation | L1 |
| Files written into a VM mount stay off the Mac | 20,000 files: +0 Mac descriptors, against +20,201 in a plain share folder | L1 |
| Container writes raise FSEvents on the Mac | 9 to 12 ms after the write | L4 |
| Mount count is not a limit | 2,000 mounts: about 0.5 ms each, `docker exec` +65 ms, start +130 ms, about 2 Mac descriptors each | L5 |
| The seccomp trap works, with a hard dependency | about 16 µs per `mkdirat`; a stuck supervisor hung `mkdir` for 3 minutes | L6 |
| The empty index is frequent under a Mac write loop | 890 of 900 bad reads with a shared `.git`, 0 of 1,200 with a private one; far more often than attempt 1's 1 in 166 | L2 |
| The walk is the cost, not `.git` | one `git status`, 20,420 files: +20,839 shared, +20,828 private | L3 |
| A hook plus untracked cache skips the walk | +7 descriptors, 0.05 s, against +20,828, 1.8 s; with a stub hook, no real watcher | L3 |
| The private git dir works end to end | 0 objects copied; fetch 0.44 s; 0 failures in 1,378 reads while the Mac ran `repack` and `gc` | L2 |
| `git worktree remove` with a mounted `node_modules` | fails "Resource busy", drops the worktree metadata, orphans the folder | L2 |

The lab VM was a throwaway Colima profile: macOS 27.2, colima 0.10.3, lima 2.3.0, Docker 29.5.2, runc 1.3.5, Ubuntu 24.04.4, kernel 6.8. Its image was alpine 3.24 with git 2.54.1, not pinata's, whose Debian git is 2.39.5.

## Not measured

- Anything with root on the Mac: a `kern.maxfiles` above 122,880, a LaunchDaemon restoring it at boot on macOS 27, a running VM under the raised table ([plan.md](plan.md#track-c-the-macs-open-file-limit), C0).
- Walk time and file counts on the real workspace and the failing machine. *2026-11-27:* no longer needed, since the owner removed the walk ([Decision](#decision)).
- A real Mac watcher behind the hook, with its cookie barrier.
- The HEAD policy against Mac stash, shelve and branch switch; the index guard against the empty-index loop.
- Latency from a new `package.json` to a visible mount; an install mounted over midway.
- Whether npm, pnpm and Bun create `node_modules` by `mkdir` or `rename`; the trap on a real `npm ci`.
- The replay step on git 2.39.5 in pinata's image; IDEA during a sync.
- Worktree removal with `.pi/worktrees` on a volume; orphan mounts after a Mac-side delete.
- The lock errors the owner sees: their message, lock and command were not captured. The git settings of the [proposal](git-settings-proposal.md) on the owner's workspace; the evidence for them is attempt 1's measurement ([prior-attempts.md](research/prior-attempts.md#git)).

## Relation to the synced-workspace attempts

Attempt 1's synced copy would replace the overlay scan with `mounts.unsynced`, a name list the sync leaves on each side at any depth, which covers new `node_modules` from the first second. Attempt 1 keeps one `.git` per repository, bound from the share, because two indexes stage each other's commits as reverts, the same failure the private git dir must answer. Attempt 2's own virtio-fs device does not separate `node_modules`. How either design here would sit on attempt 1's sync or attempt 2's device is not worked out.

The owner's stated end state is the code in the VM ([Decision](#decision)), with no design picked. For `node_modules` the documents say what a sync of that kind means: the name sits on the exclude list at any depth from the first second, which replaces the whole-root walk, the on-demand mounts and the trap. What it means for git is not decided.

## Reading guide

All under [research/](research/node-modules.md).

1. [node-modules.md](research/node-modules.md): mechanisms, survey, experiments, the recommended design.
2. [git.md](research/git.md): designs A to F, survey, experiments, the recommended order.
3. [lab-vm.md](research/lab-vm.md): the VM lab, L1 to L6, with its verdict table.
4. [current-behaviour.md](research/current-behaviour.md): what the launcher does today, with `path:line` references.
5. [prior-attempts.md](research/prior-attempts.md): what the synced-workspace attempts established here.

Outside research/:

- [plan.md](plan.md): the plan steps for the git settings, the removal of the build output overlays and the Mac's open-file limit, with a recommendation for each open point and the owner's answers of 2026-11-27; not started.
- [git-settings-proposal.md](git-settings-proposal.md): the design for the git settings of the [Decision](#decision); its `includeIf` form agreed 2026-11-27.

## How the research was done

A code trace and a digest of the earlier attempts; two research tracks, sources plus experiments on the Mac; an independent review, which reproduced the stash failure and found gaps in the `node_modules` design; a VM lab; a revision of both documents.

## What is not in the repository

The experiment scripts, the lab scripts and their raw outputs, and the reviewer's reproduction lived in a temporary folder and are not filed. The documents carry the commands and the numbers.

## Open decisions for the owner

1. The HEAD policy: may the developer's git and the agent's git hold different state over one live work tree; if so, "follow" or "review", with or without a rule against Mac-side work-tree git.
2. Whether to build the index guard now. A later recommendation, not an owner decision, says no, given the end state ([git.md](research/git.md#conclusion), 2026-11-27).
3. Answered 2026-11-27. Settled ([Decision](#decision)), later the same day: the walk goes for the root and the launch repository, `mounts.autoOverlays` goes without backward compatibility, and none of the three steps is built. This supersedes the same day's first answer, the whole-root overlay as the interim build with a measurement before it. The points of the removal were answered the same day: no cleanup code stays one release, the daily volume cleanup and the mount-point record go ("5. yes"); O1 and O2 stay documented manual steps ([plan.md](plan.md#removal-of-the-overlays)).
4. Subagent worktrees: unmount before removal through a request to the VM helper, or move `<repo>/.pi/worktrees` to a VM volume. Only arises with on-demand mounts, which are not to be built. *2026-11-27:* with the overlays removed no volume sits in any repository, so no worktree removal is blocked; its checkouts install onto the Mac, like every repository.
5. Alternates over the share, or a one-time copy of the objects to the VM's disk.
6. A newer git in the image, or a replay step that works on 2.39.
7. Accepting that the private git dir reverses commit `f7a62a98`: per-repository mounts return, and the host runs git in the user's repositories.
8. Partly answered 2026-11-27: the first point below, the `includeIf "gitdir:/"` form, "that's okay"; the others were not put one by one. Agreeing the [git settings proposal](git-settings-proposal.md), with its open points ([Open points](git-settings-proposal.md#open-points)). *2026-11-27:* each now has a recommendation, revised for the first and second below, and the steps are in [plan.md](plan.md#track-a-git-settings):
   - the global git config: a marked block with one `include.path` entry and a file pinata owns, or the two keys themselves in a marked block; now recommended: a marked block with `[includeIf "gitdir:/"]`, which matches every repository, so it is not the scoping the owner declined;
   - a user who already has a value for one of the keys: override, defer or skip; now recommended: defer, with the block at the start of the global file;
   - where pinata's included file lives, outside `<state>`; now recommended: a static file in the installed package;
   - whether `pinata uninstall --sandbox` keeps the settings, as it keeps the marked block (recommended: keep);
   - the marker names: keep `# pinata begin` and `# pinata end` (recommended), or rename;
   - whether `pinata doctor` reports the settings; now recommended: no check now.
9. Answered 2026-11-27. The Mac's open-file limit: the flow chosen for the owner (install and a boot job, "agree") and the reading of "maxOpenFiles" as `kern.maxfiles` to at least 1,048,576, with `kern.maxfilesperproc` untouched ("correct"), both confirmed; root on the Mac "okay"; all tracks in parallel ([plan.md](plan.md#the-open-file-limit), C1 to C9).
