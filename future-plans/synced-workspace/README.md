# Synced workspace and live share: two research attempts

## The problem

The launcher runs agents in a Linux VM on the Mac, and the workspace reaches the VM through Apple's virtio-fs share.
Apple's share holds one Mac file descriptor for each file or folder the guest has cached.
A large `workspaceRoot` therefore fills the Mac's open-file table, and every program on the Mac fails with "Too many open files".
Two attempts researched a fix. Neither is built.

## The two attempts

The two were researched separately. Attempt 2 read a digest of attempt 1 (`attempt-2-live-share/track.md`, entry 01:06) and lists a two-way Unison sync as rejected in one row of `attempt-2-live-share/proposal.md`, quoting attempt 1's own figures. It did not test or re-evaluate attempt 1's plan, and attempt 1 did not see attempt 2. This README compares their documents, not their merits.

| | Attempt 1: synced workspace | Attempt 2: live share |
|---|---|---|
| Files | [attempt-1-architecture.md](attempt-1-architecture.md) (the plan), [attempt-1-progress.md](attempt-1-progress.md) (measurements, survey, reviews) | [attempt-2-live-share/](attempt-2-live-share/ideal.md), see the reading guide below |
| Question | A monorepo of more than 1,000 Maven modules plus dozens of frontend repositories under one `workspaceRoot` must be usable in the sandbox without exhausting the host's open files, and without the `node_modules` scan (`attempt-1-progress.md`, "Goal"). | Bound the Mac's descriptors for the share while the same files stay live on the Mac for IDEA, the whole `workspaceRoot`, no copies. Eight criteria, quoted in `ideal.md` from `track.md`. |
| Approach | Stop sharing the workspace live. Keep a copy on a docker volume on the VM's disk, at the root's own path, and mirror it both ways with the Mac folder through Unison. Each repository's `.git` stays on the Mac and is bound into the container from the share. | Keep sharing live, through a virtio-fs device of pinata's own: a file server in C attached through macOS 27's custom virtio device API. It addresses files by path from one root descriptor, so it holds no descriptor per cached file. |
| On the Mac | Unison from Homebrew, installed by `pinata install`; a mirror helper process per install, built from the proxy helper's parts; per-root sync state under the state dir. Recommended, not written: two git settings and `GIT_OPTIONAL_LOCKS=0`. | macOS 27. Our own lima driver in place of colima, with the server running in lima's driver process, unsandboxed. No `sysctl` change. |
| In the VM | A workspace volume per root, a short-lived mirror container per connection, a Unison build stage in the image, git settings in the container's environment. The overlay scan and `mounts.autoOverlays` are deleted. | Stock Ubuntu kernel 6.8 and its ordinary `virtiofs` driver. No guest change. |
| State | Draft 4 of the plan, nothing implemented. | Phase 2 finished. Research only, the prototype is not filed; the host driver is not built. |
| Main costs, as the documents state them | First copy 253 s for 300,000 files; about 200 MB per end per 300,000 files while watching; the sources twice on disk; `pinata restart` copies the workspace again; a half-second window in which a Mac git write can make the agent record an empty commit; conflicts kept as copies beside the winner; dependencies, build output and subagent checkouts that exist only in the VM (`attempt-1-architecture.md`, "Lifecycle", "Conflicts" and "Known limits"). | No option met all eight criteria. Configuration (a) is 2 % slower than Apple's share on the Maven build and up to 16 % on two untars at once; each small request costs 6 to 11 µs more; a C server of ours sits on the trust boundary with four known confinement windows; macOS 27 only; the driver work is guessed at 4 to 7 weeks (`ideal.md`, "Answer" and "Costs"). |
| Open points, as the documents state them | The numbers on the real root on the failing machine (build order, step 0); five owner decisions: default unsynced names, conflict policy, submodules, Mac git settings, the question in `pinata restart`. | Criterion 3 (speed) not met on some loads, criterion 4 not shown for IDEA, criterion 7 tested but not proven, criterion 8 not met (driver not built). Not measured: a soak, two VMs with the hardened server, the failing machine and its workspace. |

Criterion 5 of attempt 2 asks for the same files with no copies, so a synced copy fails it by definition. That is a difference in the brief each attempt was given, not a finding of either attempt.

## Reading guide for attempt 2

All paths are under [attempt-2-live-share/](attempt-2-live-share/ideal.md).

1. [ideal.md](attempt-2-live-share/ideal.md) first. Its file name reflects the question asked. Its answer is that no option met all eight criteria and that an own virtio-fs device came closest. It holds the criteria, the options compared, the measurements, the verdict per criterion, the costs and a path to shipping.
2. [proposal.md](attempt-2-live-share/proposal.md): the earlier phase. Mac kernel limits, set at boot by a LaunchDaemon where pinata's check fails, plus a guest governor that empties the share's cache above a budget, on Apple's share. `ideal.md` proposes it as the fallback for macOS before 27.
3. [track.md](attempt-2-live-share/track.md): the dated research log, with the criteria, the tasks, the reviews and the summaries.
4. `notes-*.md`: studies by topic (Apple's server read in its binary, the macOS 27 device API, the custom device, hardening, shipping, NFS, krunkit, kernel, other projects).
5. `lab-*-notes.md`: one file per lab, A to N, with the tables of every run.

## What is not in the repository

Only the documents are filed. These are not in the repository:

- The prototype of attempt 2: the two file servers in C with the VM runner and the fuzzer, the test kit and the lab scripts, the NFS lab scripts, and the governor script with its systemd unit.
- The raw run outputs of the labs: logs, traces, samples, timing and result tables, runner statistics and lsof listings.

The documents describe the design and carry the figures. The lab notes hold the tables of every run. Paths that start with `prototype/` in the documents do not resolve.

## Open decisions for the owner

1. Which attempt to build, if any.
2. Whether to file a feedback report with Apple asking its server to close descriptors it is not using (`attempt-2-live-share/ideal.md`, "What only Apple can fix").
