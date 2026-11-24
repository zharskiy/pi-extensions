# Synced workspace: research progress

Tracks the investigation into "Too many open files" on the host while the sandbox VM runs, and the research toward keeping the workspace on the VM's disk instead of sharing it live.

Status: **research finished 2026-11-24, nothing implemented.** The plan is [architecture.md](architecture.md). Implementation starts only when asked.

Last updated: 2026-11-24.

## Goal

A very large backend monorepo (more than 1,000 Maven modules) plus dozens of frontend repositories under one `workspaceRoot` must be usable in the sandbox without exhausting the host's open files, and without the `node_modules` scan.

## Constraints

- Simple: cover only what must be covered, no over-engineering.
- Architecture is planned before any implementation.
- No legacy VM support and no backwards compatibility (pinata has no users yet).
- Later, possibly: code lives only in the VM ("detached"). The design must not block it; it is not built now.
- Everything the spike creates is removed when the research ends.

## Established so far (measured unless marked)

| # | Finding |
| --- | --- |
| 1 | Cause: Apple's virtiofs server in the VM process keeps about one host open file per inode the Linux guest has cached (a lookup is enough). It lets go only when the guest forgets the inode. Apple exposes no setting. |
| 2 | One VM limits itself near 55,000 open files (it recycles before `kern.maxfilesperproc` = 61,440) with no guest errors. The host fails when the system-wide table (`kern.maxfiles` = 122,880 by default at 16 GB) fills. Inferred: two sharing VMs plus the baseline are enough. |
| 3 | `vm.drop_caches=2` in the guest releases almost everything within 2 s. Open files and inotify watches stay pinned. `vfs_cache_pressure` does nothing without memory pressure. |
| 4 | Pinata's file cache watch runs only while pi runs, ignores the system-wide count, never checks that a release helped and reports nothing. |
| 5 | `mounts.autoOverlays` covers the launch repository only, turns itself off past 50,000 directories or 512 overlays, and leaves Maven `target/`, `.git` and every other repository on the share. |
| 6 | The README's advice to raise both `kern.maxfiles` and `kern.maxfilesperproc` is counterproductive: raising the per-process limit lets the VM grow further. |
| 7 | Industry practice is to stop sharing large trees live: a copy on the VM's disk kept in sync (Docker Desktop synchronized file shares), a clone in a volume (dev containers), or a remote dev box. |
| 8 | One `.git` serving two byte-identical working trees works in a macOS-only simulation if the second side runs with `core.checkStat=minimal` and `core.trustctime=false` and the copy preserves modification times. Without preserved times both sides re-hash everything on every `git status`. |

## Direction under study

The workspace lives in a volume on the VM's disk, mounted in containers at the same path as on the Mac. A sync tool mirrors it both ways with the Mac copy; dependency and build folders stay on their own side. `.git` stays on the Mac only. The overlay scan goes away.

## Research round (started 2026-11-24)

| Stream | Question | Status |
| --- | --- | --- |
| S1 | Does one `.git` on the Mac work for macOS git and Linux git at once (index, config, locks, clocks, worktrees, the window before the mirror catches up)? | done: works, **with one serious hazard**, see below |
| S2 | Mutagen at 300,000 files: does it carry modification times, cost, latency, ignore rules, safety. | done: **fails**, see below |
| S3 | Unison at 300,000 files: same questions. | done: **passes**, with conditions, see below |
| R1 | What others who built this learned (DDEV, Docker Desktop, Okteto, DevSpace and others); other engines; security of syncing with a less trusted side. | done, see below |
| R3 | Syncthing as the engine (how Okteto embeds it, what it needs, what breaks). | done, see below |
| R2 | Git internals behind S1; how IntelliJ IDEA behaves when files change underneath it. | done, see below |
| C1 | What pinata assumes and promises about the workspace today, what a redesign must keep, what it can delete. | done, see below |
| R4 | Survey of popular GitHub projects: how agent sandboxes and dev tools get a local repository into a VM or container and back; other two-way sync tools; git-native mirroring; the IDE opening the VM copy. | done, see below |
| S4 | Can both Unison ends come from package managers (Debian `apt` in the image, Homebrew on the Mac) and work together; does pinata already have a container exec with attached input and output to carry the link. | done: works, except the watchers, see below |
| S5 | Linux-side watcher: Node `fs.watch` against Unison's own `unison-fsmonitor`, at 300,000 files; cost of building Unison from source in the image. | done: Unison's own watcher |
| S6 | How exposed today's layout (everything on the share) is to the rename hazard found by S1, whether `core.checkStat=minimal` and `core.trustctime=false` remove the background index rewrites there, a realistic 5-minute IDE-against-agent rate, and IDEA's default for optional locks. | done: settings help, hazard stays |
| S7 | End-to-end rehearsal of the composed design on a small tree: composition, deletion paths, conflict policies, stop, worktrees, ignore rules, review drills. | done: works with conditions |
| C2 | Pinata's launch structure for the plan (roots, shares, containers, helper rail, teardown order, notices, volumes, worktree code, exec rail). | done, see below |
| R5 | File-sharing layers that do not cost one host open file per file seen (libkrun/krunkit, 9p, sshfs, NFS, others), and reported workarounds for Apple's virtiofs. Could make the redesign unnecessary for the open-file problem. | done, see below |
| R6 | VM clock after the Mac sleeps (lima source, issue trackers, local offset). | done |
| R7 | Lima's built-in copy mode, `limactl shell --sync` (source read at 2.3.0, local attempt). | done: not usable here |
| C3 | Re-check of the plan and of C1/C2 against the head of PR 83. | done |
| C4 | Launcher rail facts for the plan's attachment points, read on `main` after PR 83 merged. | done |
| V1 | Independent review of draft 1 of the plan. | done: sound with changes |
| V2 | Second independent review, of draft 3, against the code on `main`. | done: sound with changes |
| A1 | Architecture plan: draft 4 in [architecture.md](architecture.md), written against `main` after PR 83, with both reviews and every measurement folded in. | done, awaiting the owner's decisions |

## Results of the research round

### S1: one `.git` used by macOS git and Linux git (measured, 40,001-file repository, Debian git 2.39.5)

