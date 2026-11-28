# Lab notes: node_modules and git designs on a VM (nmgit-lab)

Scratch: the scratch folder's `vm-lab/` (`$V` below), shared into the VM read-write at its own path.
Profile: `colima start --profile nmgit-lab --vm-type vz --mount-type virtiofs --cpu 2 --memory 4 --disk 20 --activate=false --mount $V:w` (19.3 s). `docker context show` was `colima` before and after: `--activate=false` keeps the context.
Docker only through `docker --context colima-nmgit-lab`, the VM only through `colima ssh --profile nmgit-lab`.
Mac descriptor count: `lsof -p <pid> | wc -l`, where `<pid>` is the `com.apple.Virtualization.VirtualMachine` process that holds `_lima/colima-nmgit-lab/disk` (PID 2500). It reads 23 to 25 at idle. `vz.pid` names the limactl hostagent instead, which is the wrong process.
"Drop" below means `sync; echo 2 > /proc/sys/vm/drop_caches` as root in the VM.

## Versions

| Component | Version |
|---|---|
| macOS | 27.2 (26B123) |
| colima | 0.10.3 |
| lima | limactl 2.3.0 |
| Docker Engine | 29.5.2 (client 29.9.3), containerd v2.2.4 |
| runc | 1.3.5, spec 1.2.1, libseccomp 2.5.5 |
| Guest | Ubuntu 24.04.4 LTS, kernel 6.8.0-117-generic, 2 CPU, 3.9 GB |
| git on the Mac | 2.50.1 (Apple Git-155) |
| git in the image | 2.54.1 (alpine 3.24.4 with git, util-linux, bash, coreutils, findutils, strace; user `pi` uid 1000) |
| git in the VM | 2.43.0 (not used) |
| node on the Mac | v26.10.0 |

`fs.mount-max` = 100000.

## L1. Mount propagation

`findmnt -o TARGET,FSTYPE,PROPAGATION` in the VM:
```
/      ext4      shared
└─$V   virtiofs  shared
```
The share is already in a shared peer group. Nothing has to change to make it shared.

Containers:
- `slave1`: `--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --mount type=bind,src=$V,dst=$V,bind-propagation=rslave`. Root bind inside: `private,slave`.
- `priv1`: the same without `bind-propagation`. Root bind inside: `private`.

The mount point `$V/repo/node_modules` was created on the Mac. Then, as root in the VM, while both containers ran:
`mkdir -p /var/lab/nm1; chown 1000:1000 /var/lab/nm1; mount --bind /var/lab/nm1 $V/repo/node_modules`

| Container | `findmnt $V/repo/node_modules` |
|---|---|
| `slave1`, started before the mount | `/dev/root[/var/lab/nm1] ext4 private,slave`: seen |
| `priv1`, default propagation, started before | rc=1: not seen |
| new, rslave, started after | seen |
| new, default propagation, started after | seen (the recursive bind copies mounts that already exist) |

Writing 20,000 files (200 dirs × 100, `echo x > p$d/f$f`) from `slave1`:

| Target | Time | Mac fds before → after (drop first) | What the Mac sees |
|---|---|---|---|
| `$V/repo/node_modules` (VM mount) | < 1 s | 25 → 25 | an empty folder (`find` = 1 entry); the 200 dirs are in `/var/lab/nm1` |
| `$V/plain` (plain share folder) | 3 s | 25 → 20,226 (66 after a drop) | 20,000 files |
| VM mount again, after that drop | < 1 s | 66 → 66 | empty |

Unmounting while the container runs:
- With a container process whose cwd is inside the mount: a plain `umount` in the VM fails with "target is busy", rc 32. The busy check includes the container's propagated copy, and the container keeps the mount.
- Idle: `umount` rc 0. The container's copy goes too (`findmnt` rc 1), and the container sees the empty share folder underneath.
- Busy with `umount -l`: rc 0. The mount leaves the container's table, but the process's cwd still reads the old tree (400 entries through `/proc/<pid>/cwd`).
- From the container (uid 1000, no capabilities), `umount` fails with "must be superuser". `rm -rf node_modules` empties the mount (400 → 0) and then fails with "Resource busy", rc 1, leaving the mount in place.

