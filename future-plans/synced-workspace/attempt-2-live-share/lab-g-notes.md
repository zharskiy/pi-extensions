# Lab G notes (fdlab-g1)

Scratch: the scratch folder's `lab-g/` ($S)
Baseline kern.num_files before start: 6,678.

## Setup (same shape as Lab F)
Trees rebuilt on the host in $S/share (tree64k q0..q3, repo40k with host git commit, tree20k; 124k files). `colima start fdlab-g1 --vm-type vz --mount-type virtiofs --runtime docker --cpus 4 --memory 4 --disk 20 --mount $S/share:w`, then `docker context use colima`. VM process PID 64474 (hostagent 64468, ssh mux 64480). Image labimg = ubuntu:24.04 + git; git index warmed in a container once.
Watchdog $S/watchdog.sh (sh, 0.2 s, >100,000 -> colima stop --force fdlab-g1), started before the first load (PID 64742); $S/case.sh aborts if it is not running or the governor unit is not active.
Driver $S/case.sh NAME GOV BUDGET LOAD [env]: drop_caches 2, transient unit pgov (Nice -5), host 20 ms sampler, `docker run ... labimg bash /lab/<load>.sh 30`, summary by $S/summ.py (host max over 30 s after count > 100, time above 58k/61k from sample intervals, EMFILE/ENFILE counts from all stderr files, passes, freezes from the journal frozen_ms).
Loads: f4b = 8 `ls -R` loops (q0..q3, q2 again, tree20k twice, repo40k) + git status loop + a probe (`stat --cached=never` of one file every 50 ms, latency logged); f2 = Lab F's 4 ls -R + git loop. Each walker logs the end time of every pass.
Build tarball for G5: 151,516 entries (1,500 dirs x 100 small .c files under 15 parents), made with python on the VM's disk (/root/lab/src.tar, 154 MB), not on the share.

## G1 F4b load, 30 s, cold, 3 runs each (bp = share-governor-backpressure.sh, budget 50,000, TICK 0.1, scaled 4 us, IDLE 10)
| run | host max | >58k s | >=61k s | median | EMFILE | ENFILE | passes (8 walkers: q0 q1 q2 q3 tree20k repo40k q2 tree20k) | freezes |
| none 1 | 61,440 | 0.21 | 0.06 | 1,318 | 238 | 0 | 8 8 8 8 7 4 8 7 (git 1) | - |
| none 2 | 59,553 | 0.10 | 0 | 7,862 | 0 | 0 | 9 9 9 9 7 4 9 7 (1) | - |
| none 3 | 61,104 | 0.14 | 0.02 | 1,940 | 22 | 0 | 8 8 8 8 7 3 8 6 (1) | - |
| bp50 1 | 55,135 | 0 | 0 | 20,376 | 0 | 0 | 13 13 13 13 11 6 13 11 (1) | 26, 270/280/290 ms |
| bp50 2 | 54,998 | 0 | 0 | 20,243 | 0 | 0 | 13 13 13 13 11 6 14 11 (1) | 26, 260/280/290 ms |
| bp50 3 | 55,614 | 0 | 0 | 20,654 | 0 | 0 | 13 13 13 13 10 5 13 10 (1) | 25, 270/280/290 ms |
50,000 never touched 61,440 and gave no guest error in 3 of 3 runs; 45,000 and the 0.05 s tick not needed. Peak 55.0-55.6k = budget + ~5k overshoot per 0.1 s tick, right at Apple's own purge point (55,296), 5.8k below the limit. Governed runs complete ~55-60 % MORE passes than ungoverned (13 vs 8-9 per walker).
Watchdog max over G1: 66,924.

## G6 the stall (from the G1 runs: per-second passes and the 50 ms `stat --cached=never` probe; $S/g6.py)
Ungoverned run 1: the host count sits at 12-21 for whole seconds (s 8, 14, 18-20, 23, 29-30) and in those seconds no walker completes a pass and the probe gets 0-4 samples: a single statx took up to 4,405 ms (others 875, 1,294, 1,324, 1,426, 1,510, 1,622, 4,119 ms). Probe over the 30 s: run 1 279 samples, max 4,405 ms, 10 calls > 0.5 s, 18.5 s summed in calls > 0.1 s; run 2 315 samples, max 3,644 ms, 11 > 0.5 s, 13.7 s.
Governed bp50: probe 450 / 459 samples, max 14 ms / 289 ms (the 289 is a freeze: the probe runs in a frozen container), 0 calls > 0.5 s, 0.0 / 0.6 s summed > 0.1 s; passes complete every second.
=> after Apple's server hits its ceiling (its self-purge near 55-61k), every request of the guest blocks for 1-4.4 s while the host holds ~15 fds: the walkers are blocked, not the counter. So "no governor costs nothing" is false under heavy parallel walks: ungoverned loses ~40 % of the throughput and has multi-second request stalls; the governor at 50k avoids them.

## G3 freeze robustness ($S/bin/g3.sh, a container running ls -R loops)
A. transient unit (no ExecStopPost), kill -9 of the governor while /sys/fs/cgroup/docker was frozen: still frozen 3 s later (cgroup.freeze 1, unit failed). Containers stay frozen until something writes 0.
B. unit with `ExecStopPost=/bin/sh gov-bp.sh --thaw`, Restart=always, RestartSec=1: 3 x kill -9 while frozen -> thawed 127, 118, 120 ms after the kill (ExecStopPost runs at once; restart 1 s later gives a new MainPID, active). Worst frozen time = time already spent in the freeze (at most the wait cap, 1.5 s, plus settle) + ~0.12 s. After `systemctl stop`: freeze 0.
 (My container tick-gap measurement broke: truncating its log while bash appended produced garbage; the freeze-file timings above are the evidence.)