- **Serious hazard, and it exists in pinata today.** When the Mac replaces a file in `.git` by rename (git does this to `index` and to branch files) and the container looked that name up within the last second, the container's open fails with "no such file" for 0.3 to 1.0 s. Linux git then acts as if there were no index or no commits.
  - Measured damage with a Mac `git status` loop against a container commit loop: commits with an empty tree; in another run `commit -am` committed the deletion of all 40,006 files. History stays recoverable (`fsck` clean).
  - With the Mac side not writing (`GIT_OPTIONAL_LOCKS=0`): 2,862 Mac statuses against 1,558 container commits, 0 errors.
  - So the condition for safety is: nothing on the Mac rewrites `.git` files within about a second of container git.
- **The layout works:** workspace in a volume, `.git` bound from the share inside it. Linux git is 20 times faster than today (cold `git status` 29 ms against 563 ms) and one cold status costs 20 host open files against 40,861.
- **Settings that stop background rewrites:** with `core.checkStat=minimal` and `core.trustctime=false` on **both** sides and timestamps kept by the mirror, a plain `git status` on either side never rewrites the index. With them on Linux only, the Mac rewrites the index once after every Linux `add` or checkout, which is the dangerous rename. Without kept timestamps the two sides re-hash the differing files on every status, forever.
- **Must stay off in shared config:** `core.untrackedCache`, `core.fsmonitor`, `feature.manyFiles` (each makes both sides rewrite the whole index on every status).
- **Ownership:** through the share the owner of `.git` shows as whoever touched it last in the VM, so Linux git sometimes refuses with "dubious ownership"; `safe.directory` fixes it. Pinata sets none today.
- **Locks are honoured across the two systems**; no stale lock was left. A Mac commit can fail with "index.lock: File exists" while container git holds it.
- **Before the mirror catches up** after a checkout, the other side sees the reverse diff. Nothing is lost unless someone runs `git add -A` in that window, which stages the revert.
- **Worktrees:** one made in the container at a path only the volume has works, but `git worktree prune` on the Mac deletes its record. `git worktree lock` protects it.
- **Clocks:** the guest ran 10 ms ahead. With the guest 1 to 3 s behind (simulated), a second same-size edit in the same second was missed 20 times out of 20.
- **Open files for `.git` over the share** are bounded by the number of files in `.git` (5,011 after `git log -p` on an unpacked repository, 909 once packed).
- Names: a name made on the Mac in decomposed Unicode form shows as renamed on Linux; with the Mac's `ignorecase=true` Linux git hides a file whose name differs only by case from a tracked one. Submodule `.git` files resolve through the shared `.git`.

### S2: Mutagen 0.18.1 (measured on the research machine, 300,007 files)

- **Fails the requirement.** A mirrored file never keeps the source file's modification time, in either direction, in any sync mode or setting tried; the wire format has no field for it. Mutagen is out for the single `.git` model.
- Other numbers, for comparison with the remaining engines: initial sync 113 s; about 650 MB of memory on each end; while idle the Linux end rescans the whole tree every 10 s (about 20% of one core, 670 MB); a blocking "sync now" takes 3 to 8 s on an idle tree; it reports success even with a conflict pending.
- It did not touch the shared folder: no host open files were caused by the sync itself.

### S3: Unison 2.54.0 (measured on the research machine, 300,010 files, 52,000 directories)

- **Passes the requirement.** With `times = true` a mirrored file carries the source file's modification time to the second in both directions (nanoseconds are dropped from the Mac to the volume, which git ignores by default).
- **Cheap when idle:** no CPU on either end over five minutes, about 180 to 200 MB of memory per end, 38,000 inotify watches in the guest, about 15 host open files. It never touched the shared folder.
- **Fast enough:** a single edit arrives in 0.6 s (volume to Mac) to 1.3 s (Mac to volume); 5,000 files at once in about 5 s; a blocking "sync now" on an idle tree takes 3 s; first full sync took 253 s while two other experiments ran.
- **Simple topology:** one client process on the Mac, talking to `unison -server` in a container through `docker exec -i`. No port, no keys, no daemon. Offline changes on either side are reconciled at the next run from its archive files (25 MB per end).
- **What is missing and would be ours to own:**
  - No macOS file watcher ships with Unison, so continuous mode fails on the Mac. A 40-line prototype speaking Unison's watcher protocol over FSEvents (Node `fs.watch`) made it work; all continuous numbers above use it.
  - No Linux arm64 binary is published; it was built from source (about 5 MB plus a 1.7 MB watcher).
  - The client exits when the other end dies and does not reconnect; a supervisor must restart it.
  - Status is human text; conflicts and skipped paths are learned from `skipped:` lines and exit code 1.
- **Behaviour to design around:**
  - A conflict (same file changed on both sides between passes) is skipped and left as is on both sides, every run, until resolved. `prefer` picks a winner; `copyonconflict` keeps the loser as a copy.
  - Patterns cannot tell a `.git` file from a `.git` directory.
  - Temporary files `.unison.<name>.<hash>.unison.tmp` appear briefly beside the target on the Mac.
  - Symlinks are copied as links and never followed, including links the sandbox points outside the root (the live share allows the same today).
  - Files made on the Linux side under names that collide on the Mac (`Foo` and `foo`) are skipped with an error.
  - Deleting most of a replica is refused by default.
  - A change that keeps size and modification second is not detected (same blind spot as git).

### S4: Unison from package managers (measured, Mac 2.54.0 against Debian bookworm's 2.52.1)

- **The two versions work together.** One-shot runs exit 0 with no version warning; 0 timestamp mismatches over 4,005 files in both directions; a conflict is skipped with exit 1 and both copies left alone.
- **Debian:** `apt-get install unison` gives 2.52.1 (5 MB, depends only on libc, arm64 and amd64). trixie has 2.53.7. **No Debian package contains the Linux file watcher.**
- **Homebrew:** `unison` 2.54.0, bottles for Apple silicon, no runtime dependencies, **no watcher on macOS**.
- **So continuous mode needs a watcher on each end from somewhere else.** Without the Linux one, `-repeat watch` fails at once ("No file monitoring helper program found"), it does not fall back. With the source-built Linux watcher copied in beside Debian's 2.52.1, continuous mode worked (about 1 s each way).
- Polling instead (`-repeat 2`) works but rescans both trees on every pass, which is the idle cost we are trying to avoid.
- **Pinata already has the channel parts:** container exec with attached input, raw stream and split of output and error streams over the engine socket (`launcher/backend/colima/exec-session.ts:20-257`, `engine-client.ts:276-290`). Missing is only a small local program that Unison starts as its "ssh command" and that connects its input and output to such an exec.
- Side effect on the research machine: reading the Homebrew formula with `brew cat` switched Homebrew's developer mode on. Undo with `brew developer off` (the owner's to run).

