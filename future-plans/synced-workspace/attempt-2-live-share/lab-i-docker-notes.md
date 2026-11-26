# Lab I notes (t5: Docker Desktop instead of colima?)

[V] measured here, [S] read in a source (URL), [G] guess.
Scratch: the scratch folder's `t5/` ($S). Started 2026-11-25 06:52 EET.

## State found (06:52)
- [V] Docker Desktop 4.100.0 (Info.plist CFBundleShortVersionString), engine 29.9.3, kernel 7.0.14-linuxkit, 6 CPUs, 8 GiB, swap 2 GiB. App processes running since ~2 days (com.docker.backend PID 48632, etime 02-08:22); engine STOPPED by Resource Saver (backend log 2026-11-24T20:36 "stopping linux/virtualization-framework engine", procd state `Idle:shutdown`; `docker info` answered from the backend's apicache). So the state to return to: app running, engine idle/stopped by Resource Saver.
- [V] settings-store.json (640 B, mtime Nov 22 22:30, sha256 1ec645dd7f25c52768f567dfee7a423f075f532830426e65e421031634337172) copied with `cp -p` to $S/orig/; features-overrides.json `{}` (ca3d163b...). No VMM or file-sharing key in the file: defaults apply.
- [V] Effective settings via `curl --unix-socket ~/Library/Containers/com.docker.docker/Data/backend.sock http://localhost/app/settings` (read only, saved $S/orig/api-settings.json): engineTypeMac `apple-virtualization-framework`, fileSharingTypeMac `virtiofs`, useResourceSaver true, autoPauseTimeoutSeconds 300, vm.fileSharing = /Users, /Volumes, /private, /tmp, /var/folders (all cached false), enhancedContainerIsolation false, canUseVirtualizationFrameworkVirtioFS true.
- [V] desktop-linux: 0 containers, 0 images, 0 volumes, networks bridge/host/none only. docker context current `colima`. colima: default Running, pinata Stopped. kern.num_files 6,861. Memory free 64% (memory_pressure).
- [V] Engine/file-share enum strings in com.docker.backend: engine `apple-virtualization-framework`, `docker-vmm`; settings fields EngineTypeMac, FileSharingTypeMac, migrations from legacy bools UseVirtualizationFramework / UseLibkrun / UseGrpcfuse / UseVirtualizationFrameworkVirtioFS. Docker.app/Contents/MacOS has com.docker.krun and Resources/linuxkit/libkrun.dylib.

## Desk facts (Q4)
- [S] https://docs.docker.com/desktop/settings-and-maintenance/settings/ : Mac VMM choice "Docker VMM" ("Docker VMM is in Beta") or "Apple Virtualization framework"; file sharing "Choose whether you want to share files using VirtioFS, or gRPC FUSE" (with Apple VZ); VirtioFS "is the only file sharing implementation supported by Docker VMM". Default shares "/Users, /Volumes, /private, /tmp and /var/folders". Settings file `~/Library/Group Containers/group.com.docker/settings-store.json`. No osxfs any more.
- [S] https://docs.docker.com/desktop/features/vmm/ : "Starting with Docker Desktop 4.86, it uses Docker's own VMM implementation instead of libkrun" (libkrun 4.35-4.85); "Docker controls the virtualization layer". The page does not say who wrote its virtiofs server. Known issue: MongoDB/Cassandra "may fail when using virtiofs with Docker VMM". No Rosetta. Apple silicon only.
- [S] https://docs.docker.com/subscription/desktop-license/ : free for "Small businesses (fewer than 250 employees AND less than $10 million in annual revenue)", personal use, education, non-commercial open source; larger organisations' professional use and government need Pro, Team or Business.
- [S] synchronized file shares: "available for customers with a Docker Pro, Team, or Business subscription" (docs settings reference / Docker blog https://www.docker.com/blog/announcing-synchronized-file-shares/); the feature page https://docs.docker.com/desktop/features/synchronized-file-sharing/ says step 1 "Sign in to Docker Desktop", ~2 million files per share.
- [V] On this install: `docker desktop auth status` -> "Not logged in"; backend `GET /registry/info` -> planName "personal", email "". So synchronized file shares are NOT available as it is (needs sign-in with a paid plan). Not tested.
- [V] Headless: `docker desktop start|stop|restart|status` exist in 4.100.0 (`docker desktop --help`), `stop --force`, `--detach`, `--timeout`. No settings subcommand; settings via settings-store.json (edited while stopped) or the backend socket (`/app/settings`). Admin-settings.json (locked settings) exists for Business only [S settings docs].

## Processes (VZ + VirtioFS, default)
- [V] Docker's VM process: `com.apple.Virtualization.VirtualMachine` PID 85068 (ppid 1, launchd), started with `com.docker.virtualization` PID 85058 (child of com.docker.backend services 48635). Another VirtualMachine (84864) appeared at the same time: lsof shows ~/.colima/_lima/colima-lab-t3-vz/vz-efi, i.e. track t3's VM, not Docker. 39113 = colima default.
- [V] Only 85068 grows with the walk; 85058 stays 31, backend 122-142.

## Q1 VZ + VirtioFS ($S/bin/q1.sh vzvfs; drop_caches before each N; `docker run --rm -v $S/share:/s lab-t5-img ls -R /s/<tree>`; lab-t5-img = ubuntu:24.04 + git 2.43.0)
| tree (entries) | before | after walk | after container exit | walk s |
| n3k (3,151) | 23 | 3,181 | 3,181 | 0.11 |
| n30k (31,501) | 45 | 31,553 | 31,553 | 1.12 |
| tree64k (67,205) | 65 | 48,235 (sampled peak 53,745, then purge to 37,455 at +2.0 s, regrow) | 48,242 | 2.33 |
idle 0 / 60 / 120 s after exit: 48,242 / 48,242 / 48,242 (no release while Docker Desktop idle, 2 min). drop_caches 2: 50 (+5 s: 50).
=> [V] exactly Apple's behaviour seen under colima: one descriptor per cached entry (+~30), purge near 55k, no fall on container exit or idle, fall only on guest cache drop.

## Q2 VZ + VirtioFS, Lab G F4B load (8 ls -R loops q0 q1 q2 q3 tree20k repo40k q2 tree20k + git status loop + 50 ms stat --cached=never probe), 30 s, cold, one container ($S/lab/f4b.sh, $S/bin/q2.sh, 20 ms sampler)
| run | host max | >55k s | >58k s | median | EMFILE | ENFILE | passes | probe max |
| 1 | 55,327 | 0.34 | 0 | 38,546 | 0 | 0 | 12 12 12 12 10 5 12 10 (git 1) | 58 ms |
| 2 | 55,341 | 0.28 | 0 | 38,302 | 0 | 0 | 9 9 9 9 7 4 9 7 (1) | 91 ms |
| 3 | 55,333 | 0.30 | 0 | 35,816 | 0 | 0 | 13 13 13 13 10 6 13 10 (1) | 60 ms |
[V] Different from colima (Lab G none: 59.5-61.4k, EMFILE 0-238, stalls to 4.4 s): Docker's VM stayed at Apple's purge point, no errors, no stalls in 3/3. [G] cause: Docker's guest (linuxkit 7.0.14, 6 vCPU) vs colima's Ubuntu 6.8 (4 vCPU) send requests at a different rate or with different FORGET handling; not investigated. Watchdog max 62,683.

## Context flip (coordinator, ~07:15)
- [V] Docker Desktop WAS running when I began (app up since ~2 days, engine stopped by Resource Saver). Another track saw `docker context` flipped to desktop-linux after my `docker desktop start` (07:08) and set it back; at 07:15 `docker context show` = colima, ~/.docker/config.json currentContext = colima. Rule from now: after every Docker Desktop start check and, if needed, `docker context use colima` (restore only).

## Q3 VZ + VirtioFS speed ($S/lab/bench.sh in a --privileged lab-t5-bench container; each run: sync + drop_caches 2 + 1 s, cold, then warm; ms)
- stat walk `find tree64k -type f -print0 | xargs -0 -n 500 stat` (64k files): cold 4,763 / 4,477 / 4,461; warm 1,536 / 1,625 / 1,518.
- `git -c safe.directory='*' status --porcelain` repo40k (40k files, index refreshed once first): cold 3,551 / 6,829 / 4,514; warm 322 / 364 / 283.
- tar xf of 151,516 entries (tarball copied to container /tmp first) into the share / find|wc / rm -rf: 46,989 / 2,750 / 11,701; 46,550 / 2,767 / 12,694; 46,104 / 2,981 / 12,660. Host max during tar 55,307.
- Apple baseline under colima: Lab H has none yet; reference is Lab G G2/G5 (colima 6.8 guest, 4 vCPU, same tree shapes, ubuntu container): git 4,103 cold / 234-278 warm; 67k stat walk 2,597 cold / 1,417-1,425 warm; tar extract 41.3-41.4 s, find 773-779 ms, rm 14.3 s. Not the same script (my stat uses -n 500, cold after 1 s pause) [G: comparable within ~10-20 %].

## Switch to VZ + gRPC FUSE (07:08)
`docker desktop stop` (11.6 s; settings-store.json byte-identical after stop), then python added `"FileSharingTypeMac": "grpcfuse"` to settings-store.json (indent 2, keys kept), `docker desktop start` (1.3 s to return, engine up ~15 s). API: engineTypeMac apple-virtualization-framework, fileSharingTypeMac grpcfuse. Docker rewrote the file sorted (key placed alphabetically). Mount in container: `grpcfuse /s fuse.grpcfuse rw,nosuid,nodev,relatime,user_id=0,group_id=0,allow_other,max_read=1048576`. New PIDs: VM 81819, com.docker.virtualization 81817, backend 81792/81793 (services)/81794. No dialog.

## Q1 gRPC FUSE ($S/bin/q1.sh grpc, sampled all five PIDs)
| tree | before | after walk | after exit | walk s |
| n3k | VM 19, backend services 133 | 19 / 149 | 19 / 135 | 0.22 |
| n30k | 19 / 133 | 19 / 148 | 19 / 135 | 2.03 |
| tree64k | 19 / 133 | 19 / 147 | 19 / 133 | 4.32 |
| n150k (157,501) | 19 / 133 | 19 / 133 | - | 9.8 |
idle 60/120 s 129/128, after drop 136. Sampler peak over all: VM 19, virtualization 24, backend services 154 (152 for n150k).
[V] Server = com.docker.backend (the `services` child, PID 81793): lsof every 0.5 s during the 150k walk found share files open only in it, 1 (15 samples) or 3 (1 sample) at a time. Flat: descriptors are opened per request and closed; no per-inode handle; no ceiling seen up to 157k entries.

## Q2 gRPC FUSE, same F4B load, 3 runs
| run | host max (backend services) | median | EMFILE | ENFILE | passes (8 walkers, git) | probe max |
| 1 | 189 | 184 | 0 | 0 | 835 836 844 833 676 321 846 678 (git 1) | 10 ms |
| 2 | 191 | 186 | 0 | 0 | 1030 1033 1042 1027 837 402 1050 839 (206) | 15 ms |
| 3 | 192 | 186 | 0 | 0 | 1016 1020 1034 1008 824 389 1032 824 (204) | 16 ms |
[V] ~80x the passes of VirtioFS (9-13): after the first pass the walks are served from the guest's cache. [G] grpcfuse keeps long entry/attr timeouts and caches directory listings in the guest, invalidated by host events; so warm metadata is guest-local. Coherence (host edits seen late?) not tested here.

## Q3 gRPC FUSE speed (same bench)
- stat walk: cold 11,081 / 11,052 / 11,052; warm 370 / 367 / 367. Host max 176.
- git status: cold 3,388 / 3,409 / 3,396; warm 60 / 61 / 60. Host max 178.
- tar 151,516 entries: extract 203,479 / 205,283 ms; find 6,393 / 6,233; rm 26,057 / 26,049. Host max 178. Only 2 runs: each takes ~4 min and the third would have passed the 20-minute lock; container killed during run 3, partial $S/share/x removed.

## Switch to Docker VMM (07:28)
`docker desktop stop`; settings-store.json = the saved original + `"EngineTypeMac": "docker-vmm"` (keys sorted, indent 2; FileSharingTypeMac not set, so default virtiofs); `docker desktop start`. API: engineTypeMac docker-vmm, fileSharingTypeMac virtiofs. No dialog (memory already 8 GiB >= 4 GiB). Context flipped to desktop-linux at this start [V]; `docker context use colima` at once.
- [V] Processes: no com.apple.Virtualization.VirtualMachine and no com.docker.virtualization for Docker; the VM runs in `com.docker.sailor` (child of com.docker.backend services). Resource Saver stopped it after 5 min idle and the next `docker run` started a new sailor (98844 -> 9333), which invalidated my first Q1 attempt (stale PID; discarded, $S/out/q1-vmm-stale).
- [V] Mount in container: `host /s virtiofs rw,nosuid,nodev,relatime,ignore_atime,no_xattr`. Server = com.docker.sailor itself (lsof: share dirs open in 9333 only).

## Q1 Docker VMM (sailor 9333)
| tree | before | after walk | after exit | walk s (cold) |
| n3k | 4,232 | 4,240 | 4,240 | 0.02 |
| n30k | 4,240 | 4,249 | 4,249 | 0.13 |
| tree64k | 4,249 | 4,261 | 4,261 | 0.29 |
| n150k (157,501) | 4,261 | 4,270 | 4,270 | 1.57 |
idle 60/120 s 4,270; after drop_caches 4,270 (+5 s 4,270). Sampled peak 4,272.
- [V] The guest really caches (slabinfo in a privileged container after drop + ls -R tree64k: fuse_inode 216 -> 67,284, dentry 3,900 -> 70,740; ls -R 0.275 s cold, 0.010 s warm), the host does not follow: lsof of sailor showed 4,114 DIR entries and no regular files; 4,097 of them n150k folders (the last tree walked, 7,500 folders) => one descriptor per DIRECTORY, LRU-bounded, files opened per request and closed.
- [V] Ceiling: after the Q2 loads 8,168 DIR; `ls -R /s` of all 15,373 folders + `cat` of every file (4 parallel xargs) -> sampled max 8,308, held 8,172 DIR. [G] an LRU of ~8,192 directory handles (4,096 seen after single walks). Not released by guest drop_caches, container exit or 2 min idle; released when the VM stops [G, sailor PID gone].

## Q2 Docker VMM, F4B load, 3 runs
| run | host max | median | EMFILE | ENFILE | passes (8 walkers, git) | probe max |
| 1 | 6,287 | 6,275 | 0 | 0 | 4474 4435 4544 4394 3979 2500 4482 3978 (1296) | 7 ms |
| 2 | 8,321 | 8,305 | 0 | 0 | 4130 3517 4292 4168 3714 1904 4298 3711 (1005) | 7 ms |
| 3 | 8,331 | 8,316 | 0 | 0 | 3739 3705 3802 3716 3313 1707 3776 3303 (880) | 45 ms |
=> ~350x VirtioFS-on-Apple passes, no errors, no stalls, host flat at the ~8.2k directory cap.

## Q3 Docker VMM speed (same bench)
- stat walk 64k: cold 883 / 609 / 616; warm 314 / 314 / 310. Host max 8,302.
- git status: cold 229 / 222 / 220; warm 15 / 15 / 15.
- tar 151,516: extract 14,742 / 14,862 / 14,404; find 244 / 240 / 302; rm 6,539 / 6,529 / 6,317.
- [V] coherence spot check (one container running, host edits): host rewrite of a file (3 -> 10 bytes) and a new host file seen by the next `docker exec` (+0 s, ~0.1 s later) with new content and size; guest-written file visible on the host at once. One check, not the T3 conformance kit.
- Docker VMM + gRPC FUSE: not offered ([S] settings docs: VirtioFS "is the only file sharing implementation supported by Docker VMM").

## Apple baseline under colima (Lab H D1, lab-t3-vz, 4 vCPU, guest 6.8) [V by T3]
stat walk cold 2,709-4,572 / warm 1,487-1,530; git warm 295-297 (cold: Lab G 4,103); 8 walkers 43-55 passes, 238-3,817 EMFILE lines, probe max 4.6-4.8 s; untar 39.8-42.2 s, find 766-818, rm 13.9-14.0 s.
Comparison (median, mine vs colima/Apple):
- Docker VZ + VirtioFS: stat cold ~4.5 s (colima 2.7 s, but my first-touch-free runs; [G] Docker guest/linuxkit or the Mac side cold), warm 1.5 s (same), git warm 322 (same), untar 46.6 s (+13 %), rm 12.7 s (-9 %). Same server, same growth; walkers clean here (no EMFILE), unlike colima.
- Docker VZ + gRPC FUSE: stat cold 11.1 s (2.5-4x slower), warm 0.37 s (4x faster), git cold 3.4 s / warm 60 ms (5x faster warm), untar 204 s (5x slower), rm 26 s (1.9x slower).
- Docker VMM: stat cold 0.6 s (4.5x faster), warm 0.31 s (5x), git cold 220 / warm 15 ms (20x), untar 14.7 s (2.8x faster), find 0.24 s, rm 6.5 s (2.2x faster).

## Q5 boundary (from launcher/THREAT-MODEL.md section 2 "Colima VM", ARCHITECTURE.md steps 5-6, and the settings above)
- pinata's VM shares exactly workspaceRoot (rw), <agent dir>/sessions (rw), <state>/vm (ro) and bind folders (ro), and pinata restarts its own `pinata` profile to that list; "a container escape (root in the VM) reaches those and nothing else of the host".
- [V] Docker Desktop's one VM shares /Users, /Volumes, /private, /tmp, /var/folders by default (this install: same list). Root in that VM (a container escape, or any `--privileged` / `-v /:/host` container of the user) reaches the whole home: ~/.ssh, ~/.pi/agent (config.json, CA key, grants), ~/.docker, ~/Library. Narrowing the list is a user-global setting that breaks the user's other Docker work; pinata can no longer restart "its" VM to an exact list.
- Same VM, same engine as the user's other containers: pinata's containers, networks and volumes sit next to theirs; a privileged container of the user (or of a compose project) sees pinata's sandbox and the reverse after an escape. `docker context`/`desktop-linux` socket is the same one every tool of the user uses.
- Settings belong to Docker Desktop (GUI, settings-store.json, Resource Saver which stopped the VM under me after 5 min idle, auto-updates, sign-in, Business-only admin-settings.json lockdown and Enhanced Container Isolation). pinata cannot pin VMM, file sharing, CPU/memory, kernel (linuxkit 7.0.14) or trust store the way it does for its colima profile; the in-VM steps (sudo sysctl drop_caches over colima ssh, extra CA install into the VM trust store, containerd restart) have no supported path (privileged container only).
- Licence: free only for <250 employees AND <$10M revenue, personal, education, non-commercial OSS; otherwise a paid seat per user. Synchronized file shares need Pro/Team/Business and sign-in.

## Cleanup (07:50)
- Watchdog stopped; max kern.num_files over the lab 67,971 (07:28, other tracks' VMs included); never tripped (no watchdog.log).
- Containers: all lab-t5-* removed (`docker ps -a` on desktop-linux: 0). Images: lab-t5-img and ubuntu:24.04 removed -> 0 images, as found. Volumes 0, networks bridge/host/none, as found. Build cache shows 83 entries / 6.36 GB (`docker system df`); I built nothing (image made by `docker commit`), not recorded at the start, untouched.
- Settings: `docker desktop stop`, `cp -p` of the saved settings-store.json, `cmp` identical, sha256 1ec645dd..., mtime Nov 22 22:30, 640 B; features-overrides.json identical. `docker desktop start`: file still identical 20 s later; API engineTypeMac apple-virtualization-framework, fileSharingTypeMac virtiofs. Docker Desktop running (app + dashboard process), as found; its engine is running now and Resource Saver (on, 300 s) will stop it when idle, as it was.
- Context: each `docker desktop start` flipped the current context to desktop-linux; restored with `docker context use colima` after the VMM start and the final start (the 07:08 start was restored by another track). Final `docker context show`: colima.
- colima list: default Running, pinata Stopped (untouched); lab-t3-vz is T3's. kern.num_files 6,678 at the end. Lock released (now held by t1). Scratch t5 emptied.
- No dialogs appeared; nothing signed in/out, updated, reset or installed.

## Follow-up: Docker VMM coherence, conformance, 30,000 directories (2026-11-25)

State found: Docker Desktop running (VZ + virtiofs), context `colima`, 0 images/containers/volumes;
settings-store.json sha256 1ec645dd...7172 and features-overrides.json saved. Switched with
`EngineTypeMac: docker-vmm` only. Guest kernel 7.0.14-linuxkit, HZ=1000, mount
`host /s virtiofs rw,nosuid,nodev,relatime,ignore_atime,no_xattr`. Image ubuntu:24.04 + python3, git, bpftrace.

### F1 coherence [V]

- Guest timeouts, read with bpftrace in a privileged container: `fuse_time_to_jiffies(3600, 0)`,
  `fuse_dentry_settime` and `fuse_change_attributes` deadlines = jiffies + 3,600,000. Entry and attr timeouts
  are **3600 s** (Apple: about 1 s). Negative lookups get deadline 0 (not cached).
- Coherence comes from push invalidation instead: a Mac rewrite, create, delete and rename fired
  `fuse_reverse_inval_inode` and `fuse_reverse_inval_entry` in the guest.
- `coherence.py --reps 5`, one agent process in the container (`docker exec -i`), worst case over 5 reps
  (rtt guest 0.7 ms): every mac->guest field 0.000 s except `new-name listed` 0.012, `rename old-gone` 0.012,
  `rename listed` 0.012. guest->mac all 0.000. Apple: deleted/rename old name 1.001, missing-then-created
  data 1.000, replace-by-rename 0.796.
- New `docker exec` per poll (`coh2.py`, exec rtt 39 ms, 5 reps): every case seen on the first exec after the
  change (0.000).
- Burst: 3,000 cached files changed on the Mac at once (1,000 rewrites with a new size, 1,000 renames,
  1,000 replace-by-rename): 0 stale at the first check 0.05 s later.
- A cached file appended through a hard link outside the shared folder: new size and data visible at the
  first check (about 1 s later) and stayed right.
- Not tested: changes while the host-side watcher is overloaded or lost (for example FSEvents dropping
  events). With 3600 s timeouts, a missed notification would leave the guest stale for up to an hour [G].

### F2 conformance (conform.sh, full, incl. 1 GiB file) [V]

Differences from Apple's baseline:

- **o_append-2-procs FAIL**: 3934/4000 lines. Repeated 3 times: 3924, 3916, 3910 of 4000. Guest-local /tmp
  got 4000 every time. Concurrent O_APPEND writers lose about 2 % of writes, and the Mac file is short too.
- **xattr-user FAIL**: EOPNOTSUPP. The mount is `no_xattr`, and security xattrs are not supported either
  (Apple: PASS).
- Ownership: `owner-as-user` 1000:1000. A file root created is shown to uid 1000 as owned by 1000, so the
  owner shown is whoever looks (Apple: 0:0). `owner-user-created` 0:0 664 (Apple 65534:65534 644).
- PASS where Apple failed: create-mode-0, chmod-setuid (4755 kept), symlink-dotdot-resolves-in-guest,
  mtime-ns-set.
- `name-256-rejected` passes, but with errno "Operation now in progress" instead of ENAMETOOLONG.
- `name-invalid-utf8-ff` fails with EACCES (Apple: EPERM).
- Same as Apple: chown accepted and ignored (rc 0, stays 0:0); perm-enforced-write FAIL; NFD == NFC;
  case-insensitive.
- Same as Apple: hard links, rename, unlink-open, mmap, flock/POSIX locks (guest-local), fifo, socket,
  fallocate, sparse files, 10,001-entry directory all PASS.
- 1 GiB: write+sync 829 ms, read+sha 650 ms (Apple 1207/655).

### F3 30,031 dirs / 150,000 files (built on the Mac, 7 s) [V]

- `ls -R`: cold first 1,909 ms, warm 55 ms, after walkers 56 ms, cold again 1,506 ms. 240,091 lines every
  time, 0 errors.
- stat walk (180k paths): cold 2,011 / 1,670 ms, warm 839 / 852 ms, 0 errors.
- 8 walkers x 90 s (whole tree each, shuffled order) + 50 ms uncached-stat probe: 999-1,058 passes each,
  0 errors, probe max 8.5 ms, p99 4.9 ms.
  - Guest cache is warm here (3600 s timeouts), so this mostly does not reach the server.
- Eviction stress: 8 walkers x 75 s with `drop_caches` every 2 s: 42-54 passes each, 377/377 passes with the
  identical line count, 0 errors, pass 57/140/3,711 ms (min/median/max), probe max 13.5 ms, p99 6.0 ms.
- sailor descriptors: 4,236 at start, 8,294 within 5 s, flat 8,292-8,304 for the whole run (both runs).
  kern.num_files max 14,879. Watchdog never tripped.
- No degradation on evict-and-revisit: the cold walk after all the load (1.5 s) was faster than the first
  (1.9 s).

### F4 desk facts

- User-level folder list: key `FilesharingDirectories` (`json:"filesharingDirectories"`) in
  settings-store.json, seen in the com.docker.backend binary strings [S: local binary].
  - Docs only describe the GUI list (Resources > File sharing) and name no key or CLI
    [S https://docs.docker.com/desktop/settings-and-maintenance/settings/].
  - Not exercised here: the brief allows changing only the VMM and file-sharing implementation keys.
- Admin-enforced allow-list: `filesharingAllowedDirectories` in Settings Management (admin-settings.json /
  Docker Admin Console, Business plan)
  [S https://docs.docker.com/enterprise/security/hardened-desktop/settings-management/settings-reference/].
  The live API here shows `vm.allowedFileshares: []`.
- Second Docker Desktop VM: no supported way. Docker Desktop runs one Linux VM per user, and no profile or
  instance option is documented [S https://docs.docker.com/desktop/features/vmm/].
  - Docker states that it does not support several Desktop instances on one machine for VDI
    [S https://docs.docker.com/desktop/setup/vm-vdi/].
  - [G] A separate tool needs its own VM (colima/lima) or a context into the one shared Desktop VM.

### Restore

- Stopped Docker Desktop and put the saved settings-store.json back with `cp -p`. `cmp` identical, sha256
  1ec645dd...7172; features-overrides.json identical.
- Started again (it was running when found); the API reports apple-virtualization-framework / virtiofs.
- The context flipped to desktop-linux on start and was set back to `colima`.
- Removed lab-t5-c, lab-t5-mk, lab-t5-img and ubuntu:24.04: 0 images, 0 containers, 0 volumes.
- Lock released, watchdog stopped, scratch t5 emptied.
