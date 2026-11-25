# Synced workspace: architecture plan

Status: **draft 4**, 2026-11-24. Written against `main` after PR 83 merged (dbd9539c). Revised after two independent reviews, an end-to-end rehearsal (S7), a check of the launcher's rails (C4) and the studies R6, R7 and S5. All measurements are in. Every "measured" below has its numbers in [progress.md](progress.md). Nothing here is implemented.

## The idea in one paragraph

The agent's container stops reading the Mac's workspace folder through the VM's file share. It gets a copy that lives on the VM's own disk, at the same path. One sync program keeps that copy and the Mac folder equal in both directions, over its own connection, never through the share. Dependency and build folders are not copied: each side keeps its own. There is still exactly one `.git` per repository, the Mac's, which the container reaches through the share. The share therefore carries only `.git` traffic, which is small, so the host's open-file count stops growing with the size of the workspace (measured: the mirror adds none), and the `node_modules` scan has nothing left to do.

```
Mac                                          VM (colima)
---------------------------------            -------------------------------------------
<root>/            real files   <-- Unison -->   volume, folder tree/, mounted at <root>
<root>/repo/.git   real .git    -- virtiofs -->  bound at <root>/repo/.git (agent container only)
<root>/**/node_modules  Mac's own                <root>/**/node_modules  Linux's own (in the volume)
```

## Parts

The root is the folder a launch mounts. A normal launch requires `workspaceRoot` and mounts it, so all launches of an install share one root, and it changes only when the setting does.

1. **Workspace volume.** One docker volume per install and root, the root's hash in its name, so a changed `workspaceRoot` gets a new, empty volume. It holds two folders: `tree/`, the mirrored copy, and `state/`, the sync program's Linux-side state. Agent containers mount only `tree/`, at the root's own absolute path, through docker's volume subpath mount (measured on docker 29.5). It is labelled with its root's path under a label of its own, not `pinata.repo-root`, so the daily collection never removes it; the volume of a root that is no longer configured stays until the VM is deleted.
2. **`.git` binds.** At launch pinata lists the repositories under the root and binds each `<repo>/.git` directory from the share into the agent container, nested inside the volume mount.
3. **Mirror.** Unison: the client on the Mac, the server in a container that mounts the whole volume and nothing else, with no network. That container lives exactly as long as one connection: `docker run --rm -i`, gone within 2 s of the client's exit or kill (measured). So there is nothing to start, stop or sweep. It has nothing from the share, so the mirror cannot touch the share by construction, and the agent cannot reach it to replace the program the Mac talks to. It starts as root only to create `tree/` and `state/` for the sandbox user, then drops to that user.
4. **Mirror helper.** A detached host process per install, built from the proxy helper's parts: a record file with its liveness check, an input hash (the root and the profile are inputs), and the idle watch that makes it exit about a minute after the last launch ended. It does one thing: run the Unison client in watch mode and start it again when it exits. It runs no pass of its own.
5. **The pass.** One function, run in the foreground by a command: by a launch that finds no helper or changed inputs, and before the VM is deleted. Its output and exit code are on the terminal. It can also be run "from empty state": both ends' sync state is cleared first, and Unison then deletes nothing (measured).
6. **Git settings** for the container, set in its environment.