### R1: precedents and engines (paper study, sources read on 2026-11-24)

- **DDEV is the closest precedent and it works the same way:** Mutagen, code in a docker volume, the top-level `.git` kept on the host and bind-mounted into the container. It tells users to run large git operations on the host. Its documented pain: edits made while stopped go undetected until a reset, lag on branch switches and mass deletes, conflicts, doubled disk use, container writes taking up to 10 s to reach the host.
- **Mutagen does not carry modification times** and its maintainer declined to add it (issues 149 and 485). Last release February 2025; issues go unanswered. The spike still measures it.
- **Unison carries times** (`times`), but publishes no Linux arm64 binary and ships no macOS file watcher (a third-party one exists). Both ends should run the same release. Latest release 2.54.0, May 2026.
- **Syncthing** carries times and publishes binaries for both ends, but is a daemon with its own configuration and API. Okteto embeds it. Being studied (R3).
- Not candidates: rclone bisync (no watching), DevSpace sync (Kubernetes only), docker-sync (dormant).
- None of the tools documents a promise never to write outside the synced root. Syncthing had a symlink traversal vulnerability in 2017, fixed.
- Agent sandboxes that do not mirror files (Codex cloud, Claude Code on the web) return work as branches and give no live view in the local IDE; uncommitted local work does not reach them.

### R2: git internals and IDEA (paper study, git source read at master, about 2.56)

- **What git compares:** by default modification time in whole seconds, size, mode, plus change time, owner and inode. With `core.checkStat=minimal` only whole-second modification time and size. Nanoseconds are off by default (`core.useNanosec`).
- **Clock risk (inferred from source, being measured in S1):** git protects against same-second edits by comparing a file's time with the index file's time, assuming one clock stamps both. Here the host stamps the index and the guest stamps the container's files. If the guest clock runs behind the host, a second same-size edit within the same second can be missed. A guest clock ahead only costs re-hashing. No setting forces a content comparison. The guest clock must stay close to the host's.
- **Index features:** `core.fsmonitor` must stay off on a shared index. The untracked cache records the system name and path, so two systems rebuild it in turn (slower, index rewritten each time). Split index and `skipHash` are safe on git 2.40 or newer.
- **Config:** a Mac clone has `core.ignorecase=true`, which is wrong on Linux; the Linux side needs `false` through its environment. Git has no per-OS config condition, so environment variables are the least invasive way.
- **Locks:** `add`, `commit`, `checkout` take `index.lock` and fail at once if it exists (no retry for the index). A background `git status` takes it too unless `GIT_OPTIONAL_LOCKS=0`, which IDEA sets (registry default not verified).
- **Worktrees:** git records absolute paths; a worktree whose path exists on one side only looks prunable to the other (pruned after three months by `gc`) unless locked.
- **Trust boundary:** a `.git` the sandbox can write runs code on the Mac the next time git runs there (`hooks`, and `config` keys such as `core.fsmonitor`, `core.sshCommand`, filters, aliases). Other agent sandboxes make `.git/hooks` and `.git/config`, or all of `.git`, read-only. `safe.directory` does not help when both sides write as the same user.
- **What must cross can be asked from git:** `git ls-files` lists tracked files, untracked but not ignored files, and ignored paths. Cost at several hundred thousand files not established.
- **IDEA:** detects outside changes through its native watcher and reloads; a file with unsaved edits that changes on disk raises a "File Cache Conflict" dialog. It saves on focus loss, build, run and VCS actions. Its "safe write" creates `name~` beside the file for a moment, which a sync tool will see. Its own compiler writes to `out/`, Gradle to `build/`, Maven to `target/`.
- **JetBrains remote development** (needed if code ever lives only in the VM): gives no sizing figures beyond "add more CPUs and RAM"; the remote IDE needs a licence.

### R3: Syncthing as the engine (paper study, Okteto source and Syncthing docs)

- **It carries modification times** (seconds and nanoseconds are in its protocol; the receiver sets them), publishes binaries for both ends, releases every few weeks (2.1.7 in October 2026), never writes a file in place (temporary `.syncthing.<name>.tmp`, then rename) and keeps the losing side of a conflict as a `.sync-conflict` copy.
- **It needs a lot of machinery.** Two daemons, a generated `config.xml` and certificate each, a TCP connection between them (no stdio or unix socket transport), and a supervisor that polls their REST APIs. Okteto's package for this is roughly 2,000 lines and includes a "no progress for 90 seconds, reset the database" path, which shows they met stuck states.
- **Latency:** changes are collected for at least 1 s before a scan (10 s by default) and deletes wait longer. Under 2 s end to end is plausible but unproven.
- **Scale:** no official figures; forum reports of heavy memory and slow scans with millions of files on the 2.x database.
- **Security:** it rejects paths that leave the folder and never follows symlinks itself, but it recreates a symlink with whatever target the other side sent, so a link pointing outside the root can appear on the Mac for other programs to follow. No maintainer statement about untrusted peers.

### R4: survey of GitHub projects (repositories and docs read on 2026-11-24)

Nothing found replaces the design. What the field does:

