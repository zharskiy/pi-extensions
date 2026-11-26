# Lab F notes (fdlab-f1)

Scratch: the scratch folder's `lab-f/` ($S)
Baseline kern.num_files before start: 6,621 (02:58). kern.maxfilesperproc 61,440.

## Setup
Trees built on the host in $S/share (python, 4.9 s): tree64k (q0..q3, 800 dirs x 20 files each), repo40k (2000 x 20, host git init/add/commit), tree20k (1000 x 20). 124k files total.
`colima start fdlab-f1 --vm-type vz --mount-type virtiofs --runtime docker --cpus 4 --memory 4 --disk 20 --mount $S/share:w`: 19.4 s; `docker context use colima` right after (context colima).
VM process PID 50158 (hostagent 50152, ssh mux 50182). default's VM 39113. Idle VM 12 fds.
Guest 6.8.0-117-generic, util-linux 2.39.3; docker: Cgroup Driver cgroupfs, cgroup v2.
Host fd counter $S/fdcount.py (libproc PROC_PIDLISTFDS); watchdog $S/watchdog.sh (sh, kern.num_files every 0.2 s, >100,000 -> colima stop --force fdlab-f1, max recorded in $S/watchdog.max).

## F3 partial prune via shrinker debugfs
Absent: debugfs is mounted but /sys/kernel/debug/shrinker does not exist; /boot/config-6.8.0-117-generic has `# CONFIG_SHRINKER_DEBUG is not set`. No per-superblock scan possible on the stock Ubuntu kernel. Stopped there.

## Harness
Clock offset guest - host over one ssh session (30 exchanges, best RTT 1.3 ms): +0.9 ms (+-0.7). Taken as 0; guest (bash EPOCHREALTIME) and host (python time.time) samples share one clock.
Docker in the lab VM: cgroupfs driver, every container in /sys/fs/cgroup/docker/<id>; /sys/fs/cgroup/docker holds only container cgroups (cgroup.procs empty; containerd-shim lives in system.slice/containerd.service), so one write to /sys/fs/cgroup/docker/cgroup.freeze freezes all containers (and any created during the freeze) and leaves the shims, dockerd and the governor running. Chosen over `docker pause` (API round trip per container, and it would collide with a user's own pause; a parent freeze is independent of the child's own cgroup.freeze). systemd driver would put them in system.slice/docker-<id>.scope (one write each); the script handles both.
Image labimg = ubuntu:24.04 + git. Load ($S/bin/load.sh, run as `docker run --rm -v $S/share:/s -v /root/lab:/lab labimg bash /lab/load.sh 30 ...`): 4 `ls -R` loops over tree64k quarters + `git status --porcelain` loop on repo40k (index warmed once in a container: 3.9 s then 0.27 s), 30 s; cold: `echo 2 > drop_caches` before each case (host count back to 12-74).
Per case: $S/run_case.sh (aborts if watchdog not running or governor unit not active), host sampler 20 ms nominal (~23 ms real at 60k fds), guest sampler 20 ms, governor as transient unit pgov (Nice -5), IDLE=10, TICK 0.1. Host max/median over the 30 s after the count first passes 100.
Governors: plain = prototype/share-governor.sh as is (plain remount); bp = prototype/share-governor-backpressure.sh (freeze /sys/fs/cgroup/docker, `mount --options-source=mtab -o remount`, 20 ms settle, recount, wait, thaw).
mtab form check: `mount --options-source=mtab -o remount <share>` on this VM: 42,066 -> 13,793 guest at +30 ms, host 42,033 -> 49 in 68 ms, /proc/mounts stays `virtiofs rw,relatime`. Works.