Meaning: node-modules.md's mechanism B works as described: an `rslave` root bind receives a mount the VM's root makes after start, a non-root container with no capabilities sees it, the files and their descriptors stay off the Mac, and the share needs no change. Default propagation is enough for mounts that exist before start.

## L2. Sandbox-private git dir

Fixture `fx` (`mkfx.sh 100 30`): 3,020 tracked files, 21 commits, `git gc` (29 files in `.git`), made on the Mac in the share.

Container `gitc`: root bind with rslave, docker volume at `$V/fx/.git`, `$V/fx/.git` bound read-only at `/host-git`, `--cap-drop ALL --cap-add CHOWN`, `chown 1000:1000 $V/fx/.git`, git run as uid 1000.

`setup-private.sh`, run inside the container:
```
git init -q -b main
echo /host-git/objects > .git/objects/info/alternates
git fetch -q --no-tags /host-git '+refs/heads/*:refs/remotes/host/*'
git symbolic-ref HEAD refs/heads/<Mac branch>; git update-ref refs/heads/<b> refs/remotes/host/<b>
git reset -q --mixed <b>
```

Setup harness: virtio-fs under vz reports ownership as whoever looked first. After a root `ls -ln` had shown uid 0 for the Mac's files, git running as uid 1000 refused the work tree with "detected dubious ownership". All later runs passed `safe.directory=*` through `GIT_CONFIG_COUNT`. pinata runs git only as uid 1000, but its root `chown` execs could trigger the same.

### Round trip

| Step | Result |
|---|---|
| Setup, 3,020 files | 220, 172, 206 ms. `git status` clean. `count-objects`: 0 local objects, alternate `/host-git/objects` |
| Setup, 20,420 files (`big`, L3) | 3,146 ms on a cold guest cache, 1,845 ms after a drop of all caches, 1,339 ms warm. Clean each time |
| Container commit (edit `src/d5/f5.txt`, new `src/agent-new.txt`) | ok. The first commit after setup left 105 loose objects (about 6 expected). Later only 6 remained, in a pack. Not chased. A second commit wrote 5, as normal |
| Mac fetch | `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c fetch.fsckObjects=true -c protocol.ext.allow=always fetch "ext::$V/ctr-up.sh gitc $V/fx" '+refs/heads/*:refs/pi/*'`, where `ctr-up.sh` = `docker --context … exec -i -u 1000 <c> git-upload-pack <path>`. Took 0.44 s and printed `[new branch] main -> refs/pi/main` |
| Mac sync | `diff-index --cached --quiet HEAD` ok, `merge-base --is-ancestor HEAD refs/pi/main` ok, then `update-ref refs/heads/main refs/pi/main`, `read-tree main`, `update-index -q --refresh` |
| Mac after the sync | `git status` empty. `shasum` of the agent's files unchanged. mtime and inode of 3 files unchanged |
| Container after the sync | `git status` empty |

### Mac `repack` and `gc` while the container reads

`mac-repackloop.sh`: each iteration writes a new blob, tree, commit and `refs/lab/l<i>`, then runs one of `repack -adq`, `gc -q`, `gc -q --aggressive` or `maintenance run --task=incremental-repack`, in turn. Restarted in batches of 20 until the reader finished.

Reader `ctr-readloop2.sh`, 60 s: `git log -p -50`, all 3,754 objects reachable from HEAD (`rev-list --objects HEAD | cut -d' ' -f1 | cat-file --batch-check`, counting "missing"), and `git status --porcelain`.

| Reader | Iterations | log failed | objects missing | status failed | Iterations with stderr |
|---|---|---|---|---|---|
| Container, through the share | 1,378 | 0 | 0 | 0 | 1 (2 × "packfile /host-git/…pack index unavailable"; the command still succeeded) |
| Mac-local control (`macsbx`, alternates to the same objects, on APFS) | 1,225 | 0 | 0 | 0 | 0 |

The same container ran 100 `commit -am` during the repack loop: 100 of 100 succeeded.

`git fsck --connectivity-only` is not a usable check here. In earlier runs it failed in 498 of 847 container iterations, with 474 of them "multi-pack-index file exists, but failed to parse". The Mac-local control failed in 55 of 954. Part of this comes from my loop: it reuses `refs/lab/l1..l20`, so `repack -ad` drops commits that an older commit-graph still lists. Afterwards the Mac's own `fsck` failed (rc 16, "Could not read <oid>" from the commit-graph) with no container involved, until a fresh `git gc`. The 10× larger fsck failure rate through the share is real, but it concerns fsck, not normal reads. With the Mac idle, a container `fsck` with a multi-pack-index present passed 3 times out of 3.