- **Most agent runners avoid the question.** They give each agent a git worktree or branch (container-use, Sculptor, vibe-kanban, claude-squad) or a private clone (Docker Sandboxes "clone" and "mountless" modes), and work returns by branch. None of them shows uncommitted agent edits live in the local IDE.
- **The rest mount the folder live** (Docker Sandboxes "direct" mode over virtiofs, Lima wrappers), which is what pinata does today. None documents anything about large repositories or open files.
- **One project mirrors the way we plan to:** Imbue's `mngr pair` keeps an agent's directory and a local directory in step, both ways, continuously, with Unison (needs Unison 2.52 or newer and `unison-fsmonitor`). Its ideas are reusable, its code is not.
- **Lima has a one-shot variant:** `limactl shell --sync` copies the working directory into a VM without mounts using rsync and offers to copy changes back at the end. No live view.
- **Other two-way sync tools are dead or unfit:** gut (git-based, abandoned 2022), stephenh/mirror (dead), osync (no watch mode on macOS), lsyncd (one-way). No large company has published a laptop-to-dev-box sync tool.
- **Git-only live mirroring is not a trodden path.** Tools that commit on every change bloat history and miss untracked files.
- **The IDE opening the VM's copy over a network mount** is reported as slow and without change detection for IntelliJ IDEs.
- **Shrinking the tree** (sparse checkout of the monorepo by module) would help every approach but is the repository owner's call.

### R5: other file-sharing layers (source and issue trackers read on 2026-11-24)

- **libkrun/krunkit holds no open file per file seen** (read in its source, `src/devices/src/virtio/fs/macos/passthrough.rs`: it keeps an inode number and re-opens `/.vol/<dev>/<ino>` for each operation; its maintainer says the pile-up does not exist on macOS). Colima supports it since 0.10.0 (`--vm-type krunkit`). **Not measured by anyone on a tree this size.**
- **But it is experimental and has open bugs that matter here:** read-only shares are not enforced; a file the host replaces by rename (git does this to `HEAD` and the index) can read as missing in the guest for up to 5 s; data loss on restart and on stop is reported in colima and lima; one worker thread, slower than Apple's virtiofs in the one comparison found; no Rosetta.
- **It would fix only the open-file problem.** Per-OS dependency folders would still be shared, so the overlay scan would have to stay.
- QEMU 9p and reverse sshfs also hold no open file per file seen (9p read in source, sshfs inferred) but are slower and have known breakage; colima offers no 9p with the `vz` VM type. NFS from the host is supported by neither lima nor colima.
- **Apple's virtiofs has no setting and no fix:** Apple closed the report as fixed in macOS 15, it still reproduces on macOS 26. The only workaround others report as working is the guest cache drop pinata already uses (one report: 137,808 open files down to 983). Raising the limits "only delays failure" (reporter in apple/container#1097).
- Verdict: no file-sharing layer makes the redesign unnecessary today. krunkit is the one to watch.

### C1: what pinata assumes today (code and docs read in the worktree)

Must not break:

- **Volumes are treated as caches.** `pinata restart` removes every volume of the install, a daily sweep removes volumes whose labelled root is gone, and uninstall deletes the VM's data. A workspace volume holding work that has not reached the Mac must be flushed first or exempt.
- **Host writes stay inside the root**, follow no link, pass a real-path and letter-case check, and are listed in "Files written" (`launcher/ARCHITECTURE.md`). Today pinata writes only empty mount points into the workspace.
- **Git must work for every repository under the root**, not only the launch repository. Nothing lists those repositories today (only `pinata init` counts `.git` entries two levels deep).
- **`.pi/` project files must keep crossing** (`pi-subagents.json`, `mcp.json`, `agents/*.md`). `.pi/` is git-ignored (`.pi/.gitignore` holds `*`), so "git-ignored files stay on their side" cannot be the rule.
- **Subagent worktrees** are created inside the container at `<cwd>/.pi/worktrees/<id>`; their branch and metadata land in the Mac's `.git` with absolute paths.
- **Same absolute paths** for the session cwd, resource paths, pasted paths and pi's arguments. `visibleInside` (`host-paths.ts`) counts only a same-path bind as visible and needs to learn the volume.
- **Nothing in the repository configures the sandbox** (threat model). Ignore rules read from `.gitignore`, which the agent can edit, would bend that. Pinata also never runs git on the host, because the sandbox can write `.git/config`.
- **Read-only binds**, the refusal of binds that overlap the root, the locks and liveness rules, several launches, repositories and installs on one VM.

Already accepted, not a regression: nothing protects `.git/hooks` or `.git/config` from the sandbox today; the threat model states it ("Host git and host tools run what it wrote").

Could be deleted: the overlay scan, markers, walk, caps and notices, `mounts.autoOverlays`, cache volume names and their pruning, the overlay parts of status, help and restart (about 370 lines plus tests and docs); probably mount point creation and `created.json`. `mounts.volumes` stays (home caches, volumes shared with services).

Rails that exist for a helper process: the proxy is started detached, records itself in the state dir, exits when no launch is live, is stopped by the idle sweep and by `pinata stop`, and shows in `status`. A second helper can follow the same pattern. Pinata ships no binary into the VM today; colima is installed with `brew` when missing; the image is built in the VM.

### C2: pinata's launch structure (read in code)

- **One workspace root per install.** `workspaceRoot` must be set and must contain the launch's repository; the container gets exactly one writable workspace bind, the root at the same path (`launcher/container/spec.ts:254`, `launcher/workspace/roots.ts:163-208`). So one volume and one mirror per install.
- **The VM shares the root writable** by virtiofs (`launcher/cli/vm.ts:146-163`). It can stay as the source of the `.git` binds.
- **Containers:** one agent container per launch, a sleeper into which pi is exec'ed, user `pi` uid 1000. Pinata already keeps long-lived containers of its own per install (relay, pod), so a mirror container fits an existing pattern.
- **Helper rail:** the proxy helper is one per install, started detached, recorded in the state dir, exits after two empty 30 s checks, stopped by `removeGround`. `pinata stop`, `restart` and uninstall each have a point before the VM stops where a final sync fits (`stop.ts:14-26`, `restart.ts:361-362`, `pinata/uninstall.ts:45-48`).
- **No runtime notice channel:** launch notices print to stderr before pi starts; nothing shows the user a message during a session. A conflict policy cannot rely on telling the user at once.
- **Volumes:** all carry install labels; `pinata restart` removes every one of them (after a y/N when data is at stake); the daily sweep removes those labelled with a root that is gone.
- **Git config in the container:** a per-user `~/.gitconfig` is already rendered at launch (`launcher/provision/render.ts:161-184`); the three settings can go there. No `/etc/gitconfig`, no `safe.directory` today.
- **Subagent worktrees** are made by pi inside the container with `git worktree add -b … <cwd>/.pi/worktrees/…` and removed with `git worktree remove` (`extensions/subagents/core/run-agent/worktree.ts:37-81`); no lock is used.
- **Exec rail:** `Backend.exec(spec, io)` already supports attached input and raw output (`launcher/backend/colima/exec-session.ts:236-282`).
- **File-cache watch:** runs per launch, samples every 10 s, drops the guest cache at `min(maxfilesperproc/2, maxfiles/4)`. With only `.git` read through the share it should rarely fire; no change planned.

