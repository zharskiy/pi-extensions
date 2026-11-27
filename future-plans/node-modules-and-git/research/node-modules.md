# `node_modules` never crosses the share

Each claim is sourced (a link, listed under [Sources](#sources)), tested here (an experiment on the Mac, E1 to E12, under [Experiments](#experiments)), lab (a run on a Colima VM, cited by section of [lab-vm.md](lab-vm.md), L1 to L6), or marked inferred. The facts about the two earlier attempts come from [prior-attempts.md](prior-attempts.md) (cited as PA).

## Question

Can pinata keep the Mac's `node_modules` out of the container, and keep the container's `node_modules` off the Mac, for every `node_modules` under `workspaceRoot`? What do others do, and which design is the cleanest?

Every mechanism is tested against these requirements.

| # | Requirement |
|---|---|
| R1 | Holds for every `node_modules` at any depth under the root. |
| R2 | Holds for folders created after the container started: an install in another repository, a subagent worktree under `<repo>/.pi/worktrees/`, a new workspace package. |
| R3 | Both directions. The Mac copy is invisible inside, and the container copy never lands on the Mac. |
| R4 | The dependency files cost no Mac descriptors. |
| R5 | No walk of the tree through the share. |
| R6 | Survives across launches, so there is no full reinstall each time. |
| R7 | Says what the Mac sees at those paths. |
| R8 | Privileges needed in the VM or the container. |
| R9 | Number of mounts, and any Docker or kernel limit. |
| R10 | Works with npm, pnpm, Yarn classic and Berry, Bun, workspaces, hoisting, `.bin`, and caches under `node_modules/.cache` and `.vite`. |

## Short answer

1. **Achievable, as hygiene, not as a security boundary.** Every package manager and build tool run inside can be kept from writing a `node_modules` to the Mac, and the Mac's own `node_modules` hidden inside, across the whole root. An agent that wants Linux files on the Mac can still write them under any other name while it has the root read-write (`launcher/THREAT-MODEL.md`).
2. **Industry standard:** share the sources and keep a per-OS `node_modules` on Linux-local storage at paths known in advance (a volume or a sync exclude per path), or share nothing and clone inside Linux ([compose-watch], [vscode-perf], [devspace-sync], [codespaces]). No tool found discovers new `node_modules` at any depth after start.
3. **On a live share** every mechanism that also covers folders created after start puts something in the VM's path: a root helper that mounts on demand (B), a supervisor in front of every `mkdir` (the seccomp trap), or a filter filesystem in front of every source operation (C). Mounts made only at launch miss every later folder (A). **A synced copy** covers any depth from the first second by one name on its exclude list (F), and a clone in the VM has no shared tree at all. This is why the end state is the code in the VM ([plan.md](../plan.md)).
4. What cannot be had: the Mac IDE never sees the container's install; the Mac sees its own install, or nothing. A shared lockfile still crosses, and npm can drop other platforms' optional packages from it ([npm-4828]). Native binaries are chosen per OS and CPU at install time, so a tree installed on one OS breaks on the other ([esbuild], [sharp]).

## What the industry does

Read in November 2026. Most pages carry no version.

| Who | What they do about `node_modules` | Source |
|---|---|---|
| Docker Compose Watch | Sync sources with `ignore: node_modules/`. "Not recommended to sync" it: native code is "not portable across platforms". Rebuild on `package.json`. | [compose-watch] |
| Docker Desktop synchronized file shares | Mutagen. `.syncignore` at the share root. Suggests ignoring "large dependency directories, for example `node_modules`". About 2 million files per share. | [docker-sfs] |
| Docker docs, bind mount plus volume over `node_modules` | Not found on docs.docker.com today. It is a forum and tutorial pattern. | [docker-forum] |
| VS Code Dev Containers | A named volume mounted at `node_modules`, plus a `chown` after create. An empty local folder appears ("expected and harmless"). The alternative is "Clone Repository in Container Volume". | [vscode-perf] |
| GitHub Codespaces, Ona (Gitpod), Daytona, Cursor cloud agents, Codex cloud, E2B | Clone or upload into a Linux VM or container and install there. No host share. | [codespaces], [ona], [daytona], [cursor], [codex-cloud], [e2b] |
| DevPod | Clones, or syncs a local folder to the remote machine. Its handling of node_modules was not confirmed. | [devpod] |
| OrbStack | "For best performance, use volumes when possible." Nothing specific to node_modules. | [orbstack] |
| Lima, Colima | Mount types and writability only. Nothing on node_modules. | [lima-mount], [colima-faq] |
| WSL2 | Keep project files in the Linux filesystem, not under `/mnt/c`. | [wsl-fs] |
| DDEV | Mutagen. Put `node_modules` in `upload_dirs`, which takes it out of the sync and bind-mounts it instead. | [ddev-perf] |
| Lando | `excludes:` for `vendor`, `node_modules`. Excluded folders are cut off from the host, and installs run through `lando npm`. | [lando-perf] |
| Mutagen | Git-style ignores. VCS is the only built-in group, so node_modules needs its own pattern. | [mutagen-ignore] |
| DevSpace | `uploadExcludePaths: [node_modules/]`, because it may hold "compiled binaries that are not portable". It runs `npm install` on a `package.json` change. | [devspace-sync] |
| Tilt, Skaffold, Okteto | Sync rules with ignores. No documented node_modules default was confirmed. | [tilt-api], [skaffold-sync], [okteto-sync] |
| Docker Sandboxes | Live passthrough mount at the same path, with no special case. Clone mode mounts the host repository read-only and works in a private clone. | [docker-sbx] |
| Claude Code dev container | Binds the workspace. Volumes only for history and config. No node_modules volume. | [cc-devcontainer] |
| Claude Code sandbox, Codex CLI, Gemini CLI seatbelt | Run on the host OS itself (Seatbelt, bubblewrap), so node_modules is a native install. | [cc-sandbox], [codex-sandbox], [gemini-sandbox] |
| OpenHands, Gemini CLI docker | Bind-mount the project. No special case. | [openhands], [gemini-sandbox] |
| container-use, Sculptor | A container per agent and a branch or worktree per agent. How code enters was not confirmed. | [container-use], [sculptor] |

**Common practice.** Keep `node_modules` on the Linux side at known paths: a volume per path, or an exclude in a sync tool. Or share nothing and clone inside Linux. Agent tools that bind the host tree mostly do nothing special.

**Best-engineered answer.** The same split, made automatic: Linux-local `node_modules`, reinstalled from the lockfile when it changes (DevSpace, Compose `rebuild`). Two of them key off `package.json` changes. No vendor found discovers folders dynamically at any depth.

**Correctness.** esbuild: "You cannot install esbuild on one OS, copy the `node_modules` directory to another OS without reinstalling", naming Docker and WSL. It suggests Yarn `supportedArchitectures` or the slower `esbuild-wasm` ([esbuild]). sharp: binaries are selected per OS, CPU and libc, and lockfiles shared across platforms break because of npm bug #4828 ([sharp]). npm/cli#4828: platform-specific optional dependencies are dropped from `package-lock.json` when reinstalling with `node_modules` present. Users still report it on npm 11.16 and 11.17 ([npm-4828]).

## Keeping `node_modules` off a live share

These were researched for a tree that stays shared live. None is part of the end state; they record why a live share has no clean answer.

### A. Mounts at launch over known paths

A VM-disk volume mounted at each `node_modules` when the container is created. The paths come from a listing on the Mac's own disk, beside every `package.json` or lockfile, existing or not, so a fresh clone's first install also lands on the volume.

| Listing | Cost | Misses |
|---|---|---|
| Walk on the Mac's own APFS, skipping `.git`, `.pi`, `node_modules`, `target` | 42,002 folders in 0.25 s warm, 54 `node_modules` in 0.52 s (E7). | Nothing that exists. |
| `git ls-files` for `package.json` | 0.02 s per repository (E7). | Untracked packages. |
| Spotlight (`mdfind`) | 0.07 s | Found 13 of the 54 (E8). |

npm, pnpm and Bun install into a mounted folder, and `npm ci` empties it without unmounting (E9). Mounts are fixed at create, so folders made later (another repository's install, a subagent worktree, a new workspace package) land on the Mac (fails R2). One mount per package with dependencies: pnpm and Bun mount every workspace package, npm each with a conflicting version (E6). 2,000 propagated mounts took about 0.5 ms each, added about 65 ms to `docker exec` and 130 ms to container start, and pinned about 2 Mac descriptors each; `fs.mount-max` is 100,000 (L5, [kernel-fs]). A committed `node_modules` must be left alone, or container git shows thousands of deletions (inferred; attempt 1 exempts tracked folders, PA). Precedent: VS Code, Compose and DDEV, all per known path.

### B. Mounts made on demand, reaching the container by propagation

The root bind gets `bind-propagation=rslave` ([docker-bind], [mount-ns]); a root helper in the VM bind-mounts a VM-disk folder onto `<path>/node_modules`, and the running container sees it. In the lab the share's mount in the VM was already `shared`; a uid-1000 container with all capabilities dropped and an `rslave` root bind saw a mount made after start, one with default propagation did not; 20,000 files written into the mount cost the Mac 0 descriptors, against +20,201 in a plain share folder (L1).

| Trigger | Synchronous? | Covers | Verdict |
|---|---|---|---|
| Shims for `npm`, `pnpm`, `yarn`, `bun`, `npx` | Yes | Only calls through the shim. Misses Vite's `.vite`, absolute paths, `corepack`. | Partial |
| Watch inside the VM | No | inotify needs a watch per folder, a walk through the share. fanotify directory events need file handles, and FUSE filesystems with a zero fsid "return ENODEV" ([fanotify-mark]); virtio-fs is FUSE-based. Not run in the lab. | Fails R5, likely fails outright |
| FSEvents on the Mac, for a new `package.json` or `node_modules` | No | Every creation, Mac or container: container writes through the share fire FSEvents 9 to 12 ms later (L4), Mac writes 4 to 53 ms (E10). | Works, with a race |
| seccomp user notification on `mkdir`, `mkdirat` | Yes | Every folder the container creates by `mkdir`, not by `rename`. | Works (L6), with a hard dependency |

- **The race.** An install that starts within the event latency plus request and mount time writes its first files to the Mac. Mounted over midway, lookups reach the empty volume while the installer's open descriptors still write to the share, so the install ends split (inferred, as after the lazy unmount in L1).
- **The helper** runs as root in the VM on paths the agent can change: the agent can swap a folder for a symbolic link between request and mount (inferred).
- **The trap.** Docker passes `listenerPath` to runc ([moby-seccomp], [runc-seccomp]); Docker 29.5.2 with runc 1.3.5 accepted it, at about 16 µs per trapped `mkdirat` (L6). The supervisor becomes a dependency of every `mkdir`: if the listener dies, notified calls fail with ENOSYS ([seccomp-unotify]); in the lab a stuck one hung the next container's first `mkdir` for 3 minutes (L6). A trap profile replaces Docker's default filter unless merged into it (L6). Whether npm, pnpm or Bun create `node_modules` by `mkdir` or by `rename` is not verified.

### Hazards of mounts under the root

- **Unmounting.** In the VM, `umount` fails "target is busy" while a container process has its cwd inside, and `umount -l` leaves that process on the old tree (L1). In the container, `rm -rf node_modules` empties the mount, then fails "Resource busy" (L1, E9, [docker-ebusy]).
- **Subagent worktrees.** With a mount at `<worktree>/node_modules`, `git worktree remove --force` failed with "Resource busy", dropped the worktree's metadata anyway and left an orphan folder (L2).
- **A parent deleted on the Mac** probably leaves its mounts in the VM, on a folder that no longer exists (inferred).

### C. A filter filesystem between the share and the container

A FUSE passthrough over the virtio-fs mount in the VM that maps every component named `node_modules` to VM disk. It meets R1 to R3 synchronously, even against a hostile agent, but a daemon sits in the path of every source operation: passthrough covers `read`, `write`, `splice` and `mmap` and needs `CAP_SYS_ADMIN` ([fuse-passthrough]); lookups, `stat` and `readdir`, which dominate `git status`, still go through it, and it keeps the virtio-fs inodes alive, so it does nothing for R4 on sources (inferred). No precedent found. overlayfs with a VM-disk upper layer sends every write there, which breaks the live share; mergerfs picks a branch by free space or existence, not by name (inferred).

### D. Package-manager redirection

| Manager | Option | Result here |
|---|---|---|
| npm 11.19 | None. A symlinked `node_modules` is replaced by a real folder on `install` and `ci`, and `ci` emptied the link's target (E1). A dangling link is replaced (E5). "By design, and prevents a class of RCE security exploits" ([npm-3669]). | Fails |
| pnpm 12.9 | `modulesDir` and `virtualStoreDir` outside the project: `require` fails without `NODE_PATH`, `pnpm exec` finds no binary, a state file stays in `./node_modules` (E2). The global virtual store (experimental, off by default, [pnpm-gvs]) leaves 4 small files and links that dangle on the Mac (E12). | Partial |
| Yarn classic 1.22 | `--modules-folder` ([yarn1-install]). The project keeps none (E3). Resolution needs `NODE_PATH` (inferred, as E2). | Partial |
| Yarn Berry 4.19 | Plug'n'Play: `.pnp.cjs` and zips in `.yarn/cache`, in the project and so on the share (E4). | Moves the problem |
| Bun 1.4 | No folder option. The global store links into `~/.bun/install/cache/links` but keeps patched, trusted and workspace packages local ([bun-gvs]). | Partial |
| Node | `NODE_PATH` "is not part of resolving `import` specifiers" ([node-esm]). | Fails for ESM |

A symlinked `node_modules` to VM disk works for pnpm, Bun and both Yarns, and npm removes it (E1). A dangling link makes pnpm fail "exists (os error 17)" and Bun ENOENT (E5), which a Mac-side install would meet. Every row needs per-repository configuration, not pinata's to write. Dropped as the main mechanism.

### E. Refusing instead of redirecting

A trap can return `EPERM`; AppArmor globs such as `deny <root>/**/node_modules/ w,` could refuse without a daemon, but their mediation of `mkdir` on virtio-fs is not verified ([colima-1019]). fanotify permission events cover open and access only ([fanotify-mark]). A refusal alone means a failed install.

### F. Not sharing live (synced copies)

Attempt 1 leaves `node_modules` and `target` unsynced on each side by a name list at any depth, tracked folders exempted, at the cost of a rebuild after `pinata restart` (PA). Attempt 2 rates volumes over subfolders "useful, not a bound" (PA). A sync's ignore list covers any depth from the first second: R1 and R2 for free, with no mount, helper or trap.

### G. Other ecosystems

| Ecosystem | Moves out of the tree by environment? |
|---|---|
| Rust `target` | Yes: `CARGO_TARGET_DIR` ([cargo-env]). |
| Python `__pycache__` | Yes: `PYTHONPYCACHEPREFIX`, 3.8 and later ([python-cmdline]). |
| Python `.venv` (uv) | Yes: `UV_PROJECT_ENVIRONMENT`, 0.4.4 and later ([uv-env]). |
| Gradle `.gradle` | Yes, by flag: `--project-cache-dir`. `build/` has no flag or variable ([gradle-cli]). |
| Maven `target/` | No switch found. A volume over it breaks `mvn clean` with EBUSY, as `rm -rf` on a mount fails busy (L1, E9; inferred for Maven). |
| npm `node_modules` | No. Node resolves by walking up the folders (inferred from [node-esm]), and npm refuses links (E1). |

Rust and Python can be handled by a variable in the container. JavaScript cannot, so on a live share `node_modules` needs mounts; a sync needs only its name.

## Experiments

macOS 27.2 on this Mac. Node 26.10.0, npm 11.19.1, pnpm 12.9.1, Bun 1.4.2, Yarn 1.22.22 and 4.19.0 (through `npx`, cache inside the lab). The lab is the session scratchpad's `nm-lab/`. npm, pnpm and Bun also used their usual user caches. Packages: `semver`, `is-number`. The VM runs are in [lab-vm.md](lab-vm.md).

| # | Command (shortened) | Result |
|---|---|---|
| E1 | `ln -s <lab>/vm/<pm> node_modules; <pm> install`, for npm, pnpm, Bun, Yarn 1 and Yarn 4 (`nodeLinker: node-modules`) | npm replaced the link by a real folder, also with a populated target; `npm ci` also emptied the target. pnpm, Bun and both Yarns kept the link and installed into the target, `.bin` included. |
| E2 | pnpm with `modulesDir` and `virtualStoreDir` outside the project | Installed outside. Project `node_modules/` held `.pnpm-workspace-state-v1.json`. `require('semver')` failed, worked with `NODE_PATH`. `pnpm exec semver`: "Command "semver" not found". |
| E3 | `yarn@1.22.22 install --modules-folder <outside>` | Project holds only `package.json` and `yarn.lock`. |
| E4 | Yarn 4 default (PnP) | `.pnp.cjs`, `.yarn/cache`, `.yarn/install-state.gz`, no `node_modules`. `yarn node -e require('semver')` worked. |
| E5 | `ln -s /nonexistent-vm-path/nm node_modules; <pm> install` | npm replaced it with a folder. pnpm failed "exists (os error 17)". Bun failed "ENOENT … could not open the "node_modules" directory". |
| E6 | Workspace: root depends on `semver@7`; `a` on `semver@6`; `b` on `a` and `is-number`; `c` has no dependencies | npm made 2 `node_modules` (root, `a`). pnpm and Bun made 3 (root, `a`, `b`). |
| E7 | `find . \( -name .git -o -name node_modules \) -prune -o -type d -print`, on a local tree of 8 repositories, warm | 42,002 folders in 0.25 s. 54 `node_modules` in 0.52 s. `git ls-files '**/package.json'` 0.02 s. |
| E8 | `mdfind -onlyin <tree> 'kMDItemFSName == "node_modules"'` | 13 results against 54 from `find`. |
| E9 | `hdiutil attach -mountpoint <proj>/node_modules` (a real mount, no root needed), then installs | npm `install` and `ci` (which emptied and refilled it), pnpm `install` and `node-linker=hoisted`, Bun `install` and `--force`: mount kept. `rm -rf node_modules`: "Resource busy", contents gone, mount kept. |
| E10 | `fs.watch(root, {recursive: true})` (FSEvents), then `mkdir -p a/b/c/p<i>/node_modules` ×20 | 20 of 20 seen, 3.9 to 53 ms. |
| E11 | `find node_modules -type d \| wc -l`, this repository's root | 1,910 folders and 19,493 files. 78,572 files across the 54 local `node_modules`. |
| E12 | pnpm `enableGlobalVirtualStore: true`, store in the lab | Project `node_modules`: 4 files (20 KB) plus relative links into the store. `require` and `pnpm exec` worked. |

## Not verified

| Claim | Check |
|---|---|
| npm, pnpm, Bun create `node_modules` by `mkdir`, not `rename` | `strace -f -e trace=mkdir,mkdirat,rename,renameat2 <pm> install` in the container. |
| fanotify on virtio-fs | `fanotify_mark(FAN_MARK_FILESYSTEM, FAN_CREATE\|FAN_ONDIR)` with `FAN_REPORT_FID`. Expect ENODEV. |
| AppArmor refusal | `deny <root>/**/node_modules/ w,`, `--security-opt apparmor=<name>`, then `mkdir`. |
| The counts on the real workspace | Never measured by either attempt (PA). |

## Sources

- [compose-watch]: https://docs.docker.com/compose/how-tos/file-watch/
- [docker-sfs]: https://docs.docker.com/desktop/features/synchronized-file-sharing/
- [docker-forum]: https://forums.docker.com/t/why-exclude-node-modules-from-docker-volume/80494
- [docker-bind]: https://docs.docker.com/engine/storage/bind-mounts/
- [docker-seccomp]: https://docs.docker.com/engine/security/seccomp/
- [moby-47532]: https://github.com/moby/moby/issues/47532
- [moby-seccomp]: https://github.com/moby/moby/commit/5d244675bdb23e8fce427036c03517243f344cd4
- [runc-seccomp]: https://github.com/opencontainers/runc/pull/2682 (and `libcontainer/seccomp/seccomp_linux.go`, runc 1.1 and later)
- [docker-ebusy]: https://forums.docker.com/t/cannot-remove-node-modules-device-or-resource-busy/85338
- [vscode-perf]: https://code.visualstudio.com/remote/advancedcontainers/improve-performance
- [codespaces]: https://docs.github.com/en/codespaces/overview
- [ona]: https://ona.com/docs/ona/configuration/multi-repository.md
- [devpod]: https://devpod.sh/docs/developing-in-workspaces/create-a-workspace
- [daytona]: https://www.daytona.io/docs/en/git-operations
- [cursor]: https://cursor.com/docs/cloud-agent/setup
- [codex-cloud]: https://learn.chatgpt.com/docs/environments/cloud-environment
- [codex-sandbox]: https://learn.chatgpt.com/docs/sandboxing
- [e2b]: https://e2b.dev/docs/filesystem/upload
- [orbstack]: https://docs.orbstack.dev/docker/file-sharing
- [lima-mount]: https://lima-vm.io/docs/config/mount/
- [colima-faq]: https://github.com/abiosoft/colima/blob/main/docs/FAQ.md
- [colima-1019]: https://github.com/abiosoft/colima/discussions/1019
- [wsl-fs]: https://learn.microsoft.com/en-us/windows/wsl/filesystems
- [ddev-perf]: https://docs.ddev.com/en/stable/users/install/performance/
- [lando-perf]: https://docs.lando.dev/config/performance.html
- [mutagen-ignore]: https://mutagen.io/documentation/synchronization/ignores
- [devspace-sync]: https://www.devspace.sh/docs/configuration/dev/connections/file-sync
- [tilt-api]: https://docs.tilt.dev/api.html
- [skaffold-sync]: https://skaffold.dev/docs/filesync/
- [okteto-sync]: https://okteto.com/docs/reference/file-synchronization
- [docker-sbx]: https://docs.docker.com/ai/sandboxes/architecture/
- [cc-devcontainer]: https://github.com/anthropics/claude-code/blob/main/.devcontainer/devcontainer.json
- [cc-sandbox]: https://code.claude.com/docs/en/sandboxing
- [gemini-sandbox]: https://geminicli.com/docs/cli/sandbox/
- [openhands]: https://docs.openhands.dev/openhands/usage/sandboxes/docker.md
- [container-use]: https://container-use.com/introduction
- [sculptor]: https://docs.imbue.com/features/containers
- [esbuild]: https://esbuild.github.io/getting-started/ ("Simultaneous platforms")
- [sharp]: https://sharp.pixelplumbing.com/install
- [npm-4828]: https://github.com/npm/cli/issues/4828
- [npm-3669]: https://github.com/npm/cli/issues/3669
- [pnpm-gvs]: https://pnpm.io/global-virtual-store and https://pnpm.io/settings/node-modules
- [yarn1-install]: https://classic.yarnpkg.com/en/docs/cli/install
- [bun-gvs]: https://bun.com/docs/pm/global-store.md
- [node-esm]: https://nodejs.org/api/esm.html ("No `NODE_PATH`")
- [seccomp-unotify]: https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html
- [mount-ns]: https://man7.org/linux/man-pages/man7/mount_namespaces.7.html
- [kernel-fs]: https://docs.kernel.org/admin-guide/sysctl/fs.html
- [fanotify-mark]: https://man7.org/linux/man-pages/man2/fanotify_mark.2.html
- [fuse-passthrough]: https://docs.kernel.org/filesystems/fuse/fuse-passthrough.html
- [incus-intercept]: https://linuxcontainers.org/incus/docs/main/syscall-interception/
- [fsevents]: https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/Introduction/Introduction.html
- [cargo-env]: https://doc.rust-lang.org/cargo/reference/environment-variables.html
- [python-cmdline]: https://docs.python.org/3/using/cmdline.html
- [uv-env]: https://docs.astral.sh/uv/reference/environment/
- [gradle-cli]: https://docs.gradle.org/current/userguide/command_line_interface.html

