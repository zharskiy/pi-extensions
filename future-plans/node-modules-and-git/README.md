# `node_modules` and `.git` in the sandbox

## The questions

Today the launcher overlays `node_modules` only in the launch repository, and every `.git` reaches the container read-write through Apple's virtio-fs share. The owner asked: can `node_modules` never cross the share in either direction, and can git be handled on the host while the agent keeps git in the container? What is the industry standard, and the most logical design? The background is the open-file problem in [synced-workspace/README.md](../synced-workspace/README.md).

## Decision

Owner, 2026-11-27, after reading the research.

The end state is the code in the VM, not on the live share. It is not scheduled. [synced-workspace/](../synced-workspace/README.md) holds one design of that kind, attempt 1's synced copy; no design is picked. With a sync, `node_modules` is a name on the exclude list at any depth from the first second, so no path list and no scan are needed ([Relation to the synced-workspace attempts](#relation-to-the-synced-workspace-attempts)).

Until then, for `node_modules`:

| Step | Built? |
|---|---|
| 1. Whole-root overlay at launch | Interim build. Not started. |
| 2. `rslave` plus on-demand mounts by a VM helper | Not to be built. |
| 3. seccomp trap on `mkdir`, strict mode | Not to be built. |

Steps 2 and 3 need a root helper in the VM or a supervisor in front of every `mkdir`. Moving the code into the VM replaces both. It replaces step 1 too, but step 1 is a small extension of today's overlay scan.

Accepted gaps of step 1 alone, until the code moves:

- A new workspace package created during a session installs onto the Mac until the next launch.
- A subagent worktree installs onto the Mac for as long as it lives. The walk does not enter `.pi`, so its checkouts under `<repo>/.pi/worktrees/` get no overlay at any launch.
- `node_modules` folders tracked in git stay shared.
- Dependencies written under another folder name still reach the Mac.

To measure before building step 1: the walk time and the mount count on the real workspace. The command is in [node-modules.md](research/node-modules.md#not-verified-to-measure-on-the-vm), the `time find <root> … -name package.json -print` row; its output count is the number of mounts. The lab gives a scale (L5): 2,000 mounts added about 130 ms to container start and about 65 ms to `docker exec`; 500 added about 10 ms to start and nothing measurable to exec. Its limit: the lab made bind mounts inside the VM, while step 1 passes named volumes to Docker, as the launcher does today under its cap of 512, and that path is not timed above 512. If the walk is slow, its result could be cached between launches; this is an idea, not a tested design.

No decision is recorded for git. Its recommendation below stands as written.

## Answers

### `node_modules`

**Achievable for everything run in the container, as hygiene, not as a security boundary.** The agent has the whole root read-write, so it can still put Linux files on the Mac under any other name.

Industry standard: the Linux copy of the dependencies stays on the Linux side, by a volume mounted over `node_modules` at known paths or by a sync that excludes it. Native binaries are chosen per OS and CPU at install time, so a shared copy is wrong anyway.

The design the research recommends (see [Decision](#decision) for what is built of it):

1. At launch, a walk of the whole `workspaceRoot` on the Mac's own disk finds every folder with a `package.json` or lockfile. Each gets a VM-disk volume over its `node_modules`, tracked folders excepted.
2. The root bind gets `rslave`, so mounts made in the VM after start reach the running container.
3. When the Mac's FSEvents watch sees a new `package.json` or `node_modules`, a root helper in the VM mounts a volume there, only over a missing or empty folder.

Step 1 alone can ship first. A seccomp trap on `mkdir` closes the remaining race but puts a supervisor in front of every `mkdir`; a stuck one hangs the container. It is an optional strict mode for later, not the first build.

The owner's decision: step 1 is the interim build. Steps 2 and 3 (the on-demand mounts and the trap) are not to be built, because they need a root helper in the VM or a supervisor in front of every `mkdir`, and moving the code into the VM replaces them. The costs and gaps below are those of the full design. Step 1 alone has no root helper and no race, but a folder created during a session gets no overlay until the next launch.

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

- Walk time and file counts on the real workspace and the failing machine.
- A real Mac watcher behind the hook, with its cookie barrier.
- The HEAD policy against Mac stash, shelve and branch switch; the index guard against the empty-index loop.
- Latency from a new `package.json` to a visible mount; an install mounted over midway.
- Whether npm, pnpm and Bun create `node_modules` by `mkdir` or `rename`; the trap on a real `npm ci`.
- The replay step on git 2.39.5 in pinata's image; IDEA during a sync.
- Worktree removal with `.pi/worktrees` on a volume; orphan mounts after a Mac-side delete.

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

## How the research was done

A code trace and a digest of the earlier attempts; two research tracks, sources plus experiments on the Mac; an independent review, which reproduced the stash failure and found gaps in the `node_modules` design; a VM lab; a revision of both documents.

## What is not in the repository

The experiment scripts, the lab scripts and their raw outputs, and the reviewer's reproduction lived in a temporary folder and are not filed. The documents carry the commands and the numbers.

## Open decisions for the owner

1. The HEAD policy: may the developer's git and the agent's git hold different state over one live work tree; if so, "follow" or "review", with or without a rule against Mac-side work-tree git.
2. Whether to build the index guard now.
3. Settled 2026-11-27 ([Decision](#decision)): the whole-root overlay is the interim build; the on-demand mounts are not to be built. Still to do before building: measure the walk and the mount count.
4. Subagent worktrees: unmount before removal through a request to the VM helper, or move `<repo>/.pi/worktrees` to a VM volume. Only arises with on-demand mounts, which are not to be built: step 1's walk does not enter `.pi` ([node-modules.md](research/node-modules.md#recommended-design)), so it mounts nothing in a worktree and removal is not blocked. Its checkouts install onto the Mac instead, an accepted gap.
5. Alternates over the share, or a one-time copy of the objects to the VM's disk.
6. A newer git in the image, or a replay step that works on 2.39.
7. Accepting that the private git dir reverses commit `f7a62a98`: per-repository mounts return, and the host runs git in the user's repositories.