### S5: the Linux-side watcher (measured, 300,009 files, 38,311 directories)

| | Node `fs.watch` script | Unison's `unison-fsmonitor` |
| --- | --- | --- |
| Memory | 270 to 417 MB | 21 to 28 MB |
| Inotify watches | 38,312 (Node 24.22+); 478,580 on Node 24.11 | 38,381 |
| Idle CPU | none | none |
| Single edit reaches the Mac | 0.67 s | 1.29 s |
| Delete a folder of 2,000 files | 10.3 s | 1.14 s |
| Delete a folder of 10,000 files | 49.9 s | 1.82 s |
| Missed changes in 60 runs | none | none |

- Node's recursive watch on Linux is JavaScript (`lib/internal/fs/recursive_watch.js`). Before 24.22.0 it puts a watch on every file; from 24.22.0 one per directory. Its handling of a deleted entry loops over every known path, so a bulk delete costs deleted files times tree size: a large `rm -rf` would stall it for minutes. The image's base (`node:24-bookworm-slim`) floats across those versions.
- Building Unison 2.54.0 with its watcher from the pinned source tarball (sha256 `0f14154611a2dfebb8c229be85ceda29a750eace4fb75d06e0d43fe5b58a6e87`) in a build stage: 15 s, 166 MB of build packages that stay out of the image, two stripped binaries of 5.2 MB and 1.7 MB that need only libc. Measured on arm64.
- Decision: the Linux end uses Unison's own watcher, and Unison itself comes from the same build stage, so both ends run 2.54 and Debian's package is not needed.
- Not measured: the Mac to container direction with this watcher at this size beyond S3's figures; an x86-64 build.

### S7: end-to-end rehearsal (measured; two repositories of 3,027 and 20 files, docker 29.5.2)

Composition:

- First pass 0.76 s; container `git status` clean in both repositories; the Mac's `.git` file list unchanged; the volume's `.git` folders empty.
- A commit in the container is readable on the Mac after 1.4 s, and the reverse. A 300-file branch switch settles in 0.7 to 1.2 s (container to Mac) and 1.8 to 2.2 s (Mac to container).
- The mirror adds no open files on the host (VM count stayed at 1,286 through 3,000-file edits on each side). Container `git commit` of 3,000 files: +3,360 through the `.git` bind, back to 50 a minute later.
- The Linux watcher in the mirror container sees writes made by the agent container (0.51 to 0.55 s to the Mac).
- Starting the agent container on an empty volume makes docker create the volume root, the repository folders and the `.git` mount points as root; the mirror (uid 1000) then fails with "Permission denied". Order and ownership must be arranged (follow-up drill running).
- A file the container creates as root with mode 600 is skipped with an error on every pass.

Deletion paths:

