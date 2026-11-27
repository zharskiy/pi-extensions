# `node_modules` never crosses the share

Research note, 2026-11-27, revised after an independent review and a VM lab. Each claim is sourced (a link, listed under [Sources](#sources)), tested here (an experiment on the Mac, E1 to E12, under [Experiments](#experiments)), lab (a run on a Colima VM, cited by section of [lab-vm.md](lab-vm.md), L1 to L6), or marked inferred. The facts about today's launcher come from [current-behaviour.md](current-behaviour.md) (cited as CB plus item number). The facts about the two earlier attempts come from [prior-attempts.md](prior-attempts.md) (cited as PA).

## Question

Can pinata keep the Mac's `node_modules` out of the container, and keep the container's `node_modules` off the Mac, for every `node_modules` under `workspaceRoot`? Today only the launch repository is covered (CB 23). What do others do, and which design is the cleanest?

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

1. **Achievable, as hygiene, not as a security boundary.** Every package manager and build tool run inside can be kept from writing a `node_modules` to the Mac, and the Mac's own `node_modules` hidden inside, across the whole root. An install that starts within milliseconds of its `package.json` appearing can still write its first files to the Mac, and an agent that wants Linux files on the Mac can write them under any other name, because it has the whole root read-write (CB 52).
2. **Industry standard:** share the sources and keep a per-OS `node_modules` on Linux-local storage at paths known in advance (a volume or a sync exclude per path), or share nothing and clone inside Linux ([compose-watch], [vscode-perf], [devspace-sync], [codespaces]). No tool found discovers new `node_modules` at any depth after start.
3. **Recommended:** a static overlay of the whole root plus mounts on demand. At launch a walk on the Mac's own disk puts a VM-disk volume over `node_modules` beside every `package.json` or lockfile, tracked folders excepted. The root bind gets `rslave`, and when the Mac's FSEvents watch sees a new `package.json` or `node_modules`, a root helper in the VM mounts a volume there, which the running container sees (L1, L4). No seccomp. Second choice: the same plus a seccomp trap on `mkdir` as an optional strict mode.
   *Owner's decision, 2026-11-27:* first, only the root walk, the first step of this design, was to be built as an interim step; the on-demand mounts and the trap are not to be built, because the end state is the code in the VM. *Superseded the same day:* the owner removed the walk for the root and the launch repository alike, and `mounts.autoOverlays` with it, without backward compatibility. Nothing of this design is built. See the [Decision](../README.md#decision) section of the README.
4. What cannot be had: the Mac IDE never sees the container's install; the Mac sees an empty folder, or its own install. A shared lockfile still crosses, and npm can drop other platforms' optional packages from it ([npm-4828]). Native binaries are chosen per OS and CPU at install time, so a tree installed on one OS breaks on the other ([esbuild], [sharp]).

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

**Best-engineered answer.** The same split, made automatic: Linux-local `node_modules`, reinstalled from the lockfile when it changes (DevSpace, Compose `rebuild`). Two of them key off `package.json` changes, as the recommended design does. No vendor found discovers folders dynamically at any depth.

**Correctness.** esbuild: "You cannot install esbuild on one OS, copy the `node_modules` directory to another OS without reinstalling", naming Docker and WSL. It suggests Yarn `supportedArchitectures` or the slower `esbuild-wasm` ([esbuild]). sharp: binaries are selected per OS, CPU and libc, and lockfiles shared across platforms break because of npm bug #4828 ([sharp]). npm/cli#4828: platform-specific optional dependencies are dropped from `package-lock.json` when reinstalling with `node_modules` present. Users still report it on npm 11.16 and 11.17 ([npm-4828]).

## Mechanisms

### A. Static mounts over known paths, list built without the share

**How.** The launcher lists the paths at launch and Docker mounts a VM-disk volume at each. This is today's mechanism, limited to the launch repository, and it already overlays beside a lockfile before any install: the volume starts empty and the mount point is created on the Mac (CB 12, 13, 28, 29). Widened to the root, the rule must stay "beside every `package.json` or lockfile, existing or not". Listing only existing `node_modules` would be a regression: a fresh clone's first install would go to the Mac.

| Source | Cost | Misses |
|---|---|---|
| Walk on the Mac's own APFS, skipping `.git`, `.pi`, `node_modules`, `target` | 42,002 folders in 0.25 s warm, 54 `node_modules` in 0.52 s (E7). Not measured cold, nor on the real workspace. | Nothing that exists. |
| `git ls-files` for `package.json` | 0.02 s per repository (E7). | Untracked packages. |
| Spotlight (`mdfind`) | 0.07 s | Found 13 of the 54 (E8). |

**Tracked folders.** Some repositories commit `node_modules`; GitHub Actions written in JavaScript commonly do (inferred). Hiding one makes container git show thousands of deletions, which `git add -A` would stage. Attempt 1 exempted tracked folders by asking git in the container, 4 ms on a small tree (PA 14), and the rule carries over. Where the check runs is open: pinata runs no git in the workspace on the Mac (PA 26), so it is git in the container before the mounts are made, which `rslave` allows (B), or a native read of the index.

**Meets** R1 for folders that exist or are announced by a `package.json` or lockfile, R3, R4, R5, R6 (today's volumes persist, CB 25 to 27) and R10: npm, pnpm and Bun install into a mounted folder, and `npm ci` empties it without unmounting (E9). **Fails** R2: mounts are fixed at create (CB 33). **R7:** an empty mount point folder beside every package (CB 29), or the Mac's own install, hidden inside. **R8:** none beyond today. **R9:** one mount per package with dependencies (pnpm and Bun: every workspace package; npm: each with a conflicting version, E6). `fs.mount-max` ([kernel-fs]) is 100,000 on the VM; 2,000 propagated mounts took about 0.5 ms each, added about 65 ms to `docker exec` and 130 ms to container start, and pinned about 2 Mac descriptors each (L5). Today's 512 cap is pinata's own (CB 20); the lab gives no reason to keep it.

**Precedent.** VS Code, Compose and DDEV, all per known path.

### B. Mounts made on demand, reaching the container by propagation

**How.** The workspace bind gets `bind-propagation=rslave`. A root helper in the VM bind-mounts a VM-disk folder onto `<path>/node_modules` in the VM's namespace, and the mount appears in the running container. Docker documents `rslave` and defaults to `rprivate` ([docker-bind]); a slave mount receives mount events "from a (master) shared peer group" ([mount-ns]). Today pinata sets no propagation (CB 9).

**Lab.** The share's mount in the VM is already `shared`. A uid-1000 container with all capabilities dropped and an `rslave` root bind saw a mount the VM's root made after start; one with default propagation did not. 20,000 files written into the mount cost the Mac 0 descriptors, against +20,201 in a plain shared folder, and the Mac saw an empty folder (L1).

| Trigger | Synchronous? | Covers | Verdict |
|---|---|---|---|
| Shims for `npm`, `pnpm`, `yarn`, `bun`, `npx` | Yes | Only calls through the shim. Misses Vite's `.vite`, absolute paths, `corepack`. | Partial |
| Watch inside the VM | No | inotify needs a watch per folder, a walk through the share. fanotify directory events need file handles, and FUSE filesystems with a zero fsid "return ENODEV" ([fanotify-mark]); virtio-fs is FUSE-based. Not run in the lab. | Fails R5, likely fails outright |
| FSEvents on the Mac, for a new `package.json` or `node_modules` | No | Every creation, Mac or container: container writes through the share fire FSEvents 9 to 12 ms later (L4), Mac writes 4 to 53 ms (E10). | Recommended |
| seccomp user notification on `mkdir`, `mkdirat` | Yes | Every folder the container creates by `mkdir`, not by `rename`. | Works (L6). Strict mode only |

**The FSEvents trigger.** A `package.json` almost always appears before the install that needs the mount: a clone, a `git worktree add` (722 ms for 3,021 files, L2), `npm init` or a new workspace package write it first. The launcher creates the mount point (CB 29) and asks the helper to mount. It gives up a synchronous guarantee: an install starting within the event latency plus request and mount time writes its first files to the Mac. The parts are measured (about 10 ms, L4; 0.5 ms, L5), the end-to-end latency is not.

**An install mounted over midway** (inferred). Lookups after the mount reach the empty volume, while the installer's open descriptors and cwd in the old folder still write to the share, as after the lazy unmount in L1. The install ends split between the Mac and the volume. So the helper mounts only over a missing or empty `node_modules`. A non-empty one that appears unmounted is a leak already made: the launcher reports it, and the next launch overlays it once the user reinstalls.

**The seccomp trap.** Docker passes `listenerPath` from a seccomp profile to runc ([moby-seccomp]). runc supports `SCMP_ACT_NOTIFY` from 1.1 and refuses it on `write` ([runc-seccomp]). Docker's default profile blocks io_uring, so it is no side door ([docker-seccomp], [moby-47532]). In the lab, Docker 29.5.2 with runc 1.3.5 accepted it, a uid-1000 container with no capabilities ran `mkdir -p` to rc 0, and the listener saw each component as `mkdirat` relative to a dirfd, at about 16 µs per call with a `CONTINUE` reply (L6). For a final component `node_modules` the supervisor does the work itself (`mkdir`, mount, `chown` to uid 1000) and replies success; otherwise `CONTINUE`, after which the target can change its arguments, and the mechanism "must not be used to make security policy decisions" ([seccomp-unotify]). Incus intercepts `mount` and `mknod` the same way ([incus-intercept]).

Its costs and failure modes:

- **The supervisor is a hard dependency of every `mkdir`.** If the listener dies, notified calls fail with ENOSYS ([seccomp-unotify]), so the container cannot create folders. The descriptor is handed over once, at container create (L6), so recovery means recreating the container. In the lab a stuck supervisor hung the next container's first `mkdir` for 3 minutes, and listeners did not notice their container's exit (L6).
- **A merged profile.** A trap profile with `defaultAction` ALLOW replaces Docker's default filter, so a real one must merge the trap into Docker's default list (L6). Today's spec has none (CB 63).
- **A native helper** in the VM (static C in the lab, L6), and **every `mkdir` pays**, Maven and Gradle builds included; one `node_modules` holds 1,910 folders (E11). The cost on a real `npm ci` is not measured.
- **`rename`.** A `node_modules` made by renaming a staged folder already holds its contents on the share, and mounting over it hides them. Whether npm, pnpm or Bun use `mkdir` or `rename` is not verified (L6, "Not run").

**Meets**, with either trigger, R1, R3, R4, R5, R6 and R10 (E9). R2: the trap meets it for `mkdir`; FSEvents except within the race.

### Hazards common to mounts under the root

- **Unmounting.** In the VM, `umount` fails "target is busy" while a container process has its cwd inside, and `umount -l` succeeds but leaves that process on the old tree (L1). In the container, `rm -rf node_modules` empties the mount, then fails "Resource busy" (L1, E9, [docker-ebusy]).
- **Subagent worktrees.** With a mount at `<worktree>/node_modules`, `git worktree remove --force` failed with "Resource busy", dropped the worktree's metadata anyway and left an orphan folder (L2). The subagents extension runs `remove` without `--force` (CB 56); an ignored `node_modules` does not make a worktree unclean, so the same failure is expected (inferred). Two ways out, for the owner to choose:
  - Unmount before removal. Removal runs in the container (CB 56), so this needs a request channel from the sandbox to the root helper (inferred), and a process left inside makes the unmount fail busy or, lazily, stay on the old tree (L1).
  - Keep the whole `<repo>/.pi/worktrees` on a VM-disk volume: checkouts and their dependencies never touch the share, and removal deletes a subfolder of the volume (inferred, not tested). The Mac no longer sees subagent checkouts, and `git worktree prune` on the Mac deletes the record of a worktree it cannot see (PA 32).
- **A parent deleted on the Mac** probably leaves its mounts in the VM, on a folder that no longer exists (inferred). The helper must reconcile on deletion events and at launch.

### The helper as a trust point

Today pinata's only root command in the VM is fixed, `sudo sysctl -q -w vm.drop_caches=2`, with no input from the folder, the config or the container (`launcher/THREAT-MODEL.md`). Mounts on demand put a root helper on paths the agent can change: it can swap a folder for a symbolic link between request and mount and steer the mount to a VM path of its choosing, and with the trap the path comes from untrusted tracee memory ([seccomp-unotify]). The requirement (inferred): requests come only from the pinata process on the Mac, as a root-relative path ending in `node_modules`; the helper resolves it from a descriptor of the root with `openat2` and `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS`, refuses to cross another mount, and mounts onto that descriptor, never a path string; the source is a VM-disk folder named from a hash of the path. THREAT-MODEL gains it as a root component with these controls.

### C. A filter filesystem between the share and the container

**How.** A FUSE passthrough of pinata's own, over the virtio-fs mount in the VM, maps every component named `node_modules` to VM disk.

**Meets** R1 to R3 synchronously, even against a hostile agent. **Costs.** A daemon in the path of every source operation. FUSE passthrough covers `read`, `write`, `splice` and `mmap` and needs `CAP_SYS_ADMIN` ([fuse-passthrough]); lookups, `stat` and `readdir`, which dominate `git status`, still go through the daemon (inferred). It does nothing for R4 on sources, since the daemon keeps the virtio-fs inodes alive (inferred). A root daemon parsing agent-controlled names. `index.lock` and timestamp semantics untested. No precedent found.

**overlayfs** with a VM-disk upper layer sends every write there, which breaks the live share. **mergerfs** picks a branch by free space or existence, not by name (inferred). Both dropped.

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

In strict mode the trap can return `EPERM` when the helper cannot mount, so nothing leaks silently. AppArmor globs such as `deny <root>/**/node_modules/ w,` could refuse without a daemon; Colima's Docker lists `apparmor` in one user report ([colima-1019]); its mediation of `mkdir` on virtio-fs is not verified (not run in the lab). fanotify permission events cover open and access only ([fanotify-mark]). A refusal alone means a failed install, so it suits only as a fallback.

### F. Not sharing live (synced copies)

Attempt 1 leaves `node_modules` and `target` unsynced on each side by a name list at any depth, tracked folders exempted, at the cost of a rebuild after `pinata restart` (PA 12 to 16). Attempt 2 rates volumes over subfolders "useful, not a bound" (PA 17 to 19). A sync's ignore list covers any depth from the first second: R1 and R2 for free.

### G. Other ecosystems

| Ecosystem | Moves out of the tree by environment? |
|---|---|
| Rust `target` | Yes: `CARGO_TARGET_DIR` ([cargo-env]). |
| Python `__pycache__` | Yes: `PYTHONPYCACHEPREFIX`, 3.8 and later ([python-cmdline]). |
| Python `.venv` (uv) | Yes: `UV_PROJECT_ENVIRONMENT`, 0.4.4 and later ([uv-env]). |
| Gradle `.gradle` | Yes, by flag: `--project-cache-dir`. `build/` has no flag or variable ([gradle-cli]). |
| Maven `target/` | No switch found. Overlaying it breaks `mvn clean` with EBUSY (CB 14). |
| npm `node_modules` | No. Node resolves by walking up the folders (inferred from [node-esm]), and npm refuses links (E1). |

Rust and Python can be handled by a variable in the container. JavaScript cannot, which is why `node_modules` needs mounts.

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

## Fit for pinata

### Ranking

1. **A over the whole root, plus B triggered by FSEvents**, as in [Recommended design](#recommended-design). Meets R1, R3 to R6 and R10, and R2 except for an install that races its own `package.json`.
2. **The same plus the seccomp trap as an optional strict mode**, with E's `EPERM` as fallback. It closes the race and works (L6). Costs: the supervisor in front of every `mkdir`, a merged profile, a native helper, paths read from tracee memory (B).
3. **C, a FUSE filter.** The strongest guarantee, but every source operation pays, descriptors are not fixed, and it adds the most trust surface.
4. **D, package-manager settings.** Per repository, and npm has nothing.
5. **Symlinks.** npm removes them, and they dangle on the Mac.
6. **overlayfs, mergerfs, in-VM watches.** They do not fit.

The root walk alone, with mounts at create and no `rslave`, is the first step of 1 and can ship by itself: a change of scan scope, failing only R2.

*Owner's decision, 2026-11-27:* that first step was at first the only one to be built, as an interim step until the code moves into the VM. *Superseded the same day:* the owner removed the walk altogether, for the root and the launch repository, and `mounts.autoOverlays` with it; the removal is track B of [plan.md](../plan.md#track-b-removal-of-the-build-output-overlays). The rest of 1 and all of 2 are not to be built, because they need a root helper in the VM or a supervisor in front of every `mkdir`, and the code in the VM replaces them. The ranking and the design below stay as the record of what was found. See the [Decision](../README.md#decision) section of the README.

### Why the first is the more elegant

| | 1. Static + FSEvents | 2. Plus seccomp trap | 3. FUSE filter |
|---|---|---|---|
| Adds | One mount option, one Mac watcher, a VM helper that mounts on request | All of 1, plus a listener, a merged profile, a native binary | A filesystem daemon |
| Builds on | Today's Mac-side scan, per-path volumes and mount points (CB 11 to 30), and a Mac-side watcher loop like the file-cache watch (CB 59) | The same | Nothing pinata has |
| In the path of normal work | Nothing | Every `mkdir` | Every source operation |
| Failure mode | A late mount: an install's first files reach the Mac, visible and recoverable | A container that cannot create folders (ENOSYS or a hang), fixed by recreating it | Sources unreachable |

Design 1 adds the least and fails the softest: it extends the launcher's own pattern, a native scan feeding per-path volumes, in time, with a watcher of a kind it already runs. Design 2 buys the last milliseconds with a root daemon in front of every `mkdir`, whose worst case is far worse than the leak it prevents. Neither is a security boundary, so the softer failure wins.

### Recommended design

At launch the launcher walks the whole `workspaceRoot` on the Mac without entering `.git`, `.pi` or `node_modules`, and finds every folder with a `package.json` or node lockfile. Except where `node_modules` is tracked, each gets a VM-disk volume over `<dir>/node_modules`, keyed and labelled as today and persisting across launches, with the 512 cap lifted (L5). The root bind gets `rslave`. While pi runs, a recursive FSEvents watch on the Mac sees new `package.json` files and `node_modules` folders; the launcher creates the mount point and asks the VM helper to mount a volume, only over a missing or empty folder. Strict mode, off by default, adds the trap.

*Note, 2026-11-27:* the code differs from this paragraph. Its rule is a node lockfile in the folder, or a `package.json` below a lockfile in the same repository (at most 256 per repository), not every `package.json`; it has no exception for tracked `node_modules`; and the same walk overlays `.venv`, `target` and `.gradle` beside their markers. The plan recommended keeping the code's rule; since the owner's later decision the same day the code's walk is removed instead ([plan.md](../plan.md#track-b-removal-of-the-build-output-overlays)).

### What it changes in the launcher

- The overlay scan: whole root, beside every `package.json` or lockfile, tracked folders excepted (*2026-11-27:* the code's rule differs, see the note above), without the per-repository caps and the 512 cap (CB 13, 19, 20). *2026-11-27:* not to be made; the owner removed the scan instead.
- `container-body.ts`: `BindOptions.Propagation: "rslave"` on the root bind (CB 9); in strict mode, the merged profile in `SecurityOpt`.
- A VM helper under the rules of [The helper as a trust point](#the-helper-as-a-trust-point), with root in the VM, which pinata already uses (CB 59).
- The FSEvents watcher in the pinata process. Mount points are recorded as today (CB 29), and the helper's mounts are removed at the end of the last launch.
- A decision on subagent worktrees.
- Docs: `launcher/` README, ARCHITECTURE, STRUCTURE, THREAT-MODEL and CONFIGURATION, and the root docs. THREAT-MODEL keeps "a convenience, not a security control" (CB 34).

### What it costs

- A root helper in the VM acting on paths the agent can change.
- One mount per package with dependencies, possibly thousands with pnpm workspaces (E6), each about 2 Mac descriptors (L5), and an empty `node_modules` on the Mac beside every package while pinata runs (CB 29).
- Volumes on VM disk, lost on `pinata restart`. Two installs per project, one per OS, if the IDE needs dependencies.

### What breaks or stays open

- The hazards above: busy unmounts and `rm -rf` (L1, E9), worktree removal (L2), orphan mounts, and the race with a split install (inferred).
- A shared lockfile can lose other platforms' optional packages ([npm-4828]); Linux installs should use `npm ci`.
- `.next`, `dist`, `.turbo`, `.angular` stay shared unless the list grows. Maven `target/` cannot be overlaid (CB 14).
- A hostile agent can still put Linux files on the Mac under any name.

## Not verified, to measure on the VM

Propagation, descriptor cost, FSEvents for guest writes, mount scale, `listenerPath` and the per-call trap cost ran in the lab (L1, L4 to L6). Still open:

| Claim | Check |
|---|---|
| End-to-end latency, `package.json` written in the container to mount visible there | Timestamp the write, the FSEvents callback, the helper's reply and `findmnt` in the container. |
| What an install mounted over midway leaves | Mount over `node_modules` 100 ms into `npm ci`; compare Mac folder, volume and `npm ls`. |
| npm, pnpm, Bun create `node_modules` by `mkdir`, not `rename` | `strace -f -e trace=mkdir,mkdirat,rename,renameat2 <pm> install` in the container. |
| Trap cost on a real install | `time npm ci`, 20,000 files, trapped (merged profile) and untrapped. |
| Walk time on the real workspace | `time find <root> \( -name .git -o -name .pi -o -name node_modules \) -prune -o -name package.json -print`, cold and warm. *Correction, 2026-11-27:* this counts `package.json` files, not the code's directories walked or its overlays; it has no `-type f`, matches `.git` case-sensitively, does not skip folders whose marker sits beside them and prints to the terminal while timed. Tested commands and the code's own scan, kept for the record and not needed since the walk is removed: [below](#2026-11-27-measurement-commands-kept-for-the-record). |
| Worktree removal | L2 without `--force`, then with `.pi/worktrees` on a volume. |
| Orphan mount after a Mac-side delete | Mount at `r/node_modules`, `rm -rf r` on the Mac, `findmnt` in the VM and container. |
| fanotify on virtio-fs | `fanotify_mark(FAN_MARK_FILESYSTEM, FAN_CREATE\|FAN_ONDIR)` with `FAN_REPORT_FID`. Expect ENODEV. |
| AppArmor refusal | `deny <root>/**/node_modules/ w,`, `--security-opt apparmor=<name>`, then `mkdir`. |

## 2026-11-27: measurement commands, kept for the record

Moved here from [plan.md](../plan.md) on 2026-11-27. They counted what step 1's walk of the whole root would visit, to feed its gate. The owner then removed the walk and `mounts.autoOverlays` ([README.md](../README.md#decision)), so they are not needed and are kept only as the record of how the count would have been taken.

Run on the Mac, in zsh or sh; nothing is written. Replace the path in the first line with the configured `workspaceRoot`. The counts follow the code's walk: it does not enter a `.git` of any letter case, `.pi`, `node_modules`, or a folder whose marker sits beside it (`target` beside `Cargo.lock`, `.venv` beside `uv.lock`, `poetry.lock` or `Pipfile.lock`, `.gradle` beside `settings.gradle` or `settings.gradle.kts`), and it does not follow symbolic links.

```
ROOT=/path/to/workspaceRoot
sh -c '
cd "$1" || exit 1
walk() {
  find . \( -iname .git -o -name .pi -o -name node_modules \
    -o -name target -exec test -e {}/../Cargo.lock \; \
    -o -name .venv \( -exec test -e {}/../uv.lock \; -o -exec test -e {}/../poetry.lock \; -o -exec test -e {}/../Pipfile.lock \; \) \
    -o -name .gradle \( -exec test -e {}/../settings.gradle \; -o -exec test -e {}/../settings.gradle.kts \; \) \
    \) -prune -o "$@"
}
echo "directories walked: $(walk -type d -print | wc -l)"
echo "target folders beside pom.xml: $(walk -type d -name target -exec test -e {}/../pom.xml \; -print | wc -l)"
echo "directories in them: $(walk -type d -name target -exec test -e {}/../pom.xml \; -exec find {} \( -iname .git -o -name .pi -o -name node_modules \) -prune -o -type d -print \; | wc -l)"
echo "folders with a node lockfile: $(walk -type f \( -name package-lock.json -o -name npm-shrinkwrap.json -o -name pnpm-lock.yaml -o -name yarn.lock -o -name bun.lock -o -name bun.lockb \) -print | sed "s|/[^/]*\$||" | sort -u | wc -l)"
echo "package.json files: $(walk -type f -name package.json -print | wc -l)"
echo "repositories: $(find . \( -name .pi -o -name node_modules \) -prune -o -iname .git -print -prune | wc -l)"
echo "node_modules folders on disk, by top-level folder:"
find . \( -iname .git -o -name .pi \) -prune -o -type d -name node_modules -print -prune | cut -d/ -f2 | sort | uniq -c
' sh "$ROOT"
```

The exact overlay count and the walk time, by the code's own scan with no budget limit. For an npm-installed pinata:

```
BIN="$(dirname "$(realpath "$(command -v pinata)")")"
SCAN="$BIN/../dist/workspace/overlay-scan.js"
node -e 'const [, file, root] = process.argv; import(file).then(async (m) => { const t = performance.now(); const r = await m.scanOverlays(root, 1e8); console.log(`ms ${Math.round(performance.now() - t)}, overlays ${r.overlays.length}, node_modules ${r.overlays.filter((p) => p.endsWith("/node_modules")).length}, truncated ${r.truncated}`); })' "$SCAN" "$ROOT"
```

From a checkout, set `SCAN="$BIN/../workspace/overlay-scan.ts"` instead (`dist/` there may be stale). The `.ts` file needs Node's type stripping, which pinata's own dev bins rely on; pinata's `engines` asks for Node 22.19 or later. Node refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is why the npm install uses the built `.js`. For cold numbers run `sudo purge` first; run the scan a second time for warm numbers.

Tested 2026-11-27 on macOS 27.2 with Node 26.10.0, in `/bin/sh`, `zsh -f`, an interactive zsh and `dash`, against a scratch tree of seven repositories: a `.git` folder, a `.git` file and a `.Git` folder; a `.pi/worktrees` checkout with a `package.json` and a `node_modules`; nested `node_modules`; `target` beside `Cargo.lock` and beside two `pom.xml`; a `.venv` beside `uv.lock`; a `.gradle` without its marker; three node lockfiles; a nested repository. Every count matched the hand count: 37 directories walked, 2 `target` folders beside `pom.xml` holding 6 directories, 3 lockfile folders, 9 `package.json` files, 7 repositories, `node_modules` on disk 2 and 1. The scan printed 9 overlays, 7 of them `node_modules`, the same list as worked out by hand, from the checkout's `.ts`, its `dist/` `.js`, and both files copied under a scratch `lib/node_modules/` with a `bin/pinata` link pointing in, which is how the npm-install form was tested; on a real `npm install -g` it is untested. Node versions other than 26.10.0 are untested.

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