### Index rewritten on the Mac in a loop

`idx-loops.sh`:
- `mac_idx`, 400 iterations: `echo $i >> src/d0/mac.txt; git add; git commit` and, only if the commit succeeded, `git reset HEAD~1; git add`. That rewrites the index about 3 times per iteration.
- `ctr_idx`, 900 iterations: `git ls-files | wc -l` must equal the expected count, `git status --porcelain` must stay under 4 lines, and stderr must stay empty.

The two loops overlapped (about 18 to 20 s).

| `.git` | Container reads bad | What they saw | Mac side |
|---|---|---|---|
| Private (volume), run A: 300 / 300 | 0 of 300 | | 0 `index.lock` messages |
| Private (volume), run B: 400 / 900 | 0 of 900 | | 0 `index.lock` messages |
| Shared (plain bind, control) | 890 of 900 | 825 × `ls-files=0`, 1 status line (an empty index; untracked `src/` collapses to one line); 62 × `ls-files=0` with 3,022 or 3,023 status lines; 3 × all 3,022 files reported changed | 33 commits failed, 109 "Unable to create .git/index.lock: File exists" |
| Mac-local reader on the same `.git` (control for the control) | 0 (entries always 3,022, 1 status line) | | 4 commits failed, 8 `index.lock` messages |

With the Mac idle afterwards, the shared container read all 3,022 entries.

A first shared run used an unguarded `reset HEAD~1`, which walked the Mac's HEAD back 12 commits whenever a commit lost the lock race. I discarded that run's "stale Mac index" result and reset the repository.

### `git worktree add` in the container

`git worktree add -q -b wt1 .pi/worktrees/w1 HEAD` took 722 ms (3,021 files checked out through the share). The worktree's status was clean and a commit there worked. The Mac's fetch brought `refs/pi/wt1`.

On the Mac, `git status` inside `w1` fails with "fatal: not a git repository: …/fx/.git/worktrees/w1", because that gitdir exists only on the volume. The Mac's main repository shows `?? .pi/`.

With a VM mount at `w1/node_modules`, `git worktree remove --force` fails with "failed to delete '<w1>': Resource busy", rc 255. It removes the worktree metadata anyway and leaves the files in place. After `umount`, a second remove says "is not a working tree", rc 128. The folder is orphaned.

Meaning: git.md's design D works end to end on the VM: clean status, commit, fetch over `docker exec git upload-pack`, and fast-forward with the work tree untouched. Container git stayed correct while the Mac repacked and ran gc. The private index removed the empty-index reads, which the shared-`.git` control reproduced in 97% of reads under the same loop.

## L3. Descriptors per `git status`

Fixture `big` (`mkfx.sh 400 51`): 20,420 tracked files, 21 commits, packed (29 files in `.git`). Each measurement: drop, sleep 2, count, one `git status` through `docker exec` as uid 1000, sleep 1, count.

| Case | Mac fds added | Time |
|---|---|---|
| (a) shared `.git` (`sharedc`) | +20,839, +20,839 | 1.82, 1.75 s |
| (b) private git dir (`bigc`) | +20,828, +20,828 | 1.89, 1.84 s |
| (b′) private + `core.untrackedCache=true` only | +20,828, +20,828 | 1.37, 1.56 s |
| (c) private + `core.untrackedCache=true` + `core.fsmonitor=<hook on the volume>`, `core.fsmonitorHookVersion=2`, hook returns a token and no paths | +7, +7, +7 | 0.05 s each |

trace2 for (c): `fsmn read cache_nr:20420`, `query response-length:24`, `apply_count:0`, `preload sum_lstat:0`.

In (c) the base count rose 31 → 38 → 45 → 52. The 7 descriptors per run survived the drop. Not chased.

A first try at (c) pointed `core.fsmonitor` at a path the container cannot see. git printed "cannot exec" on stderr and silently did the full walk (+20,828).

Meaning: the descriptor cost is the work-tree walk, and owning `.git` changes it by only 11 descriptors. The fsmonitor hook removes the walk entirely (+7 instead of +20,828, 36× faster). The hook here answered "nothing changed" without a real watcher, so correctness still rests on the Mac watcher and its cookie barrier, which this lab did not build.