- Volume recreated, both sides' sync state kept, agent container started first (its mount points make the volume non-empty): exit 0, **3,041 Mac files deleted**, Unison's whole-replica check silent. This is the layout with Linux state outside the volume.
- Same with the Linux state inside the volume (`tree/` and `state/`, agent containers mounting `tree/` by docker's volume subpath, which works): exit 3 "inconsistent state … archive is MISSING", 0 deleted. After deleting the Mac-side state: plain copy, 0 deleted. An agent container also refuses to start when `tree/` is missing.
- State lost on one side with both trees present: exit 3, same message. After deleting the other side's state: nothing lost; files deleted on one side come back; files edited on both sides are conflicts.
- Same volume mounted at a new root path with an empty Mac folder: the old tree (3,141 files) is copied into the new folder. A volume must belong to one root.
- Container host name: Unison's state name includes it, and a recreated container gets a new one (full rescan, old state orphaned). With `UNISONLOCALHOSTNAME` fixed on both ends the state survives.
- Kills mid-transfer (mirror container killed, client SIGKILLed): next pass exit 0, partial work reused, trees equal. A temporary folder stays in the tree until that pass.
- `rm -rf <repo>` in the agent container empties the Mac's `.git` through the bind (as the live share does today) and the mirror then deletes the Mac's working files.
- A folder deleted whole on one side is deleted on the other together with what the rules keep out (`.git`, `node_modules`, `target`): `ignore` does not protect inside a deleted parent.

Conflicts (volume edited first, Mac 2 s later):

| Policy | Result |
| --- | --- |
| Default | skipped, exit 1, reported every pass, each side keeps its own |
| `prefer = newer` | Mac wins, the volume's edit lost silently |
| `prefer = newer` + `copyonconflict` | Mac wins, the loser kept as `name (conflict_on_DATE).ext` on both sides, untracked in git |

- Delete against edit under the third policy: the path is deleted on both sides and the edit survives only as `name (conflict_on_DATE_was_deleted).ext`.
- Both edits in the same whole second: skipped every pass even with `newer`.

Stop:

- An edit made 100 ms before the stop signal reached the Mac in 0 of 10 tries (SIGUSR2 and SIGTERM alike). SIGUSR2 followed by one pass: equal trees, 0.98 s. A final pass is required.

Rules and settings:

- `ignore = Regex (.*/)?\.pi/worktrees` keeps subagent checkouts out at any depth while other `.pi/` files cross. `ignore = Name *___jb_tmp___` and `*___jb_old___` are accepted and work.
- A tracked `lib/target/T.java` under `ignore = Name target` shows as deleted in the container. `ignorenot = Path <folder>` restores that folder both ways without listing parents.
- Git settings through `GIT_CONFIG_COUNT` are honoured for all four keys and outrank the shared `.git/config`; with `core.ignorecase=false` a case twin shows as untracked.
- `git worktree add --lock` protects the record from `prune` on the Mac, but plain `git worktree remove` then fails until `unlock`.

Hazard check, 3 minutes with the mirror watching: 41 container commits, none wrong; 88 Mac statuses, no errors; `git fsck` clean. The Mac rewrote its index in 33 of the 88 statuses (git's refresh of entries edited and staged within one second). After a Mac-side branch switch the container printed "not a git repository" for about 0.8 s in 2 of 4 tries.

Follow-up drills (measured):

- On a tree already owned by the sandbox user, starting the agent container with the subpath mount and the `.git` binds changed no owner. For a repository without a stub docker created `<repo>/.git` as root; the repository folder kept its owner.
- With the agent container up, a new top-level file and folder on the Mac reached the volume in about 3 s. Deleting on the Mac a repository whose root-owned `.git` stub was a live bind: two passes, nothing failed, nothing left in the volume; in the agent container the path is gone and git says "cannot change to".
- Mirror container per connection (`docker run --rm -i`, root for `mkdir` and `chown` of `tree/` and `state/`, then `setpriv` to uid 1000): works once `HOME` is set (Unison changes into `HOME`; without it "Error in changing working directory: /root: Permission denied"). `setpriv` is in the image. Watch mode works both ways with the watcher in that container. The container is gone within 2 s of a normal exit and within 1 s of a SIGKILL of the client.

S7b, the order "container first, then the pass" on a new volume with no sync state (measured):

- Starting the agent container on the empty `tree/` (owned by the sandbox user) left the mount root, every repository folder, the folders between and the `.git` stubs owned by root.
- `chown -h 1000:1000` as root in the agent container over the root, the repository folders and the folders between: exit 0; stubs stayed root's; the Mac's `.git` folders kept owner and mode.
- `git ls-files` with a pathspec for `target` and `node_modules`, run on the empty tree: listed the tracked `lib/target/T.java` in 4 ms.
- First pass with that folder exempted: code 0, 0 skipped, 0 failed, trees equal (3,152 files), `git status` clean in all three repositories (one of them two folders down), tracked file present, Mac `.git` file lists unchanged. Watch then carried one edit each way.
- Not measured: the same `chown` in a container that has the CHOWN capability only, as pinata's does.

Consequences for the plan: state inside the volume is a rule; a pass is needed wherever the helper is stopped right after work; the order is container, hand-over, pass (S7b); conflict policy `prefer = newer` with `copyonconflict`; a folder deleted on one side takes kept-out folders with it on the other.

### C3: re-check against PR 83 (`feat/pinata-commands`, read at 8256cd80)

C1 and C2 were read in the worktree, which sits at the PR's 7th commit (7a6f7317), 20 commits behind its head, with no commits of its own. What differs at the head:

- `pinata restart` (`cli/commands/restart.ts:49-63`): refuses while sessions run, checks settings and VM size, then `colima delete --force --data`, then creates the VM. No options, no question. `forgetVm` (:13-20) removes the rendered files, the sync folder and the image record from the state folder; the rest stays.
- `pinata uninstall` and `uninstall --sandbox` (`cli/pinata/uninstall.ts:152-188`) delete the VM through the same `removeSandbox` (:61-83) and then remove the whole state folder. `pinata stop` removes nothing.
- The one place to run something in the VM before it is deleted: inside `removeSandbox`, before `deleteVm`. `removeGround` has already stopped the proxy by then; the step is skipped when no VM exists; a stopped VM would have to be started.
- Volumes are removed in one place only, the daily collection (`cli/sweep.ts:203-220`): unused volumes that carry a `pinata.repo-root` label whose root is gone. There is no selective wipe any more.
- Names: colima profile `pinata`, socket `~/.colima/pinata/docker.sock`, state `<agentDir>/pinata/state`, config `<agentDir>/pinata/config.json`, variables `PINATA_*`.
- Output: commands print steps through `stepsOf` (`cli/steps.ts`; a task can update its pending text). A launch still prints `pinata: …` lines once per distinct text (`cli/notices.ts`). No channel during a session.
- Config: `REPLACED_KEYS` and `REMOVED-DEFAULTS.md` are gone; an unknown key is a plain error. `mounts.autoOverlays` and the overlay files are unchanged.
- State: `stateLayout` in `shared/state-layout.ts`; nothing collects entries it does not name.
- Homebrew: only `pinata install` checks and installs (`preflight`, `cli/pinata/host.ts`).
- Unchanged: the workspace bind (`container/spec.ts:254`), VM shares and mount type, agent container, proxy rail, ground teardown, file-cache watch, exec rail, subagent worktree code.
- The branch on this machine is two commits ahead of the PR on GitHub (c1cf1994, 8256cd80).

### C4: launcher rail facts (`main` at dbd9539c; PR 83 merged, `launcher/` identical to 8256cd80)

- **Root.** The workspace bind is `bind(workspaceRoot, workspaceRoot)` of `context.mountedRoot` (`container/spec.ts:254`, `cli/context.ts:48-57`). A normal launch requires `workspaceRoot` and the cwd's repository must lie inside it, so all launches of an install share one root. Container labels `pinata.repo-root` and `pinata.repo-hash` hold the cwd's repository, not the root.
- **Proxy helper.** One per install. A launch finds it through a record file checked by pid and process start (`shared/liveness.ts`), health-checks it, and restarts it on a changed input hash only when no other launch is live. `watchIdle` counts live launch records every 30 s and exits after two empty checks. `stopProxy` sends SIGTERM and kills after 4 s.
- **Ground stop.** `sweepOrphans` ends with `stopIdleGround` when no launch is live, and runs at the end of every launch and in `pinata stop`: the proxy is stopped in the foreground when the last launch ends. `pinata stop` refuses while sessions run.
- **Hand-over.** `handOverVolumes` (`container/lifecycle.ts:222-241`) runs a non-recursive `chown -h 1000:1000` as root in the agent container after it starts, over `ownedPaths` (`container/spec.ts:277-283`). The container has the CHOWN capability only.
- **Launch order** (`cli/launch.ts`): VM, host sweep, proxy and image in parallel, then under `withPrepareLock` network, services, notices, `startLaunchContainer` (volumes ensured, mount points, create, start, hand-over), container setup, then pi. After pi: denials printed, settings written back, `finishLaunch` (container removed, sweep).
- **Dead with the overlay scan:** `walk.ts`, `overlay-scan.ts`, `overlay-markers.ts` are imported only by each other and `workspace/discover.ts`; `pinata.repo-root` is put on cache volumes only, so the daily volume collection would select nothing; `pruneCacheVolumes` and the cache-path label go too. `ensureMountPoints` and `created.json` serve volumes nested in a writable same-path bind.
- **Volumes.** `ensureVolume` is idempotent and does not say whether it created the volume.

Consequences for the plan: one helper per install with the root in its input hash; passes run by commands in the foreground, the helper only watches and is left to its idle watch when the last launch ends; pass at `pinata stop` and before the VM is deleted; docker-made folders handed over by the existing chown step; order container, then pass, then pi; a "volume exists" backend call so the Mac-side state is cleared before a volume is created.

### R6: the VM's clock after the Mac sleeps

- Lima's host agent sends the Mac's time to the guest every 10 s; the guest agent steps its clock when the difference passes 100 ms (`pkg/hostagent/timesync.go`, `pkg/guestagent/api/server/server.go`; since lima 2.1.0, January 2026). This machine: colima 0.10.3, lima 2.3.0. Read in source.
- Measured here while awake: guest minus host median 0.000 s, spread -0.011 to +0.236 s over 20 samples.
- Not measured: the lag after a real sleep. Inferred: the guest lags by the sleep's length until the next sync, so for about 10 to 15 s after waking.
- Open lima issues: under host load the sync can step the clock wrongly by up to 9.6 s (#5543); a guest clock once jumped 95 years and stayed wrong until restart (#5665).
- Consequence for the design: a known limit, not a rail. "Newer wins" can pick the wrong side in that window, so the losing version must always be kept.

### R7: lima's built-in copy mode (`limactl shell --sync`, source read at v2.3.0)

- What it is: `rsync -a --delete` of a host folder into `<guest home><host path>` before the command, and one copy back after the command exits. With a terminal it first shows the changes and asks to accept them. Nothing is watched or continuous. Since lima 2.1.0 (March 2026, PR #4429); stated purpose: keeping AI agents away from host files.
- Refuses an instance that has any host mount ("start the instance with `--mount-none`"). Colima always configures mounts and exposes no copy mode, so it cannot be used under colima. Measured here: refused on the research VM.
- No conflict handling (read in source, not measured): on accept the guest copy replaces the host's, and a file added on the Mac during the session is deleted. Two sessions on one folder share one guest copy and the first to exit removes it. `.git` is copied like any other path.
- No lima or colima issue asks for a continuous or two-way mode.
- Verdict: not a base for a workspace that an editor and several sessions use at once. It confirms the detached model (copy in, reviewed hand-back) as lima's own direction for agents, which matters for the later "workspace not on the Mac" mode.

### V1: independent review of draft 1

Verdict: sound with changes. Taken into draft 2:

- Sync state must live in the volume it describes, a new volume must clear the Mac-side state, and a volume must belong to one root; otherwise a lost or reused volume can delete or pollute the Mac tree. Drills added to S7.
- Unison names its state after host names; containers and Macs change theirs. Fixed names on both ends. Drill added to S7.
- `core.ignorecase=true` from the Mac's `.git/config` is wrong on the volume; override in the container's environment. Drill added to S7.
- A listed name that holds tracked files must still cross (automatic exemption instead of a notice).
- JetBrains safe-write names ignored; the Mac watcher filters unsynced names.
- Cut: the final pass at idle and at stop, most status output, subagent worktree locking, the Mac git-config check.
- Mirror container per connection instead of long-lived.
- Step 0 before any code: the deletion drills, and a run on the real root on the failing machine.

Not taken: keeping the workspace volume across `pinata restart`; a clock check in the helper.

Note: the review found no notes files for R1 to R5 and C1 in the scratchpad; their results exist only in this file.

### S6: the git hazard in today's layout (measured unless marked)

Setup: one repository of 40,001 files, working tree and `.git` both on the share, Mac git 2.50.1, container git 2.39.5 as uid 1000.

- **The window.** After git on the Mac replaces `.git/index` (a `git add`), the container sees no index for 458 to 498 ms (10 of 10). After a Mac commit, index and HEAD are both unreadable for 441 to 449 ms (4 of 4).
- **What the container does in the window.** `git rev-parse HEAD` fails loudly when the ref was written. Everything that reads the index is silent with exit code 0: `ls-files` prints nothing, `status` shows every file deleted, `add` and `commit` succeed. Git reads a missing index as an empty one (`read-cache.c`, read in source).
- **Default settings.** Every `git status` on either side rewrites all 40,001 index entries, because the two sides see different inode and owner numbers for the same file (times match to the nanosecond): 0.75 to 0.86 s on the Mac, 3.6 to 4.6 s in the container, each time. In 300 s: 30 container commits, all right; the Mac rewrote the index after 50 of 125 statuses. A second, partial run: 40 commits, all right, 2 lock errors.
- **With `core.checkStat=minimal` and `core.trustctime=false`.** The rewriting on every status stops. One Mac rewrite remains after each container write made in the same second as the edit (git's racy-entry refresh): 96 of 144 statuses. In 300 s and 600 s: 166 container commits, **one of them an empty tree** (all 40,001 files deleted, nothing printed); the next `git add -A` put the files back in a new commit. One lock collision per run ("Unable to create .git/index.lock: File exists").
- **With `GIT_OPTIONAL_LOCKS=0` on the Mac.** `git status` there wrote the index 0 of 30 times. Without the two settings it then re-hashes every entry on each status (0.8 s).
- **IDEA** sets `GIT_OPTIONAL_LOCKS=0` for every git command it runs, by default since 2019.1 (read in source: registry key `git.use.no.optional.locks`, default true).
- Inferred: with all three in place, only a deliberate git write on the Mac (add, commit, checkout, reset, pull, gc) still opens the window.

Verdict: the two settings are worth having on both sides and the variable in the Mac shell; together they stop the background writes and make `git status` fast again, today as well as in the new layout. They do not remove the hazard, and nothing pinata can set does: the index must be one file for both sides.

### S7c: links and the Mac-side writer (measured)

Question: can content in the volume make Unison's Mac end write, change or delete anything outside the Mac root? No. A folder outside the root (a sentinel file and a subfolder with two files) had the same listing (type, size, mtime, mode, md5) after every step; every pass ended in code 0 with nothing failed.

- A volume folder replaced by a link to the outside folder: the Mac gets a link with the same target string. Replaced back by a folder with a file: the Mac's link becomes a real folder with that file; nothing lands outside.
- Deleting the link in the volume deletes only the link on the Mac.
- A file link to the sentinel, then replaced by a regular file: the Mac's link becomes a regular file; the sentinel is unchanged.
- A link made by the Mac user, replaced in the volume by a folder: the Mac's link becomes a real folder.
- Swapping a folder (20 files) with the link under watch: every 50 ms for 60 s (1,121 swaps; the watch waited for the churn to end and ran one pass), every 300 ms for 30 s (2 passes), every 1 s for 30 s (28 passes; the Mac's path replaced 14 times by a link and 13 times by a folder). No errors, final states equal.

Inferred: Unison replaces a link without following it.

### V2: second independent review (draft 3, opus reader, code read on `main`)

Verdict: sound with changes. Accepted, each checked:

1. A helper stop placed in `removeGround` would run at the end of the last launch, because `stopIdleGround` is `removeGround` (`cli/ground.ts:89-123`): no idle minute, last edits not delivered. The stop became its own function.
2. `withPrepareLock` is per repository (`cli/prepare.ts:40-47`); two launches from different repositories share the root and would collide on Unison's state. The mirror's steps moved under the ground lock (`cli/sandbox-proxy.ts:84`).
3. A mirror stuck at code 3 left `pinata restart` as the only way out, and restart's own pass would fail too: a blind y/N over the sandbox's work. Now: state on one end only is repaired by a pass from empty state (measured safe in S7), and before the VM is deleted every code 3 gets that pass. This also removed the "does the volume exist" backend call.
4. Subagent checkouts never cross, and one with uncommitted work is kept by design (`extensions/subagents/core/run-agent/worktree.ts:64-69`). Deleting the VM would delete it without a word; today it sits on the Mac. Now listed and asked about, together with repositories created in the sandbox.
5. A pass while the old helper still watches collides on the state lock. The order is stop, pass, start.
6. A root changed while another launch is live (no reshare needed when the new root lies inside the old one) would give the agent an empty volume under live `.git` binds: every file "deleted". Such a launch is refused. A grown exemption list restarts the helper at once.
7. The pass before deletion covered only the configured root. Now every workspace volume, found by a label naming its root.
8. `core.ignorecase=false` is wrong while the workspace is still the share: the git environment moved to the build step that makes the switch.
9. A crash between creating the volume and its folders would block every later launch. The folders are made sure of on every launch that finds no helper.
10. "Unison never follows a link" was not measured for a folder swapped with a link during a pass. Drill S7c.
11. A stale line in this file about the order of pass and container: fixed.

Cuts taken: the "does the volume exist" call; the parsed listing in the y/N (counts and the log's path instead); the pass at `pinata stop`.

Checked by the reviewer and found right: the unlabelled volume is never selected by the daily collection; a root change that needs a reshare is already refused while sessions run; the helper cannot idle-exit after a launch has registered (same launch lock); the hand-over point exists and runs as root after start; the step before `deleteVm` fits in `removeSandbox`.

## Open questions

Still open:

- Numbers from the failing machine (which limit trips, how many VMs share files there, whether raising `kern.maxfiles` alone stops it). Only the owner can supply them.
- The lag after a real sleep of the Mac (inferred in R6, not measured).
- Step 0 of the build order: first-copy time, pass time, memory, inotify watches and host open-file count on the real root. Only the failing machine can supply them.
- For the owner: default unsynced names, conflict policy, submodules, Mac git settings, the question in `pinata restart` (see the plan's decisions).

Answered:

- Does either engine carry modification times? Unison yes, Mutagen no (S2, S3).
- Is the state between a change and its arrival harmless for git? No: `git add -A` in that second stages a revert (S1). Known limit.
- How does the container reach every `.git`? Listed at launch by walking down from the root; one bind each (plan).
- Which rule decides what stays on its side? A fixed list of names; folders holding tracked files are exempted (plan).
- How far does the guest clock drift? Under 0.1 s awake; wrong for about 10 s after waking (R6).
- What becomes of subagent worktrees? They stay in the volume; their branches are in the shared `.git` (S1, plan).
- Which engine, how installed and supervised? Unison from Homebrew on the Mac and built from pinned source in the image, with its own watcher there; run by a helper on the proxy's rail (S3, S4, S5, C2, plan).

## Decisions

| Date | Decision |
| --- | --- |
| 2026-11-24 | Direction: synced workspace on the VM's disk, replacing the overlay scan. |
| 2026-11-24 | No legacy VM coverage, no backwards compatibility. |
| 2026-11-24 | Research and an architecture plan first; no implementation until asked. |
| 2026-11-24 | Engine: Unison. Mutagen ruled out by measurement; Syncthing kept as fallback only. (Research conclusion, not yet confirmed by the owner.) |

## Spike artefacts: removed 2026-11-24

- [x] Throwaway folders under `.claude/worktrees/`: `_spike-git/`, `_spike-git-today/`, `_spike-mirror/`, `_spike-mirror-backup/`.
- [x] Every spike volume, container and image: the `pi-sandbox` VM was deleted with its data disk on the owner's instruction (`colima delete --profile pi-sandbox --force --data`). The `default` and `pinata` VMs were not touched.
- [x] Symlink `/private/tmp/claude-502/s2m`.
- [x] The session scratchpad (11 GB: binaries, test trees, tool state, notes, the manifest).
- [x] Homebrew developer mode switched off again (`brew developer off`, on the owner's instruction).

The prototype files (connection script, Mac watcher, profile, Unison build stage) were removed too, on the owner's instruction; what they proved is in the S5, S7 and S7b sections above.

Left as found: the research worktree `.claude/worktrees/host-open-files` (branch `fix/launcher-host-open-files`, no commits of its own, behind `main`); to be recreated from `main` when implementation starts.