## F2 results (one VM, 30 s, cold; passes = completed ls -R passes per walker / git status runs)
| case | host max | host median | guest errors | passes | prunes | freeze ms min/med/max |
| ungoverned | 60,740 | 28,751 | 2 EMFILE | 24x4 / 1 git | 0 | - |
| plain 30,000 | 60,554 | 24,687 | 83 EMFILE | 27x4 / 1 | 56 | - |
| plain 20,000 | 60,444 | 18,112 | 97 EMFILE | 27x4 / 1 | 77 | - |
| bp 30k fixed 300 ms | 34,193 | 6,614 | 0 | 16x4 / 1 | 37 | 330/340/350 |
| bp 30k fixed 100 ms | 35,312 | 12,683 | 0 | 21x4 / 1 | 46 | 130/140/150 |
| bp 30k scaled 4 us/inode | 34,433 | 11,944 | 0 | 20-21 / 1 | 44 | 160/170/180 |
| bp 30k sync (stat --cached=never root) | 40,777 | 16,831 | 0 | 26x4 / 1 | 55 | 30/40/50 |
| bp 20k scaled 4 us/inode | 24,525 | 8,496 | 0 | 20-21 / 1 | 61 | 110/130/150 |
| bp 20k fixed 100 ms | 25,772 | 8,486 | 0 | 20x4 / 1 | 61 | 130/140/150 |
(freeze ms from /proc/uptime, 10 ms resolution, includes the 20 ms settle.) Watchdog max over all of this: 64,713 (the ungoverned case).
git status: one run took the whole 30 s in every case (ungoverned too: 32.5 s for one run under the 4 walkers), so the git column says nothing; the walkers carry the comparison.
Plain governor: host still hits ~60.5k (the late release seen in Lab E) and the guest gets MORE EMFILE than ungoverned (83-97 vs 2).
Host peak with bp = guest overshoot past the trigger before the 0.1 s tick sees it (before= 30.6k-35.8k at 30k, ~24-25k at 20k): host max ~ budget + 4.5-5.8k. With freeze the host follows the guest within one sample.
Timeline, bp fixed 300 at 30k (prune at t=0, host H / guest G): -0.011 H 30,508; +0.006 G 23,139; +0.013 H 9,548; +0.028 G 99; +0.037 H 6,481; +0.067 H 2,833; +0.087 H 252; +0.117 H 81 flat until thaw (+0.34), then both regrow together. => frozen, Apple closes ~30k fds in ~90 ms (~330k/s), same order as idle (42k in 68 ms).
Sync point does NOT work: in bp sync, stat --cached=never returned and the thaw came at ~+0.04 s with the host still at 6.7k; the ~6-7k unprocessed backlog then stayed as a constant host-minus-guest gap (H 8,067 vs G 1,332 at +0.068; H 40,777 vs G 34,614 at +0.567) until the next prune. A statx on the request queue is answered while FORGETs (hiprio queue) are still pending: no ordering between the queues.