C. manual 4 s freeze: `docker ps` returned in 0.01 s; `docker exec tick true` returned rc 0 at 4.03 s; `docker run --rm labimg true` rc 0 at 4.11 s (thaw at 4.01 s). They wait for the thaw, neither hang nor fail.
Script change: `share-governor-backpressure.sh --thaw` writes 0 to every freeze file and exits; header documents it. Systemd driver: cgroups() lists docker-*.scope at each freeze/thaw, so a container started during a freeze is NOT frozen (escapes that freeze; harmless, thaw writes 0 to it). The cgroupfs parent freeze covers new containers (C shows docker run waited).
`PINATA_SHARE_FREEZE=none` (with any wait, the wait applies only when frozen) runs the same loop as share-governor.sh (both now use the mtab remount, 20 ms settle, same trigger and idle logic): share-governor.sh is redundant. (Note: it is FREEZE=none that disables the freeze; WAIT=none still freezes and thaws right after the settle.)
prototype/pinata-share-governor.service now runs share-governor-backpressure.sh with BUDGET 50000, TICK 0.1, IDLE 0, WAIT scaled, WAIT_US 4, ExecStopPost --thaw, Restart=always.

## Idle switch
PINATA_SHARE_IDLE=0 already turns the idle release off (idle_ms 0 short-circuits the idle test); header now says so. Check: governor at 50k, IDLE=0, one ls -R of tree20k, then 62 s quiet: guest fuse_inode 21,042 -> 21,042, host 21,065 -> 21,065, no prune. G2 ran with IDLE=0.

## G2 ordinary costs (container, drop_caches 2, 4 back-to-back runs, IDLE 0)
| work | none ms | bp50 ms | bp50 prunes/freezes | host max none / bp50 |
| git status 42k repo | 4,103 278 234 236 | 4,192 281 281 283 | 0 | 42,090 / 42,065 |
| find tree64k | xargs stat (67k) | 2,597 1,425 1,417 1,418 | 3,240 3,950 3,262 3,804 | 6, 260-270 ms | 55,218 / 52,522 |
| find all | xargs stat (124k) | 5,197 2,768 2,796 2,793 | 7,177 7,247 7,297 7,926 | 13, 250-290 ms | 55,300 / 54,631 |
git below budget: no prune, same time (281 vs 235-278 ms). Working sets above 50k pay the full prune: 67k walk 2.3-2.8x, 124k walk 2.6-2.8x warm. Sequential single walks ungoverned stay at ~55.3k without errors (Apple's purge keeps them below the limit).

## G4 repeats of the F2 load (4 ls -R + git, 30 s, cold; bp 30,000 scaled 4 us, IDLE 10)
| run | host max | >58k s | >=61k s | median | EMFILE | passes per walker | freezes |
| none 1 | 59,888 | 0.09 | 0 | 28,872 | 26 | 24 | - |
| none 2 | 60,365 | 0.05 | 0 | 29,065 | 80 | 24 | - |
| none 3 | 61,218 | 0.06 | 0.03 | 27,006 | 96 | 21-22 | - |
| bp30 1 | 33,918 | 0 | 0 | 11,546 | 0 | 20 | 44, 160/180/190 ms |
| bp30 2 | 35,591 | 0 | 0 | 11,787 | 0 | 20 | 44, 160/180/200 ms |
| bp30 3 | 35,648 | 0 | 0 | 11,142 | 0 | 19 | 43, 160/170/190 ms |
git: 1 run per case throughout (as in Lab F). Ungoverned EMFILE 26-96 in 3 of 3 runs (Lab F's single run had 2): the F2 load alone gives the guest EMFILE every time. Lab F's bp30 numbers (34.4k, 0 errors, 20-21 passes) reproduce.

## G5 build-like macro (container: tar xf of 151,516 entries into the share, find | wc -l, rm -rf; tarball on the VM disk; IDLE 0)
| run | extract ms | find ms | rm ms | host max | errors | freezes ms |
| none 1 | 41,439 | 773 | 14,293 | 55,306 | 0 | - |
| none 2 | 41,282 | 779 | 14,265 | 55,302 | 0 | - |
| bp50 1 | 41,475 | 768 | 13,719 | 50,288 | 0 | 270 270 270 |
| bp50 2 | 42,100 | 761 | 13,847 | 50,218 | 0 | 270 260 280 |
| bp30 1 | 41,982 | 952 | 14,104 | 32,392 | 0 | 6 x 160-170 |
| bp30 2 | 42,011 | 951 | 14,035 | 31,683 | 0 | 6 x 160-170 |
Write-dominated build: the governor costs ~0-2 % at 50k and 30k (find +23 % at 30k because of a prune before it); ungoverned stays at Apple's purge point (55.3k) with no errors, single-threaded.

## Skipped
45,000 and 50,000 at 0.05 s tick (not needed: 50,000 at 0.1 s was clean in 3/3). G6 per-syscall latency via kprobes (the probe statx + passes per second were enough). Container tick-gap measurement in G3 failed (see G3).

## Cleanup
Watchdog max over Lab G 68,141 (never tripped, no watchdog.log). `colima delete fdlab-g1 --force --data` done; stray ssh mux PID 64480 killed; no fdlab-g processes, no fdlab dirs in ~/.colima or ~/.colima/_lima, no fdlab docker context; docker context `colima`; colima list: default Running, pinata Stopped. Scratch lab-g removed. kern.num_files 6,679 (baseline 6,678).