## L4. FSEvents for writes made by the guest

`watch.mjs` on the Mac: `fs.watch($V/watch, {recursive: true})`, logging `Date.now()` per event. 5 tries of, in `slave1` as uid 1000: `mkdir -p a$i/node_modules; echo x > f$i; date +%s%3N`.

| Source | Events | Latency |
|---|---|---|
| Container through the share | `a$i`, `a$i/node_modules` and `f$i`, all type `rename`, every time | 12, 9, 12, 10, 12 ms after the container's timestamp |
| VM root `mkdir` | seen | 13 ms |
| Mac `mkdir` | seen | 14 ms after the Mac's start time |

The VM clock fell between the Mac's start and end times of each `docker exec` (40 to 70 ms apart). Each event arrived before `docker exec` returned on the Mac.

Meaning: confirmed. Writes made by the container through virtio-fs raise FSEvents on the Mac, about 10 ms after the write.

## L5. Mount scale

The mount points (`$V/ms/p<i>/node_modules`) were made on the Mac. `mnt.sh` is a sequential `sh` loop as root in the VM: `mkdir /var/lab/m/$i; mount --bind …`. Running at the time: `slave1`, `gitc` and `bigc` with rslave, and `sharedc` with default propagation. Latencies are medians of 7 (exec) and 5 (run).

| Mounts | Time to make | `slave1` mountinfo lines | `docker exec slave1 true` | `docker run --rm … true`, rslave / default |
|---|---|---|---|---|
| 0 | | 25 | 0.037 s | 0.113 / 0.108 s |
| 500 | 256 ms | 525 | 0.038 s | 0.122 / 0.122 s |
| 2,000 | +873 ms for 1,500 more | 2,025 | 0.102 s (0.071 to 0.119) | 0.246 / 0.241 s |

- Mac fds with 2,000 mounts after a drop: 4,054. Each mount pins its mount point and that folder's parent on the share.
- Unmounting all 2,000: 1,127 ms. `slave1` went back to 25 lines, exec to 0.039 s, and the Mac fds to 87 after a drop.

Meaning: 2,000 propagated mounts cost about 0.5 ms each to make, add about 65 ms to `docker exec` and about 130 ms to container start, and pin about 2 Mac descriptors each. The limit is 100,000.

## L6. seccomp user notification

`sup.c` (raw ioctls, no libseccomp, built statically in alpine) listens on `/run/lab-sup.sock` in the VM. It receives the listener fd by `SCM_RIGHTS`, loops on `SECCOMP_IOCTL_NOTIF_RECV`, logs pid, syscall number and path (`pread` on `/proc/<pid>/mem` at `args[1]`), and replies `SECCOMP_USER_NOTIF_FLAG_CONTINUE`.

Profile:
```json
{"defaultAction":"SCMP_ACT_ALLOW","listenerPath":"/run/lab-sup.sock","syscalls":[{"names":["mkdir","mkdirat"],"action":"SCMP_ACT_NOTIFY"}]}
```

`docker run --rm --user 1000:1000 --cap-drop ALL --security-opt seccomp=profile.json lab sh -c 'mkdir /tmp/x; mkdir -p $V/sup/t/a/node_modules'` succeeded with rc 0.

- The agent received the state `{"ociVersion":"1.2.1","fds":["seccompFd"],…,"status":"creating"}`.
- It logged `nr=34` (`mkdirat` on arm64) for `/tmp/x` and for every component of `mkdir -p`. Those arrive as relative names (`private`, `tmp`, …, `node_modules`), so a real agent must resolve the dirfd through `/proc/<pid>/fd`.
- Cost of 20,000 `mkdir`s (`seq 1 20000 | xargs mkdir` in `/tmp`): 515 and 502 ms trapped, against 191 and 189 ms untrapped. That is about 16 µs per trapped call with a `CONTINUE` reply.
- The comparison is not exact. The trap profile's `defaultAction` is ALLOW, so it also replaces Docker's default filter. A real profile must merge the trap into Docker's default list.
- Failure mode: my first agent served one listener at a time and stayed blocked in `NOTIF_RECV` on the first container's fd after that container had exited. The next trapped container hung in its first `mkdir` until I killed it after 3 minutes. If the agent is missing or stuck, every `mkdir` in the container hangs.
- The forked version's children never saw `NOTIF_RECV` return after their container exited, so they leaked (5 processes at the end).

