# Plan: the code in the VM

The owner's end state for `node_modules` and `.git`: the code under `workspaceRoot` lives on the VM's own disk, and the agent container reads it there instead of through Apple's virtio-fs share from the Mac. It is not scheduled, and no design for it is picked. This plan says what that state is, why it is the end state, what it means for build output and for git, and what the research does not yet answer. The findings are in [research/](research/node-modules.md); the folder's [README.md](README.md) summarises them.

## The state

The agent works on a checkout on the VM's disk, at the root's own path. Two forms are researched, both in [synced-workspace/](../synced-workspace/README.md#the-two-attempts):

- **A synced copy.** A sync program keeps a VM-disk copy and the Mac folder equal in both directions, over its own connection, never through the share. The Mac's files stay live for the IDE, a moment late. This is attempt 1's plan ([attempt-1-architecture.md](../synced-workspace/attempt-1-architecture.md)).
- **A clone in the VM.** The checkout is filled by a clone inside the VM, with no copy back; work reaches the Mac as fetched branches. This is attempt 1's "Later: workspace not on the Mac at all" mode and design E of [git.md](research/git.md#e-separate-clone-in-the-vm). Its open question is the editor.

What crosses the share then is small and fixed: the session dir, pinata's render dir, configured binds, and in the synced form each repository's `.git`.

## Why it is the end state

- **Descriptors.** Apple's share holds one Mac descriptor per inode the guest has cached, 1.00 per inode, against a per-process limit of 61,440 ([prior-attempts.md](research/prior-attempts.md#measurements); [synced-workspace/README.md](../synced-workspace/README.md#the-problem)). Files on the VM's disk cost none: 20,000 files written to VM disk added 0 Mac descriptors, against +20,201 in a share folder ([lab L1](research/lab-vm.md#l1-mount-propagation)). The cost scales with the tree the agent touches, `node_modules` and build output first, so only moving the tree off the share bounds it.
- **The walk.** One cold `git status` over 20,420 tracked files adds about 20,830 Mac descriptors, whoever owns `.git`; the two differ by 11 ([lab L3](research/lab-vm.md#l3-descriptors-per-git-status)). With the work tree on VM disk the walk costs nothing on the Mac: attempt 1 measured a cold `git status` at 29 ms against 563 ms, and 20 host open files against 40,861 ([prior-attempts.md](research/prior-attempts.md#measurements)).
- **Per-OS dependencies.** Native binaries are chosen per OS and CPU at install time, so a `node_modules` installed on one OS breaks on the other (esbuild, sharp), and npm can drop other platforms' optional packages from a shared lockfile ([node-modules.md](research/node-modules.md#what-the-industry-does), "Correctness").
- **The industry.** Tools either share sources live and keep a per-OS `node_modules` on Linux-local storage at paths known in advance, or share nothing and clone inside Linux. No tool found discovers new `node_modules` at any depth after start ([node-modules.md](research/node-modules.md#what-the-industry-does)). For git, isolation means a repository owned by the sandbox, with results crossing through git's transport ([git.md](research/git.md#what-the-industry-does)).
- **The live share has no clean alternative.** Keeping `node_modules` off the share while the tree stays live needs mounts made on demand by a root helper in the VM, a seccomp supervisor in front of every `mkdir`, or a filter filesystem in the path of every source operation ([node-modules.md](research/node-modules.md#keeping-node_modules-off-a-live-share)). A synced copy gets the same result from a name on its exclude list.

## The product it starts from

- `workspaceRoot` is one read-write bind into the agent container, through the share. `node_modules`, `.venv`, `target` and `.gradle` are ordinary folders in that tree: an install in the container writes Linux files into the Mac's folder, and each cached file costs a Mac descriptor.
- Every repository's `.git` reaches the container through the same bind. pinata applies `GIT_OPTIONAL_LOCKS=0`, `core.checkStat=minimal` and `core.trustctime=false` on the Mac and in the container.
- `pinata install` raises the Mac's `kern.maxfiles` and installs a boot job that restores it; launches and `pinata doctor` check the value.
- While pi runs, pinata releases the VM's file cache when the Mac's descriptor count climbs.

The user-facing description is in [launcher/README.md](../../launcher/README.md) and [launcher/CONFIGURATION.md](../../launcher/CONFIGURATION.md).

## `node_modules` and other build output

- **With a sync**, `node_modules` is a name on the exclude list, honoured at any depth from the first second, for folders that exist at launch and for those made later: a new workspace package, an install in another repository, a subagent worktree. No path list, no scan and no mount is needed. Each side keeps its own copy: the container installs for Linux, the Mac's IDE keeps the Mac's install ([prior-attempts.md](research/prior-attempts.md#node_modules-and-build-output)).
- Attempt 1 proposes the list as `mounts.unsynced`, default `node_modules` and `target`; `out`, `build`, `dist`, `.angular`, `.next`, `.gradle` and `.venv` per install. A frontend build folder left off the list crosses both ways and is indexed by the editor.
- **Tracked folders cross.** A listed name can be a source folder or a committed `node_modules`; hiding it makes container git show its files deleted. Attempt 1 exempts them by asking git in the container, 4 ms on a small tree.
- **With a clone**, nothing crosses, so the question does not arise; the Mac has no copy of the agent's tree at all.
- **What stays true in either form.** The Mac's IDE never sees the container's install. A shared lockfile still crosses with the sources, so npm can still drop other platforms' optional packages from it when it reinstalls with a `node_modules` present ([npm-4828](https://github.com/npm/cli/issues/4828); [node-modules.md](research/node-modules.md#what-the-industry-does), "Correctness"). Dependencies and build output exist only in the VM and are rebuilt after `pinata restart`, which deletes the VM.
- A folder deleted on one side is deleted on the other with everything in it, kept-out folders included (attempt 1, measured).

## git

Where git lives in that state is not decided. The research gives three arrangements and what each costs.

| Arrangement | What it is | What the research found |
|---|---|---|
| Sync plus the Mac's `.git` | Attempt 1: one `.git` per repository, the Mac's, bound into the container from the share. The share then carries only `.git` traffic. | One HEAD and one index for both sides. The half-second window remains: while Mac git replaces the index by rename, the container reads it as empty, and `commit -am` can record the deletion of every file ([git.md](research/git.md#correctness-two-gits-on-one-index-through-the-share); [lab L2](research/lab-vm.md#index-rewritten-on-the-mac-in-a-loop)). `.git` costs Mac descriptors by its file count: 5,011 unpacked, 909 packed. The git settings stay, and attempt 1 adds `core.ignorecase=false` and `safe.directory` in the container. |
| Sync plus a git dir of the sandbox's own | Design D of [git.md](research/git.md#d-sandbox-private-git-dir-mac-objects-borrowed-results-cross-by-transport) over the synced tree: a VM-disk git dir, the Mac's objects borrowed, results fetched to the Mac. | No empty index: 0 bad reads of 1,200 under the loop that broke 890 of 900 shared reads (lab L2). Two HEADs and two indexes over one work tree: after a Mac `git stash` or branch switch between an agent commit and the next sync, the agent's `commit -am` commits the revert of its own work ([git.md](research/git.md#the-two-state-window)). Attempt 1 refused two indexes for this reason. |
| Clone, no sync | Design E: the repository is the sandbox's; the Mac fetches its branches. | The safest and fastest: one kernel per index, nothing of git on the share. A fetch over `docker exec git-upload-pack` took 0.44 s for a two-file commit (lab L2). The Mac's IDE sees the work only as fetched branches, never live. |

In none of them does git run on the Mac on the agent's behalf: forwarding git argv to the host was rejected, because argv, environment and hooks are a code-execution surface ([git.md](research/git.md#b-host-side-git-broker)).

## What synced-workspace established

[synced-workspace/](../synced-workspace/README.md) holds the sync design, its measurements and its costs: the Unison mirror, the first copy (253 s for 300,000 files), memory per end, the deletion and conflict rules, subagent checkouts kept in the VM, repository listing by `lstat`, the clock and naming limits, and the build order. [prior-attempts.md](research/prior-attempts.md) digests what it says about `node_modules` and `.git`. This plan does not repeat it.

## Steps

The research supports these; the order beyond them is not designed.

1. **Measure the real root on the machine that fails**, with no pinata change: file and folder counts of the sources, of `.git` and of `node_modules`; for a sync, the first copy, a pass, memory and inotify watches (attempt 1's step 0). Neither attempt has these numbers.
2. **Pick the form, and where git lives**, from the measurements and the table above. A clone needs an answer for the editor; a private git dir needs the HEAD policy and a tested answer to the stash and branch-switch case before it is built.
3. **Build the form.** For a sync, attempt 1's [build order](../synced-workspace/attempt-1-architecture.md#build-order) applies, with the name list and the tracked-folder exemption above.
4. **Remove what the state makes unnecessary** (next section), once the measurement on the real root confirms it.

## What becomes unnecessary

With the agent's tree off the share, these parts of the product have nothing left to do and are removed:

- The read-write bind of the whole `workspaceRoot` through the share into the agent container. The container mounts the VM-disk checkout instead (and, in attempt 1's form, each `.git` from the share).
- The release of the VM's file cache while pi runs. It exists to free Mac descriptors held for cached files of the shared tree.
- The raised `kern.maxfiles`, its boot job and the check in launches and `pinata doctor`. They exist because the shared tree's descriptors fill the Mac's open-file table. What remains on the share is bounded by the session dir, the render dir, the binds and, with a shared `.git`, its file count. *Inferred:* the remaining count on the real root is not measured (step 1).
- The git settings, only where git leaves the share as well (a clone, or a private git dir). With attempt 1's shared `.git` they stay, because two kernels still read one index.

## Open

- Which form: a synced copy or a clone. For a clone, how the Mac's editor sees the work.
- Where git lives (the table above). For a private git dir: the HEAD policy ("follow", "review", or a rule against Mac-side work-tree git during a session), alternates over the share against a one-time copy of the objects, and a git in the image newer than Debian 12's 2.39.5 or a replay step that works on it ([git.md](research/git.md#other-hard-parts)).
- The default name list and which names are per install.
- Repositories created or renamed during a session, submodules, and linked worktrees made on the Mac: not covered by attempt 1's listing at first.
- The numbers on the real root, and what the share still costs in Mac descriptors once only the session dir, render dir, binds and `.git` cross.
- What the Mac's IDE needs from the agent's tree beyond the sources: the container's `node_modules` and `target` never reach it.
