# `node_modules` and `.git` in the sandbox

## The problem

The agent container reads the whole `workspaceRoot` through Apple's virtio-fs share from the Mac, read-write. Apple's share holds one Mac file descriptor for each file or folder the guest has cached, so a large tree fills the Mac's open-file table ([synced-workspace/README.md](../synced-workspace/README.md#the-problem)). `node_modules` and other build output are the largest part of that tree, and a Linux install written into the Mac's folder breaks the Mac's own tools. Every repository's `.git` crosses the same share, and two kernels then work on one index. The owner asked: can `node_modules` never cross the share in either direction, can git be handled on the host while the agent keeps git in the container, what is the industry standard, and what is the most logical design?

## Findings

- **`node_modules` per OS.** Native binaries are chosen per OS and CPU at install time, so one tree cannot serve both systems; a shared lockfile can lose other platforms' optional packages ([node-modules.md](research/node-modules.md#what-the-industry-does)).
- **The industry** keeps a per-OS `node_modules` on Linux-local storage at paths known in advance, by a volume or a sync exclude, or shares nothing and clones inside Linux. No tool discovers new `node_modules` at any depth after start ([node-modules.md](research/node-modules.md#what-the-industry-does)).
- **On a live share** every mechanism that covers folders created after start needs a root helper in the VM, a supervisor in front of every `mkdir`, or a filter filesystem; mounts made only at launch miss later folders ([node-modules.md](research/node-modules.md#keeping-node_modules-off-a-live-share)). A sync covers any depth from the first second by one name.
- **The walk, not `.git`, costs descriptors.** One cold `git status` over 20,420 tracked files adds about 20,830 Mac descriptors, whether `.git` is shared or private; the two differ by 11 ([lab L3](research/lab-vm.md#l3-descriptors-per-git-status)). Files on the VM's disk cost none ([lab L1](research/lab-vm.md#l1-mount-propagation)).
- **A shared index reads empty.** While the Mac rewrites its index, the container can read it as empty, and `commit -am` can commit the deletion of every file: 890 of 900 container reads were bad under a Mac write loop, 0 of 1,200 with a private index ([lab L2](research/lab-vm.md#index-rewritten-on-the-mac-in-a-loop)). Nothing settable removes the window while one index is shared ([git.md](research/git.md#correctness-two-gits-on-one-index-through-the-share)).
- **All git on the host, behind a shim, is rejected.** Git's argv, environment and hooks are a code-execution surface: six vectors each created a file on the Mac in a test. No sandbox product forwards git argv to the host ([git.md](research/git.md#b-host-side-git-broker)).
- **Lock errors.** Locks are honoured across the two systems, so the two sides' writes collide on `index.lock` ([git.md](research/git.md#lock-errors)).

## The future state

Owner's decision: the end state is the code in the VM, on the VM's own disk, not on the live share. It is not scheduled, and no design for it is picked. With a sync, `node_modules` is a name on the exclude list at any depth from the first second, so no path list and no scan are needed. Where git lives in that state is open. [plan.md](plan.md) describes the state, what it means for build output and git, the steps the research supports, what it makes unnecessary, and what is open.

## Reading guide

- [plan.md](plan.md): the future state.
- [research/node-modules.md](research/node-modules.md): requirements, industry survey, mechanisms on a live share, experiments E1 to E12.
- [research/git.md](research/git.md): what is problematic about a shared `.git`, lock errors, industry survey, designs A to F, experiments E1 to E8.
- [research/lab-vm.md](research/lab-vm.md): the VM lab, L1 to L6, with its verdict table.
- [research/prior-attempts.md](research/prior-attempts.md): what the [synced-workspace](../synced-workspace/README.md) attempts established about `node_modules` and `.git`.

The lab VM was a throwaway Colima profile: macOS 27.2, colima 0.10.3, lima 2.3.0, Docker 29.5.2, runc 1.3.5, Ubuntu 24.04.4, kernel 6.8. Its image was alpine 3.24 with git 2.54.1, not pinata's, whose Debian git is 2.39.5.

## How the research was done

A code trace and a digest of the earlier attempts; two research tracks, sources plus experiments on the Mac; an independent review, which reproduced the stash failure of a private git dir; a VM lab.

## What is not in the repository

The experiment scripts, the lab scripts and their raw outputs, and the reviewer's reproduction lived in a temporary folder and are not filed. The documents carry the commands and the numbers.