Meaning: Docker 29.5.2 with runc 1.3.5 accepts `SCMP_ACT_NOTIFY` with `listenerPath` and needs no extra flags. The trap works for a non-root container with no capabilities and costs about 16 µs per directory. The supervisor's liveness becomes a hard dependency of the container.

## Not run

- `npm`, `pnpm` and Bun under `strace`, and `npm ci` trapped against untrapped: no package manager in the image.
- The walk time on the real workspace: not the owner's machine.
- fanotify on virtio-fs, and the AppArmor refusal.
- The IDEA behaviour.
- The 1,000-try write-then-status race with a cookie file: needs a real Mac watcher behind the hook.

## Verdicts

| Claim | Document | Verdict |
|---|---|---|
| The VM's virtio-fs mount is in a shared peer group, so an `rslave` root bind receives later mounts | node-modules.md | confirmed (already `shared`, no change needed) |
| The container needs no capability for the mount to appear | node-modules.md | confirmed (uid 1000, all capabilities dropped) |
| Files written into the VM mount cost no Mac descriptors and do not reach the Mac | node-modules.md | confirmed (+0 against +20,201 for a plain folder) |
| `rm -rf node_modules` on the mount fails with "Resource busy" | node-modules.md | confirmed |
| `git worktree remove` with a mounted `node_modules` fails | node-modules.md | confirmed, and it also drops the worktree metadata, leaving an orphan folder |
| The helper can unmount while the container runs | node-modules.md (implied) | partly: fails "busy" while a container process is inside, unless `umount -l` |
| FSEvents fire for writes made by the guest through virtio-fs | node-modules.md, git.md | confirmed (9 to 12 ms) |
| Mount count limits are not a problem | node-modules.md | confirmed up to 2,000 (`mount-max` 100,000; exec +65 ms, start +130 ms, about 2 Mac fds per mount) |
| Docker's runc honours `listenerPath` with `SCMP_ACT_NOTIFY` | node-modules.md | confirmed (Docker 29.5.2, runc 1.3.5) |
| Trap cost per directory | node-modules.md | measured: about 16 µs per `mkdirat`; `npm ci` not run |
| npm, pnpm, Bun create `node_modules` with `mkdir` | node-modules.md | not run |
| Design D works end to end: private git dir, alternates, fetch over `docker exec git upload-pack`, Mac fast-forward with the work tree untouched | git.md | confirmed |
| Alternates fetch copies no objects | git.md | confirmed (0 local objects after setup) |
| Alternates read correctly during Mac `repack`, `gc` and `maintenance` | git.md | confirmed for log, object reads and status (0 failures in 1,378); `fsck` reports transient errors (10× more than Mac-local) |
| The empty-index window is gone with D | git.md | confirmed (0 of 1,200 with the private index; 890 of 900 with a shared `.git` as control) |
| A shared `.git` index read by the container can be empty | git.md (attempt 1) | confirmed, far more often than "half a second": 97% of reads during the loop |
| `.git` descriptors are small once packed; the walk is the cost | git.md | confirmed (shared and private differ by 11 fds; the walk is +20,828) |
| An fsmonitor hook plus untracked cache skips the walk over the share | git.md | confirmed (+7 fds, 0.05 s against +20,828, 1.8 s); not yet with a real watcher or cookie |
| `git worktree add` works in the sandbox git dir | git.md | confirmed (722 ms for 3,021 files); the Mac cannot use that worktree's `.git` |
| Setup time per repository | git.md | measured: about 0.2 s for 3,020 files, 1.3 to 3.1 s for 20,420 |
| Linux git version in the image is new enough | git.md | confirmed for alpine 3.24 (2.54.1); the VM's own git is 2.43 |

## Cleanup

`colima delete --profile nmgit-lab --force` deleted the instance but left the 852 MB data disk in `_lima/_disks/colima-nmgit-lab`. `colima delete --profile nmgit-lab --force --data` then removed it ("deleting container data … done").

Afterwards `colima list` shows `default` Running and `pinata` Stopped, as before. `docker context show` is `colima`, as before, and the `colima-nmgit-lab` context is gone. The profiles `pinata` and `default` were never addressed.