## F1 where the release waits ($S/bin/f1.sh: kprobes p:fqf fuse_queue_forget, p:sf send_forget_request, p:hd virtio_fs_hiprio_done_work, p:hdw virtio_fs_hiprio_dispatch_work; trace_marker carries EPOCHREALTIME so trace times map to wall clock; host sampled every 10 ms; one remount under the running ungoverned load, then one with /sys/fs/cgroup/docker frozen for 0.4 s)
Not paused (guest 109,260 cached, host 45.8k at the remount; remount syscall 76 ms):
 fuse queued 111,406 forgets within 0.1 s (fqf 69,960 + 41,446), but send_forget_request was called 212,594 times (retries: the hiprio virtqueue is full, forgets wait on the guest's queued list and virtio_fs_hiprio_dispatch_work retries ~every 2 ms, 440 runs) and the sends kept going at ~5-7k attempts / 50 ms with only 112-340 completion-work runs per 50 ms until +0.95 s.
 host count did not fall at all from the forgets: 45.8k at +0.00, 42-43k through +0.35, then climbing 43.4k -> 53.7k (+0.65); it fell to 85 at +0.70-0.75 only by Apple's own purge (just under the 55.3k self-purge point), while the guest was still sending forgets.
Paused (guest 69,552, host 29.9k since Apple had purged shortly before):
 69,499 forgets queued and sent within 0.1 s (sf 78,286, only 36 dispatch retries), completion work 8,836 runs in the same 0.1 s; host 29,850 -> 14,094 (+0.00) -> 79 (+0.05) and flat at 79 until the thaw at +0.48, then regrowth ~3k / 50 ms.
Attribution: the wait shows up in the guest (forgets parked on the virtio-fs queued-forget list because the hiprio virtqueue is full) but its cause is Apple's process: under request load it drains the hiprio queue at a small fraction of its idle rate (completion work 4,038 runs over ~1 s loaded vs 8,836 in 0.1 s paused), so the forgets are starved by the lookups on the request queue. With no requests in flight the whole backlog is consumed in 50-100 ms.
Extra F2 case: bp 30k, scaled 3 us/inode, TICK 0.05: host max 32,938, median 12,876, 0 errors, 21x4 passes, 49 prunes, freeze 120/130/150 ms. Halving the tick halves the overshoot (detection latency x ~55k/s growth).

## F2 ordinary costs (workload in a container, drop_caches 2 then 4 runs back to back, IDLE=0; $S/costcase.sh; compare Lab E E2 pause 0, which ran in the guest)
| case | runs ms | host max | prunes | freeze ms min/med/max (sum) |
| git none | 4,169 276 275 235 | 42,073 | 0 | - |
| git plain 30k | 4,522 4,800 4,683 4,910 | 41,671 | - | - |
| git bp 30k scaled 4 us | 5,436 4,785 4,995 5,038 | 34,165 | 12 | 160/175/190 (2,100) |
| stat none | 2,678 1,397 1,414 1,426 | 55,234 | 0 | - |
| stat plain 30k | 3,226 3,526 3,515 3,541 | 33,007 | - | - |
| stat bp 30k scaled 4 us | 3,720 4,013 3,853 4,016 | 32,526 | 11 | 160/170/180 (1,880) |
Lab E E2 for reference (guest, not container): git none 3,450 235 274 237, plain 30k 5,010 4,737 4,663 4,667; stat none 2,407 1,451 1,385 1,416, plain 30k 3,179-3,281. Container numbers match.
=> the freeze adds ~0.1-0.5 s per run on top of the prune cost (sum of freezes ~0.5 s per run); the prune itself (re-lookups) is the main cost, unchanged. git plain host max 41.7k in a container (the late-release effect again), bp 34.2k.

## Saved scripts
prototype/share-governor-backpressure.sh (new; POSIX sh, root, cgroup v2; default freezes /sys/fs/cgroup/docker (cgroupfs driver) else every system.slice/docker-*.scope; default wait scaled 4 us per pruned inode, capped 1.5 s; traps EXIT/INT/TERM/HUP to thaw and thaws at start).
Verified with the saved file: budget 5000, fixed 1.5 s wait, `systemctl stop` while frozen -> cgroup.freeze 1 during, 0 after stop (trap works).
prototype/share-governor.sh: remount changed to `mount --options-source=mtab -o remount` (only change); re-run on the lab VM at budget 20k under one ls -R of tree64k: 3 prunes (20,988->1,134 etc.), mount stays rw,relatime.

## F4 one VM ungoverned, heavy load (cold, 30 s, container)
(a) $S/bin/f4.sh: `find tree64k tree20k repo40k -type f -print0 | xargs -0 -P8 -n 500 stat` loop + same with `grep -l zzz` (8 readers) loop + git status loop (124k files + .git): host max 58,073, median 27,354, above 58k for one 20 ms sample (0.02 s), never at 61,440; 0 guest errors (all stderr files empty, no dmesg lines). Passes: stat 3, grep 2, git 1. Apple purges near 55-58k (sawtooth).
(b) $S/bin/f4b.sh: 8 `ls -R` loops (q0..q3, q2 again, tree20k twice, repo40k) + git loop: host max 61,439 (the limit), above 58k in 4 stretches of 0-58 ms (total ~0.2 s), at >61k 0.04 s; guest 33 "Too many open files" (EMFILE) across 7 of 8 walkers; git 0 errors. 
SURPRISE in (b): after each hit the host count collapsed to ~13-23 and stayed there for seconds (e.g. +6 s to +9 s, +15 to +19 s, all sampled values 13-16) while 8 walkers were running; passes only 3-7 per walker in 30 s vs 24 per walker with 4 walkers in the F2 ungoverned case. Looks like a stall after Apple's EMFILE/purge, not investigated.
Also the F2 ungoverned case (4 ls -R + git, container): host max 60,740 and 2 EMFILE. So yes, one VM alone reaches 61,440 and its guest sees EMFILE, with ls -R-style (readdir + lstat) parallel walks; stat/grep walkers via xargs stayed at 58k.

## Skipped / limits
F3 stopped at "absent" (CONFIG_SHRINKER_DEBUG not set). git status loop under the 30 s loads completes one run per case, so its pass count carries no signal. Single run per case (no repeats). F4b stall not investigated. Wait candidate "sync -f" not tested (stat --cached=never already shows no ordering between the request and hiprio queues).

## Cleanup
Watchdog max over the whole lab 67,053 (never tripped; watchdog.log absent). `colima delete fdlab-f1 --force --data`: done. Stray `ssh: .../colima-fdlab-f1/ssh.sock [mux]` PID 50182 killed; no fdlab-f processes, no fdlab dirs under ~/.colima/_lima or ~/.colima, no colima-fdlab-f1 docker context; docker context `colima`; colima list: default Running, pinata Stopped. Scratch lab-f removed. kern.num_files 6,678 (baseline 6,621). Nothing installed on the Mac.