The Mac-side sync state (Unison's state, the generated profile, the log) has a folder per root under the state dir, so a root that comes back finds its own state.

### The sync program

**Unison**, 2.52 or newer on both ends. It is the only engine measured to carry modification times across, which the single `.git` needs. Mutagen does not; Syncthing does but needs two daemons, generated configuration, certificates and a TCP link.

- Mac end: Homebrew's `unison` (2.54.0 today), installed by `pinata install` as a step beside colima's, with a minimum version. A launch that finds it missing stops and names `pinata install`.
- Linux end: built in an image build stage from the pinned 2.54.0 source release, checked by its sha256, together with Unison's own inotify watcher. The build takes 15 s and adds two binaries, 7 MB in all, that need only libc. Debian's package (2.52.1) works with the Mac's 2.54 but ships no watcher.
- Connection: Unison starts a small pinata script as its "ssh command". The script starts the mirror container, runs `unison -server` in it and passes bytes both ways. No port, no keys.
- File watchers, which no package ships:
  - Mac: a small Node script of pinata's own (about 40 lines in the prototype) that speaks Unison's watcher protocol over `fs.watch` (FSEvents). It drops events under unsynced names and `.git`, so a build on the Mac does not flood Unison.
  - Linux: Unison's own watcher (21 to 28 MB, one inotify watch per directory, measured). A Node script was measured too and rejected: 300 to 400 MB, a stall of minutes on a bulk delete, and one watch per file on Node versions before 24.22.
- Two ways to run it, one generated profile: **a pass** (`-batch`, exits with a code: 0 in step, 1 some paths skipped, 2 some paths failed, 3 stopped) and **watch** (`-repeat watch`, which starts with a pass of its own).
- Both ends get a fixed Unison host name (`UNISONLOCALHOSTNAME`). Unison names its state after the host names, and a container gets a new one each time: without the fix every connection rescans and orphans its state (measured both ways).

## What crosses and what stays

Everything under the root crosses, except:

| Stays on its own side | Why |
| --- | --- |
| Folders named in `mounts.unsynced`, at any depth. Default: `node_modules`, `target`. | Per-system dependencies and build output. This is what replaces the overlay scan. |
| Anything named `.git` | One `.git` per repository, the Mac's. |
| `.pi/worktrees`, at any depth | Subagent checkouts: whole copies of a repository that the Mac does not need. Their branches and commits are in the shared `.git`. |
| JetBrains safe-write files (`*___jb_tmp___`, `*___jb_old___`) | They live for milliseconds. |

All four rules are measured. Other `.pi/` files cross.

- The rule is a fixed list of names in pinata's configuration. It is not read from `.gitignore`: `.pi/` is git-ignored yet must cross, and the agent can edit `.gitignore`.
- **Tracked files always cross.** A listed name can also be a source folder (a Java package named `target`, a tracked `build/`). Hiding it makes git in the container show its files deleted (measured), and `git add -A` would stage that. So once the agent container is up, and before the pass, pinata asks git in the container which tracked files sit under a listed name (git reads only its index for this) and exempts those folders (Unison's `ignorenot`, measured). The list is one of the helper's inputs: a folder that becomes tracked during a session is exempted the next time the helper starts.
- **A folder deleted on one side is deleted on the other with everything in it**, kept-out folders included (measured). Deleting a module in the container removes the Mac's `target` under it. The rules keep content from being copied; they do not keep a folder alive.

## Git

- **One `.git`.** History, branches, index and stash are the Mac's and are seen by both sides at once. Nothing about git state is copied. Measured with the mirror running: a commit made on one side is readable on the other in about 1.4 s; a 300-file branch switch settles in 1 to 2 s; 41 commits in the container against 88 statuses on the Mac in 3 minutes, none wrong, `git fsck` clean. A longer run in today's layout found one wrong commit: Known limits 1.
- **Container settings**, given through git's environment variables (`GIT_CONFIG_COUNT` and its keys) so they outrank the shared `.git/config` (measured):
  - `core.checkStat=minimal`, `core.trustctime=false`: with them, and with modification times kept by the mirror, an index written by one side is valid for the other.
  - `core.ignorecase=false`: the shared config says `true` for the Mac's disk, which is wrong for the volume and hides files there.
  - `safe.directory=*`: the share shows changing owners.
  - `GIT_OPTIONAL_LOCKS=0`: the agent's `git status` never takes the index lock, so it cannot make a commit on the Mac fail.
- **Mac settings**, recommended in the README and not written by pinata: the same two `core` settings in the global git configuration, and `GIT_OPTIONAL_LOCKS=0` in the shell profile. The two settings make an index written by one side valid for the other; without them every `git status` on either side rewrites every entry (measured in today's layout on 40,000 files: 0.8 s on the Mac, 4 s in the container, each time). The variable stops `git status` in a Mac terminal from rewriting the index behind the agent's back, which it otherwise does after most container writes (96 of 144 statuses; with the variable 0 of 30). IDEA has run git this way since 2019.1 (read in its source).
- **Listing repositories.** From the root downward, a directory that has a `.git` directory is a repository and is not entered; other directories are entered, skipping the unsynced names, to a small depth. Host side, `lstat` only, no git run.
- **Who owns what in the volume.** The mirror runs as the sandbox user, and docker creates missing mount points as root: on a first launch the root and every repository folder (measured: the mirror then fails with "Permission denied"). pinata's existing hand-over step, a non-recursive `chown` run as root in the agent container right after it starts, gains the root, each repository folder and the folders between. The `.git` stubs stay root's and are never chowned (in the agent container that path is the Mac's `.git`); Unison ignores a stub and can still remove one when the Mac deletes the repository (measured). The whole order (new volume, container, hand-over, git query on the empty tree, pass, watch) was rehearsed: pass code 0, trees equal, `git status` clean, the Mac's `.git` untouched. The rehearsal's container had docker's default capabilities; pinata's has only CHOWN, which is the one `chown` needs (inferred).

## Lifecycle

The mirror's steps run under the install-wide ground lock, the one the proxy helper is started under. The launch's own prepare lock is per repository, and two launches from different repositories share the root.

- **Launch:**
  1. Before the agent container. If a helper is live on another root and other launches are live, the launch is refused: its container would mount a volume nobody mirrors. If no helper is live, the volume and its two folders are made sure of (one short container run; nothing changes when they exist).
  2. Start the agent container (pi is not running yet), hand the folders docker created to the sandbox user, ask git for the tracked exemptions, write the profile.
  3. If a helper is live with the same inputs: nothing. Otherwise stop the helper if one is live, run one pass, start the helper. A changed exemption list does this even while other launches run: their mirror pauses for the length of a pass.
  4. Start pi.
  - On a new volume (first launch on a root, and the first after every `pinata restart`) the pass is a full copy: minutes for a large root (253 s for 300,000 files and 1.6 GB on a loaded machine). One line says so before it starts.
  - Otherwise the pass takes seconds (3 to 6 s on an unchanged 300,000-file tree) and brings in what changed on the Mac while nothing ran.
  - Codes 1 and 2 print a notice with the count and let the launch continue. Code 3 stops it, with one exception: when exactly one end has sync state (a new volume beside old Mac state, a first copy that died halfway, state removed by hand), the pass is run once more from empty state.
- **While running:** an agent edit reaches the Mac in about 0.6 s, a Mac edit reaches the container in 1.3 to 3 s, 5,000 files in about 5 s. When Unison exits (it does when the other end dies) the helper starts it again after a pause.
- **End of a launch:** nothing is stopped and nothing waits. If the helper's record says Unison is not running, pinata prints one line saying the sandbox's changes have not all reached the Mac. There is no way to say it during the session.
- **Idle:** the helper exits by itself about a minute after the last launch ended (two empty checks 30 s apart, as the proxy helper does). The watch runs through that minute and delivers the last edits; a launch within it finds the helper live and skips the pass.
- **`pinata stop`:** stops the helper, then the VM. No pass: the volume survives a stop, and the next launch's pass brings any remainder.
- **Before the VM is deleted** (`pinata restart`, `pinata uninstall`, `pinata uninstall --sandbox`, which all delete the VM with its data and all pass through one function), for every workspace volume:
  1. Stop the helper, start the VM if it is stopped, run one pass. Code 3 is followed by one more pass from empty state, so a broken mirror still hands the sandbox's work over.
  2. Look in the volume for what exists only there and cannot be rebuilt: subagent checkouts under `.pi/worktrees` (one that still exists holds uncommitted work or belongs to a killed run) and repositories created in the sandbox (a `.git` folder with content).
  3. If a pass did not end in code 0, a root is missing on the Mac, or step 2 found something, the command says so (counts and the log's path; checkouts and repositories by path) and asks y/N, default no, before it removes anything; without a terminal it stops. This is the only question `restart` ever asks, and only when something would be lost.
- **An abrupt end** (Mac restart, VM killed): the last second of edits may be only in the volume. The volume survives, and the next launch's pass brings them.
- **Status:** one line in `pinata status` (helper state, time and code of the last pass). The helper keeps a capped log with the skipped and failed paths.

## The catastrophic case: deleting the Mac's files

A two-way mirror deletes on one side what it believes was deleted on the other. Measured: with Unison's state kept on both sides and the volume recreated, starting an agent container (whose mount points make the volume look non-empty) made Unison delete 3,041 Mac files with exit code 0. Its own "replica emptied" check stayed silent. Three rules prevent it, each measured:

1. The Linux state lives in the volume it describes, so it cannot outlive it. The same drill then ends with code 3, "archive is MISSING", nothing deleted. An agent container also refuses to start on a volume without `tree/`.
2. State on one end only is never trusted. Unison refuses it (code 3, measured for every such case); pinata then clears both ends and runs the pass again. Deleting the VM clears the Mac-side state too (`forgetVm`). With no state on either side Unison deletes nothing: it copies what exists on one side only and treats differing files as conflicts.
3. A volume belongs to one root (its name carries the root's hash). A volume mounted under another root copied its 3,141 files into the new Mac folder.

Unison's own guards stay on: it refuses to empty a whole replica.

## Conflicts

A conflict is the same file changed on both sides between two passes, in practice within about a second. Pinata has no way to show a message during a session, so a conflict that waits for the user would wait unseen.

Proposed and measured (`prefer = newer`, `copyonconflict`): the newer version wins and the other is kept beside it as `name (conflict_on_DATE).ext`. The copy appears on both sides and shows in `git status` as an untracked file, which is how the user and the agent notice it. Nothing is lost when "newer" is judged wrongly (see the clock limit), because the loser is kept. Plain "newer wins" lost the older edit without a word; the default left the file unsynced on every pass.

Two edges, measured:

- Deleted on one side, edited on the other: the path is deleted on both and the edit survives only as `name (conflict_on_DATE_was_deleted).ext`.
- Both edits in the same whole second: skipped on every pass until one side changes again. It shows as code 1 and in the log.

## Safety

- **Host writes.** A new writer appears on the Mac: Unison, writing and deleting inside the root what the sandbox wrote and deleted in the volume. The sandbox gains no reach it lacks today, when it works on the same folder through the share; but pinata now trusts Unison to stay inside its root. Measured with a folder outside the root as the target: a link made in the volume arrives on the Mac as a link with the same target; replacing it by a folder or a file replaces the link, and deleting it deletes the link; a link the Mac user made is replaced the same way; a folder swapped with a link every 50 ms, 300 ms and 1 s under watch (28 passes at 1 s) wrote nothing outside. The outside folder was byte-identical after every step. The sandbox also cannot swap a path under the Mac-side writer: on the Mac only Unison acts for it, and the one path it reaches directly, `.git`, is never entered by Unison.
- **"Files written" gains:** inside the root, what the sandbox wrote, conflict copies, and Unison's temporary files (`.unison.*`, left behind only after a kill and reused by the next pass, measured); under the state dir, per root: Unison's state, the generated profile, the capped log and the helper's record.
- **`.git`** stays writable by the sandbox, hooks and configuration included, exactly as today. `rm -rf` of a repository in the container empties the Mac's `.git` through the bind, as it does today through the share (measured). The threat model already states this.
- **Git on the host:** unchanged, pinata runs none.

## What is deleted

- The overlay scan and everything only it uses (checked by import): `workspace/overlay-scan.ts`, `workspace/overlay-markers.ts`, `workspace/walk.ts`, their use in `workspace/discover.ts`, `overlayVolume` and the cache volume names, `pruneCacheVolumes`, the daily volume collection (`pruneVolumes` and its helpers in `cli/sweep.ts`, which select only cache volumes), the `pinata.cache-path` label, `overlayNotices`, the overlay rows of `pinata status`, and `mounts.autoOverlays`. An unknown config key is already a plain error, so the removed key needs no hint.
- Mount point creation on the host (`ensureMountPoints`) and `created.json` with its sweep: they exist for volumes nested in the workspace bind, which is gone. To confirm when building that no configured bind still needs them.
- The README advice to raise both open-file limits, which makes the failure worse.

## What is deliberately not covered

- A `.git` that is a file (submodules, a linked worktree made on the Mac inside the root). It does not cross, so that folder is not a repository on the Linux side.
- A repository created or renamed during a session, on either side. Its files cross, its `.git` does not, until the next launch lists it. A repository the agent created keeps its `.git` only in the volume.
- Protecting subagent checkouts from `git worktree prune` run by hand on the Mac. Git's own housekeeping leaves them alone for three months (measured). Locking them was measured and dropped: it makes pinata's own removal fail.
- Simultaneous git writes on both sides. See Known limits.
- A second mode that keeps the live share. One mode only.
- Resolving conflicts through a command or a prompt.
- Repairing a mirror that stays at code 3 with state on both ends (two Unison versions that cannot agree, a full disk). The launch stops with Unison's message; `pinata restart` is the way out, and its pass from empty state hands the sandbox's work over first.
- More than one root at a time, partial or on-demand sync, other hosts than macOS. The volume of a root that is no longer configured stays, unmirrored, until the VM is deleted; it gets the same pass and check then.

## Known limits

1. **Git on both sides in the same half second.** When git on the Mac replaces a file in `.git` (the index on add, commit, checkout and reset; a ref on commit and pull), the container cannot read that file for about half a second (440 to 500 ms, 14 of 14 tries; Apple's file sharing; present in pinata today). A missing ref fails loudly. A missing index does not: git reads it as empty, so in that window `git status` shows every file deleted and `git commit` records an empty tree, both without an error. Measured: 1 of 166 commits, in a loop against a Mac terminal running `git status` every 2 s; the next `git add -A` put the files back in a new commit. With the Mac settings above the background writes stop, and what remains is a deliberate git write on the Mac in the half second before the agent commits. pinata does not guard against it. The index has to be one file for both sides: with two, each side would stage the other's commits as reverts.
2. **The second after a branch switch.** Until the mirror catches up, the other side's files are the old branch's while git already says the new one. `git add -A` there stages the revert. Switching branches under a working agent is already unsafe today.
3. **Clock.** The VM's clock stops while the Mac sleeps. Lima steps it back to the Mac's time every 10 s once the difference passes 0.1 s (read in lima 2.1 and later; this machine measures under 0.1 s when awake). For about 10 s after waking, and for moments under heavy host load, the VM's times are wrong by seconds or more. In that window "newer wins" can pick the wrong side (the loser is kept), and git can miss a second edit of the same size made in the same second.
4. **`pinata restart` costs more.** It deletes the VM, so the next launch copies the workspace again and every dependency and build folder in the sandbox is rebuilt. The Mac's own build folders are untouched.
5. **Two copies on disk:** the sources once on the Mac and once in the VM's disk image.
6. **Memory:** about 200 MB per end per 300,000 files while watching.
7. **Names.** A file the agent creates whose name differs from another only by letter case, or only by how an accented letter is encoded, is not copied to the Mac and is reported as skipped.
8. **Files the sandbox user cannot read** (made by root in the container with no access for others) are not copied and are reported as failed on every pass.
9. **What exists only in the VM.** Dependencies, build output, subagent checkouts and the `.git` of repositories created in the sandbox. Deleting the VM deletes them; the last two are listed and asked about first. Today a subagent checkout with uncommitted work sits on the Mac.
10. **Temporary files** named `.unison.*.tmp` appear for moments beside files being written, and stay after a kill until the next pass. An editor may index them, and a `git add -A` in that moment stages them.

## Later: workspace not on the Mac at all

The same volume can be filled by a clone inside the VM, with the mirror switched off. Nothing above stands in the way: the volume, the container mounts and the image stay as they are, and the mirror and `.git` binds become optional parts. The open question there is the editor, not pinata.

Lima's own `limactl shell --sync` is this model: copy in before the command, show the changes and copy back after it. It cannot be used here (it refuses a VM with host mounts, which colima always has, and it wraps `limactl shell`, not a container), and it has no answer for two sessions or for edits on the Mac during a session. The part worth keeping for this later mode is the review before anything is copied back.

## Decisions for the owner

1. **Default unsynced names:** `node_modules` and `target` only (proposed). Others are added per install: `out` (IDEA's build output), `build`, `dist`, `.angular`, `.next`, `.gradle`, `.venv`. A frontend build folder that is left off is copied both ways and indexed by the editor.
2. **Conflict policy:** newer wins with a kept copy (proposed, measured), or skip and report.
3. **Submodules:** whether any repository under the root uses them. If so the listing must walk inside repositories, which costs a full directory walk of the root at launch.
4. **Mac git settings:** a README recommendation only (proposed), or also a check in `pinata doctor`. They also help today, before any of this is built.
5. **The question in `pinata restart`:** asked only when a pass fails or when checkouts or repositories exist only in the sandbox (proposed), or never, with the command refusing instead.

## Build order

Rails first.

0. **Prove before building.** Done in research: the composition, the three deletion rules, the conflict policy, the stop pass (S7, small tree) and the engine at 300,000 files (S3, S5). Still to do, with the prototype scripts and no pinata change, on the real root on the machine that fails today: time of the first copy, time of a pass, memory, the number of inotify watches against the VM's limit, and the host's open-file count while the agent builds.
1. Image and install: the Unison build stage; the Homebrew step.
2. Mirror core as its own folder (`launcher/mirror/`, with its row in the folder table and in `test/architecture.test.ts`): profile, connection script, Mac watcher, one pass with its exit codes, the pass from empty state. Testable against a container without the rest.
3. Volume and helper, all under the ground lock: the volume with its label and two folders; the launch's pass; helper start, idle exit and its own stop; the pass and the check before the VM is deleted; the status line. Testable on a volume that no agent container mounts yet.
4. The switch and the deletions in one step: container spec mounts the volume and the `.git` binds; the git settings in the container's environment (`core.ignorecase=false` is wrong while the workspace is still the share); repository listing; hand-over paths; tracked-folder exemption; then the overlay scan, `mounts.autoOverlays` and the README advice go.

Docs change with every step (launcher and root `README`, `ARCHITECTURE`, `STRUCTURE`; `THREAT-MODEL` and `CONFIGURATION`; "Files written").

## Where it attaches (`main` after PR 83)

| Piece | Rail in the code |
| --- | --- |
| Homebrew step for Unison | `preflight`, `launcher/cli/pinata/host.ts`, beside colima's |
| Unison build stage, git environment | `launcher/image/Dockerfile`; `sandboxEnv`, `launcher/container/spec.ts` |
| Volume and `.git` binds in place of the workspace bind | `launcher/container/spec.ts:254` (the bind of `context.mountedRoot`, `launcher/cli/context.ts:48-57`); names in `launcher/container/names.ts` |
| Volume folders made sure of | one run of the mirror container's start command, before `startLaunchContainer` (`launcher/cli/launch.ts:373`) |
| Hand-over of docker-made folders | `ownedPaths` (`launcher/container/spec.ts:277-283`), `handOverVolumes` (`launcher/container/lifecycle.ts:222-241`) |
| Launch steps 1 to 3 | under `withGroundLock`, as `openSandboxProxy` does (`launcher/cli/sandbox-proxy.ts:84`); not `withPrepareLock`, which is per repository (`launcher/cli/prepare.ts:40-47`). Step 1 before `startLaunchContainer`, steps 2 and 3 after it and before `startPi` (`launcher/cli/launch.ts:704`). The ground lock is taken inside the prepare lock, never the other way round |
| Helper process | parts of the proxy helper: `spawnDaemon` (`launcher/proxy/start.ts:205`), record and `isLive` (`launcher/shared/liveness.ts`), input hash as in `ensureProxy`, `watchIdle` (`launcher/proxy/idle.ts:15`, counts live launch records), `terminateProcess` |
| Helper stop | a function of its own, called from `pinata stop` (`launcher/cli/commands/stop.ts`, before `backend.vm.stop` at `:26`) and from `removeSandbox`. Not part of `removeGround`: `stopIdleGround` is `removeGround`, and it runs when the last launch ends (`launcher/cli/ground.ts:89-123`, `launcher/cli/launches.ts:103`), which would cut the idle minute |
| Pass and check before the VM is deleted | `removeSandbox`, before `deleteVm` (`launcher/cli/pinata/uninstall.ts:61-83`); the question comes before `steps.task` starts, not inside it |
| Mirror container | must never count as a session or as an orphan where containers are listed (`refuseBusy`, `sweepOrphans`): to settle when building |
| Per-root state | a builder in `stateLayout` (`launcher/shared/state-layout.ts`); listed in `forgetVm` (`launcher/cli/commands/restart.ts:13-20`). Nothing collects entries the layout does not name. |
| Notices and steps | a launch prints `pinata: …` lines (`launcher/cli/launch.ts:349`, `:381`); commands use `stepsOf` (`launcher/cli/steps.ts`) |
| VM shares | unchanged (`launcher/cli/vm.ts:140-155`): the root stays shared with the VM, but containers bind only `.git` folders from it |

## Changes

**Draft 4**, from the second independent review, each finding checked in the code or the tracker:

- The helper's stop is its own function: inside `removeGround` it would run at the end of the last launch and cut the idle minute.
- The mirror's steps run under the install-wide ground lock; the prepare lock is per repository.
- A code 3 with state on one end only is repaired by a pass from empty state; this replaced the "does the volume exist" call and the clear-then-create order. Before the VM is deleted every code 3 gets that second pass, so `restart` no longer offers a blind choice.
- Before the VM is deleted pinata looks for subagent checkouts and sandbox-made repositories, which exist only in the volume, and covers every workspace volume, not only the configured root's.
- A launch on another root while other launches are live is refused; a changed exemption list restarts the helper at once.
- The volume's folders are made sure of on every launch that finds no helper, so a crash while creating them cannot block later launches.
- The pass at `pinata stop` is cut; the git environment moved to build step 4.
- From S6 and S7c: the Mac git settings are a README recommendation with measured numbers; the half-second limit names the silent empty commit and its rate; the claim that Unison stays inside its root is measured.

**Draft 3.**

- From PR 83: `pinata restart` deletes the whole VM without asking, so the guarded step moved to just before the VM is deleted and gained a y/N only when the pass fails; restart's higher cost is a known limit; Unison is installed by `pinata install`; state is declared in the layout and cleared by `forgetVm`; the old-key hint is gone.
- From the rehearsal (S7): the deletion rules, host names, subpath mount, exemption rule, environment settings and conflict policy are measured, not proposed; new limit 8 and the folder-deletion rule; worktree locking measured and dropped for good.
- From the rail check (C4): a normal launch's root is always `workspaceRoot`, so one helper per install with the root in its inputs; passes are run by commands in the foreground and the helper only watches; the helper lingers a minute after the last launch instead of being stopped, so no pass is needed at the end of a launch, only at `pinata stop` and before the VM is deleted; docker-made folders are handed over by the existing chown step, and the tracked exemptions are known before the first pass, so the order is container, then pass, then pi; the dead-code list is checked by import.
- From S5: Unison and its watcher are built from source in the image. From R7: lima's copy mode noted under the later mode.

**Draft 2**, from the independent review: sync state moved into the volume and the three deletion rules written out; volume keyed by root; fixed Unison host names; mirror container per connection instead of long-lived; status reduced to one line and the launch notice; tracked folders exempted automatically instead of a notice; `core.ignorecase` and the other settings moved to the environment; JetBrains temporary names ignored; the Mac watcher filters unsynced names; "Files written" covers Unison's temporary files; step 0 added and the switch merged with the deletions. Rejected: keeping the workspace volume across `pinata restart` (restart is the way out of a broken mirror), and a clock check in the helper (lima already corrects within 10 s).
