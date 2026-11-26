# What pinata does today with `node_modules` and `.git`

This sheet describes commit 27749454 (branch `research/node-modules-and-git`). Paths are under `launcher/` unless they start with `extensions/`, `platform/` or `future-plans/`. "Inferred" marks a statement I derived and did not read.

## A. Mounts

1. The agent container gets its mounts from `buildContainerSpec` (`container/spec.ts:253-283`), in this order.
2. The workspace root is a read-write bind with the same path as source and target, one mount (`container/spec.ts:254`). It comes from the Mac through the virtio-fs share (`backend/colima/profile.ts:25` creates the VM with `--mount-type virtiofs`).
3. The host session dir is a read-write bind at its host path, while `sessions.host` is on (`container/spec.ts:119-123`, `container/spec.ts:254`). It also comes through the share (`<agent dir>/sessions`, `ARCHITECTURE.md:56`).
4. The render dir is a read-only bind at `/opt/pinata` (`container/spec.ts:174-176`). It is `<state>/vm`, shared read-only (`ARCHITECTURE.md:56`).
5. The agent volume `pinata-agent-<install id>` is a named volume at `~/.pi/agent`, one per install, on the VM's disk (`container/volumes.ts:76-81`, `ARCHITECTURE.md:165`).
6. Each overlay is a named volume `pinata-cache-<install id>-<h12>-<8 hex>` at the overlay path, on the VM's disk (`container/volumes.ts:35-40`, `ARCHITECTURE.md:165`).
7. Each `mounts.binds` entry is a read-only bind of a Mac path (`container/spec.ts:256`). Each `mounts.volumes` entry is a named volume `pinata-shared-<install id>-<8 hex>` on the VM's disk, shared by every folder (`container/volumes.ts:60-72`, `CONFIGURATION.md:218-222`).
8. `/tmp` and `/home/pi` are tmpfs in memory, and the root filesystem is read-only (`container/spec.ts:297-298`).
9. Mounts are passed to Docker as `HostConfig.Mounts` with only type, source, target and read-only set (`backend/colima/container-body.ts:30-35`, `:82`). No propagation or bind options are set (read from the code, so Docker's defaults apply: inferred).
10. Service and pod containers mount only named volumes (`container/services.ts:70`, `:124`, `:142`).

## B. Overlays of build output and dependencies

### Mechanism and names
11. The config key is `mounts.autoOverlays`, default `true` (`config/defaults.ts:24`, `CONFIGURATION.md:67`). The search is `scanOverlays` in `workspace/overlay-scan.ts:95`.
12. These folders are overlaid when a marker file sits in the same folder (`workspace/overlay-markers.ts:1-22`, `CONFIGURATION.md:188-197`).
    - `node_modules`: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`.
    - `.venv`: `uv.lock`, `poetry.lock`, `Pipfile.lock`.
    - `target`: `Cargo.lock`.
    - `.gradle`: `settings.gradle`, `settings.gradle.kts`.
13. A package folder with a `package.json` and no lockfile of its own, below a folder that has a node lockfile and above no `.git` boundary, also gets a `node_modules` overlay, at most 256 per repository (`workspace/overlay-scan.ts:9`, `:58-63`, `:73-91`).
14. Maven `target/` and Gradle `build/` are not overlaid; `mvn clean` fails with `EBUSY` on a volume (`CONFIGURATION.md:199`).
15. An existing `node_modules` that is a file or a symlink is not overlaid (`workspace/overlay-scan.ts:44-48`).

### Where and how it is found
16. The scan runs in the pinata process on the Mac, when the launch context opens (`cli/context.ts:77-80`, `workspace/discover.ts:73-77`). Discovery "reads files only; it runs no git and writes nothing" (`ARCHITECTURE.md:71`). It reads with `readdir` from `node:fs` (`workspace/overlay-scan.ts:37`). It does not run in the VM or container.
17. It walks the working tree of the launch repository, starting at the git root, level by level, listing each level's folders in parallel (`workspace/walk.ts:27`).
18. It never enters `.git` (any letter case), `.pi` or `node_modules`, nor a folder named as a marked overlay in a folder holding the marker (`workspace/overlay-scan.ts:11`, `:64-65`, `:67-74`). It does descend into nested repositories.
19. The budget is 50,000 directories listed (`workspace/overlay-scan.ts:7`, `workspace/walk.ts:18-24`). When it runs out, the result is truncated and no overlay is made, with a notice (`workspace/discover.ts:46-48`, `cli/launch-notices.ts:12-14`).
20. More than 512 overlays turn all overlays off, with a notice (`workspace/discover.ts:17`, `:50-52`, `cli/launch-notices.ts:9-11`).
21. A folder outside git is not scanned and gets no overlays, with a notice (`workspace/discover.ts:68-70`, `cli/launch-notices.ts:19-21`).
22. No time limit exists in the scan, and no document states its cost in time (searched `launcher/*.md` and the code; not found).

### Why only the launch repository
23. Docs state the rule, not a reason: "Only the repository pi starts in is searched, never the other projects in the workspace root" (`CONFIGURATION.md:199`; `ARCHITECTURE.md:74`).
24. The commit that introduced the one shared root says "Overlays are searched for the started project only" and gives no reason (`git show f7a62a98`, subject `feat(launcher)!: run every project from one shared workspace root`). The same commit removed the older "workspace mode" search for nested repositories, which had a cap of 128 repositories and 50,000 directories (`git show f7a62a98 -- launcher/REMOVED-DEFAULTS.md`). The reason for the launch-repository limit is not stated.

### What backs an overlay
25. An overlay is a named volume per repository-relative folder, labelled with the repository hash, root and cache path (`container/volumes.ts:35-40`, `container/names.ts:13`). It is shared by every container of that repository (`ARCHITECTURE.md:163`).
26. Before each container is created, volumes of the same repository that carry a cache path, are unused and are not in this launch's plan are removed (`container/lifecycle.ts:306-325`).
27. A daily collection removes overlay volumes that are unused and whose repository root is gone. `pinata restart` and uninstall delete the VM with every volume (`ARCHITECTURE.md:275`; `CONFIGURATION.md:201`).
28. The volume starts empty. The Mac copy is hidden and the user runs the install command inside (`CONFIGURATION.md:197`).
29. Mount point folders are created on the Mac, as the host user, in the writable root, one level at a time after real-path checks, and recorded in `created.json` (`container/lifecycle.ts:89-122`, `:134-146`, `:333`). They are removed when empty at the last launch's end (`cli/sweep.ts:89-98`, `ARCHITECTURE.md:270`). `CONFIGURATION.md:201` says the same.
30. A root exec as root with only the `CHOWN` capability hands overlay targets to the sandbox user after start (`container/lifecycle.ts:184-192`, `:222-239`, `container/spec.ts:26`).

### What the container sees outside the overlays
31. For a `node_modules` in another repository under the root, the container sees the Mac's own copy through the root bind, live. No overlay exists for it (inferred from `container/spec.ts:254` and the scan scope in item 23). The docs state that every project's files and sibling `node_modules` are writable (`THREAT-MODEL.md:41`, `:156`).
32. `npm install` there writes into the Mac's folder through the share, and it can write Linux-built native modules there (inferred from item 31).
33. A `node_modules` created in the launch repository after the container started has no overlay, because mounts are fixed at create (`container/lifecycle.ts:325-336`; inferred). It is written to the Mac. `THREAT-MODEL.md:161` says only "With `mounts.autoOverlays` on, the host's and the sandbox's build output diverge."
34. `THREAT-MODEL.md:82` states the overlay "is a convenience, not a security control" and that it keeps the sandbox from writing into the host's `node_modules` only at overlaid paths. It says overlays are made only for the launch folder's repository.
35. A launch cwd hidden by an overlay prints a notice, and pi starts in the root (`ARCHITECTURE.md:62`). `visibleInside` treats a path as host-visible only when its deepest mount is a bind with source equal to target (`container/host-paths.ts:13-17`).

### Config to add or remove
36. `mounts.autoOverlays` is the only switch for overlays, all or none (`config/validate.ts:785`, `CONFIGURATION.md:67`). No key adds or removes one overlay.
37. `mounts.volumes` adds named volumes, never per repository. `mounts.binds` adds read-only binds. A target inside, or above, the launch folder, its git dirs, an overlay or the session folder is refused (`CONFIGURATION.md:262`). So a configured volume cannot be placed at a `node_modules` of the launch repository.
38. A `mounts.volumes` target inside the root gets its mount point created on the Mac like an overlay (`ARCHITECTURE.md:270`).

## C. git

### How `.git` reaches the container
39. `.git` arrives through the root bind, read-write, like every file under the root (`ARCHITECTURE.md:165`; `THREAT-MODEL.md:41`). No read-only bind is placed inside the root (`THREAT-MODEL.md:41`).
40. Hooks, `.git/config` (`core.hooksPath`, `core.fsmonitor`, aliases, includes), worktree pointers, `objects/info/alternates` and nested repositories are writable, and nothing is recorded or reported (`THREAT-MODEL.md:41`, `:156`).
41. History: commits 225299b3 to 442ca26f built a "git overlay" that pinned `.git/commondir`, snapshotted hooks and config and bound them read-only. `f7a62a98` removed it: "Git validation and the read-only git protections are removed: the root holds the user's own repositories." (`git show 3ee46d28`, `git show f7a62a98`; `git show f7a62a98 -- launcher/REMOVED-DEFAULTS.md` lists the removed rows).

### The refusal rule
42. A launch is refused when the git dir or common dir is outside the workspace root: `git: the git dir <dir> of <repo> is outside the workspace root (workspaceRoot: <root>)`, hint "the sandbox mounts only the workspace root, so git would not work there" (`workspace/roots.ts:174-179`, `:199-206`).
43. Listed cases: a worktree whose main `.git` is outside (`CONFIGURATION.md:439`), and a separate git dir or submodule dir outside (the tests cover them: `tests/workspace/discover.test.ts:65-86`).
44. Discovery reads `.git`, a `gitdir:` line and `commondir` from files and resolves them; nothing confirms the layout with git (`workspace/git/layout.ts:32-48`, `ARCHITECTURE.md:73`, `THREAT-MODEL.md:40`, `:159`).
45. `--no-sandbox` checks only that the repository is inside the root (`CONFIGURATION.md:439`).

### git configuration inside the container
46. Pinata renders `tools/gitconfig` with `[user]` name and email, and for each glab host a `[credential "https://<host>"]` helper `!glab auth git-credential` plus `insteadOf` rewrites of `git@host:` and `ssh://git@host/` (`provision/render.ts:142-165`, `:184`). The entrypoint copies it to `~/.gitconfig`, mode 0644, a writable copy (`image/entrypoint.sh:111`, `THREAT-MODEL.md:26`).
47. The identity is read on the Mac with `git config --global --get-regexp` using an absolute `git` outside the root, `core.fsmonitor=false` and `core.hooksPath=/dev/null` (`hostpi/tools/git.ts:7`, `:21-30`; `ARCHITECTURE.md:126`).
48. Environment: `GIT_SSL_CAINFO` (the CA bundle) and `GIT_TERMINAL_PROMPT=0` (`container/spec.ts:139-140`), and the proxy variables `HTTPS_PROXY` and others (`container/spec.ts:98`). The user's config can set `GIT_CONFIG_COUNT` and the like through `env.set` (`CONFIGURATION.md:726-745`).
49. `safe.directory` is not set anywhere in `launcher/` (grep for `safe.directory` and `dubious` found nothing outside `future-plans/`). `future-plans/synced-workspace/attempt-1-architecture.md:66` proposes it for another design.
50. Fetch and push go over HTTPS through the proxy. The container holds only placeholders and the proxy substitutes the real token on the Mac (`CONFIGURATION.md:491-493`). Without a glab host or rule, plain HTTPS git to github.com has no credential, and SSH remotes fail because the sandbox has no SSH keys (`CONFIGURATION.md:694`).
51. The image installs `git` (`image/Dockerfile:10`).

### THREAT-MODEL sentences on git
52. "The agent can write every file of every project under the root: `.git/hooks`, `.git/config` (`core.hooksPath`, `core.fsmonitor`, aliases, includes), sibling projects' `node_modules` and package scripts ... Host git and host tools run what it wrote there with the developer's rights. This is accepted because the root holds only the user's projects ... git changes are not recorded or reported, and nothing is checked after the session." (`THREAT-MODEL.md:41`)
53. "Host git: the hooks and config host git runs in repositories outside the workspace root." is listed as an asset (`THREAT-MODEL.md:10`).
54. Known gaps: hooks, config, worktree pointers, nested repositories, gitlinks and alternates are changeable and unreported (`:156`); a token in a remote URL is readable inside (`:157`); the layout is not confirmed by git and a rewritten `.git` file or `commondir` points the next launch elsewhere inside the root (`:159`); pinata resolves `glab` and `git` outside the root (`:160`).

### Where `git` is spawned
55. `hostpi/tools/git.ts:21-30`: `git config --global ...` on the Mac, at launch, for the identity.
56. `extensions/subagents/core/run-agent/worktree.ts:17`: `execFile("git", ["-C", cwd, ...])`. It runs inside whatever machine runs pi: in the container when pi runs under pinata, on the Mac with `--no-sandbox` (inferred, since the extension runs in pi's process). The commands are `rev-parse HEAD --show-prefix`, `worktree add -b pi-agents/<id>-<stamp> <path> <base>`, `worktree remove <path>` (no `--force`), `rev-parse <branch>` and `branch -D` only if the branch still points at the base (`worktree.ts:37-80`). It removes `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_PREFIX` from the environment (`worktree.ts:10-13`).
57. No other `git` spawn exists in `launcher/`, `extensions/` or `platform/` outside tests (grep for `"git"`). pi itself, not pinata, runs git for git packages and its footer watches the branch (inferred; `extensions/footer/ARCHITECTURE.md:11`).
58. `worktree: true` creates `<cwd>/.pi/worktrees/` with `ensureProjectSubdir` and a `.gitignore` of `*` (`extensions/subagents/ARCHITECTURE.md:99`). The checkout is under the root, and `git worktree add` writes `.git/worktrees/<name>` and a branch ref in the common dir (inferred from git). So it needs `.git` writable in the container. Removal runs at the agent's end; a killed pi leaves the checkout and branch (`future-plans/workflow-mechanics/worktrees.md:14`). The shipped agents all say `worktree: false` (`extensions/subagents/agents/*/*.md:9`).

### Slow git, locks, the share
59. The docs for `launcher/` do not mention `index.lock`, slow git or git over the share (grep found none). `CONFIGURATION.md:380` and `ARCHITECTURE.md:62` describe the open-file watch, which drops the VM's cache (`sudo sysctl -q -w vm.drop_caches=2`) while pi runs. Measurements of `git status` on the share are only in `future-plans/synced-workspace/`.

## D. Other constraints

60. `writableRootOf` finds one writable bind whose source equals its target and in which the mount lies. It creates mount points only inside it (`container/lifecycle.ts:124-146`). A volume target outside such a bind gets no mount point created (inferred).
61. `visibleInside` assumes host paths equal guest paths for the root bind (`container/host-paths.ts:13-17`). `workdir` is the host repository root (`container/spec.ts:296`). Pi flags naming host files pass unchanged (`ARCHITECTURE.md:62`).
62. `checkConfigMounts` refuses a configured target that nests with any other mount (`container/spec.ts:234-249`). `checkMountTable` refuses a double mount and a reserved path (`:211-232`).
63. Capabilities: all dropped except `CHOWN`, `no-new-privileges`, pids limit; pi runs as uid 1000 (`backend/colima/container-body.ts:57-62`, `container/spec.ts:26`, `image/Dockerfile:16`, `:56`, `ARCHITECTURE.md:165`). The container has no capability to mount (`CAP_SYS_ADMIN` is dropped; inferred). Root exists only for pinata's `chown` execs (`container/lifecycle.ts:188-192`).
64. Docker Engine 28.0 or later is required, for the network's gateway mode (`backend/colima/networks.ts:10-22`). No other Docker version check was found for mounts.
65. Colima must have `vz` and `virtiofs`; the VM shares exactly the root, the sessions dir, `<state>/vm` and bind folders, and shares cannot nest (`backend/colima/profile.ts:25`, `cli/vm.ts`, `CONFIGURATION.md:231-236`, `:440-441`). A new share restarts the VM (`CONFIGURATION.md:236`).
66. Mount points under the root are created as the host user, and `created.json` removal assumes they are empty (`ARCHITECTURE.md:270`).
