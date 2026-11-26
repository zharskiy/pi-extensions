# Lab L (track T11): polling rule and untar variance

16:42-18:32 measuring. S = the scratch folder t11 (gone). Raw files and scripts: `prototype/share-kit/baseline-build-3/` (`raw/times.tsv` holds every step; `scripts/` the harness, paths written as S).
One VM, 4 vCPUs, 4 GiB, both shares of one Mac folder, runner `prototype/vzfs-hardened` (hb3 = this source).
Marks: [V] measured, [S] read in source, [G] guessed.

## Result

Final settings: `mode=serial xattr=1 no_flush=1 killpriv=2 keep_cache=3 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1 spin_empty=0 spin_hit=90`
(`spin_probe=16` default).
Rule: poll only after a notification that brought a request, and only while at least 90% of recent polls (EWMA 1/16) found a request; otherwise poll 1 chance in 16 to re-measure.

Five interleaved rounds (orders ours/Apple, Apple/ours, ours/Apple, Apple/ours, ours/Apple), ms [V]:

| load | ours | med | Apple's | med | ratio |
|---|---|---|---|---|---|
| clean build | 65176 67343 66127 67185 66030 | 66127 | 65215 64470 64975 64399 64834 | 64834 | 1.020 |
| no-change rebuild | 61350 60863 61472 62491 60783 | 61350 | 59940 61547 60160 60114 60314 | 60160 | 1.020 |
| untar 151,516 | 42030 42536 43195 43182 43231 | 43182 | 40470 37807 41051 32636 41433 | 40470 | 1.067 |
| find | 495 503 515 506 506 | 506 | 753 812 806 781 807 | 806 | 0.628 |
| rm -rf | 12610 13159 13488 13491 13430 | 13430 | 14381 14401 14392 14160 14524 | 14392 | 0.933 |

Mac CPU per load, medians [V]: build runner 7.3 s + VM 242.8 s (Apple's VM 243.5); rebuild 6.6 + 228.5 (228.8); untar runner 64.1 + VM 42.4 (Apple's VM 63.0).
Before this lab the runner used 11.7 s on the build and kept spinning 60 s (59.8 s CPU) after the untar.

Kit, 3 rounds, medians ours / Apple's [V]: stat walk cold 2,531 / 2,750 ms; warm 519 / 1,491; git status 200 / 291; eight `ls -lR` 13,210 / 13,575 (Apple's 25,247 once); eight walkers 463 / 30 passes, EMFILE lines 0 / 201.
CPU: pw2 runner 7.6 + VM 20.4 (Apple's VM 31.1); walks 7.4 + 6.8 (11.3); walkers 19.3 + 29.2 (30.8).
60 s guest idle after all of it: runner 0.02 s, VM 0.13 s.

## Part 1: the ideas (single runs of build and untar unless noted; same-hold Apple's build 64.9-66.0 s, untar 41.2-41.4 s)

- New finding first [V]: every request kicks and our polling does not suppress kicks, so the kicks of requests taken while polling come back later as empty notifications, queued on the serial device queue. Each one polled 50 us because the solo condition still held. After the untar that backlog spun a core for over 60 s (1.19M empty polls); during Apple's build it cost 24.5 s of runner CPU. Switch `spin_empty=0` (do not poll after a notification that took nothing): build 66,215 (runner 9.9 s), untar 43,008, after-untar tail 0 s. KEPT.
- Idea 1, priority while polling. `spin_yield=2` (thread_switch DEPRESS, aborted on a hit): build 69,308, untar 43,276. `spin_yield=3` (background QoS while polling): 67,911 / 42,752. No gain, REJECTED. The effective priority cannot be read without sudo: thread_info reports 31/31 even inside a depress [V].
- Idea 2, spare CPU. A sampler thread reads host_processor_info every 100 ms, only while requests arrive. `spin_idle=150` over CPUs 6-11: 66,131 / 42,927; it allowed polling in 354 of 357 build samples because the Perf cores 8-11 are half idle during the build. Over CPUs 6-7 with own CPU counted as idle (`spin_idle=50 idle_first=6 idle_last=7 idle_self=1`): 65,234 / 43,152, runner 7.3 s. It works, but needs a side thread and a CPU map. REJECTED in favour of idea 3.
- Idea 3, hit rate. `spin_hit=90`: 65,606 / 41,059, runner 7.4 s. With `spin_solo=0` also: 65,548 / 42,526. KEPT (spin_solo stays 8).
- Contention, one Mac `yes` during untar [V]: `spin_empty=0` alone gives 74,938 ms (416k missed polls: poller, hog and vCPU on CPUs 6,7). No polling gives 57,535. Final settings give 58,458: polling was refused 1.51M times, so the rule falls back to no polling. Apple's with the hog: 41,760 (31,542 in another run, see Part 2).
- Rejected ideas remain as switches defaulting off: spin_yield, spin_idle/idle_ms/idle_first/idle_last/idle_self. A stats line reports the empty polls, refusals per gate, probes and the hit estimate.

## Part 2: the untar variance

Explained [V]: it depends on which guest vCPU tar runs on. All virtio interrupts of both shares land on guest CPU0 (/proc/interrupts).

| tar pinned to | Apple's | ours |
|---|---|---|
| CPU0 (the interrupt vCPU) | 27,602, 27,643 | 33,422 |
| CPU2 | 41,207, 41,385 | 43,146 |

Unpinned runs land between or at the ends (Apple's 32,636 once in the final rounds, 31,542 once with a hog, otherwise 37.8-41.4 s).
Fast runs show tar user time 0.13-0.19 s instead of 0.8-1.0 s, sys 4.2 s instead of 6.2 s, and Mac VM CPU 46 s instead of 63 s.
[G] Off CPU0, each reply wakes tar with a cross-vCPU IPI: a VM exit plus a vCPU wake on the Mac.

Ruled out, Apple's share [V]:
- tarball in the guest page cache: 0% vs 100%, 41,203 vs 41,195;
- a fresh folder: 39,828, -3%;
- VM uptime 0.2-1.2 h: no drift;
- a background-QoS hog: 41,199;
- our runner's backlog spinning both CPUs 6 and 7 during Apple's untar: 41,248.

The `yes` hog result changed between runs (31.5 s, then 41.8 s), so it is not the cause by itself.
Mac side during each untar: fseventsd about 25 s CPU and mds about 15 s, on either share. Free space was 51 G of 229 G throughout (not varied).

In the fast placement ours is 21% slower than Apple's (33.4 vs 27.6 s); in the slow placement it is 5% slower.
Traced pinned run (bpftrace, untar+find+rm), average guest latency in us, Apple's / ours:

| op | Apple's | ours |
|---|---|---|
| SETATTR (454,548 each) | 11 | 20 |
| GETATTR (450k / 300k) | 14 | 23 |
| GETXATTR (300k) | 14 | 19 |
| WRITE | 13 | 22 |
| RELEASE | 12 | 23 |
| CREATE | 52 | 41 |
| LOOKUP (269k / 152k) | 28 | 19 |

Ours sends fewer requests (1.83M vs 2.24M) but each small op costs 6-11 us more. [G] That is our Mac round trip per request (notification, queue dispatch, reply); Mac-side service time per op was not split out in this lab.

## Correctness with the final settings [V]

- conform.sh: ours 40 PASS / 6 FAIL, Apple's 39 / 7, the same PASS/FAIL lines as lab K.
- confine: ALL PASS, 277 cases (the count lab K had).
- coherence.py --reps 10, both shares, exit 0, 320 observations each: later than 0.5 s ours 8, Apple's 31; no case where ours' worst delay is later than Apple's. Differences: Mac deletes a name 0.000 / 1.005 s, missing then created 0.002 / 1.001, replace by rename 0.000 / 0.799. The guest-to-Mac direction is 0.000 on both.
- The new switches live only in the queue loop of main.m. confine and the fuzzer drive fsserver.c, which did not change. The guest-side checks (conform, coherence) ran with the final settings.
- fuzz (UBSan, -fno-sanitize-recover, fsserver.c + fuzz.c, VZFS_KILLPRIV=2 VZFS_KEEP_CACHE=3): 2,000,000 requests, 3 threads, seed 20261125, PASS; sentinel UNCHANGED, handles max 512 of 512, no runtime error. An ASan build hangs in AsanInitInternal on this macOS and never starts (sampled), so UBSan only.

## Log
[S] main.m:928 device queue g_devq already QOS_CLASS_USER_INTERACTIVE (serial); notifications delivered on it (drain_requests in didReceiveNotificationForQueue).
16:47 VM booted hb0 (unmodified hardened), FINAL conf
16:50 lab: image copy, seed (user lab), guest 192.168.64.6, apt openjdk17/maven 3.8.7/bpftrace/git OK. Mac APFS volume 229G, 51G free (78%).
[V] Mac CPU numbering (cpuload = host_processor_info sampler, S/bin/cpuload.c): two `yes` land on CPUs 6,7; `taskpolicy -b yes` on 0-4 -> CPUs 0-5 Efficiency, 6-11 fast (Super+Perf; which two are Super not determined). 100 ticks/s per CPU -> 10 ticks per CPU per 100 ms, 60 per 100 ms over the 6 fast cores.
[S] bench.sh macro `drop` is `echo 2` (dentries/inodes only): the tarball stays in the guest page cache between runs unless step.sh (echo 3) or memory pressure evicted it.
[S] macro untars into share-kit-trees/macro.1 on BOTH shares: same Mac folder name reused by every run of either share.
Code (hb1, main.m): new switches spin_yield (1 sched_yield per poll, 2 thread_switch DEPRESS 1 ms at spin start + thread_depress_abort on hit/end, 3 background QoS during spin), spin_idle=N (+idle_ms, side queue at utility QoS samples fast-core idle ticks while requests come; poll only if idle >= N% of one core), spin_hit=N (+spin_probe=16; EWMA 1/16 of hit per poll; when below N%, poll 1 in spin_probe opportunities). New counters: polls ended empty, refusals per gate, probes.
16:49 hb1 boot (runner 33734, VM 33736). [V] thr (proc_pidinfo, S/bin/thr.c): VM process vCPU threads `com.apple.virtualization.thread.cpu-0..3` cur/base priority 31 (default QoS), one thread at 37; runner's device-queue thread logs qos 0x21 (user-interactive) at notification; sampled base 31 when parked.
Warm-ups (no lock, FINAL kp2 kc3): ours build 68,727 ms (332,090 req, hits 108,911, polls ended empty 68,520 -> poll hit rate 61%), runner 12.0 s, VM 246.0 s. ours untarT (bpftrace) 44,943 / find 530 / rm 13,895; 1,833,527 req; hits 1,682,578, empty 12,774 -> 99.2%; tar user 0.25 s sys 5.39 s; guest CPUs ~93% idle; tarball not in guest page cache (0%).
  untar ops (bt): SETATTR 454,548 (22 us), GETATTR 300,064 (24), CREATE 150,000 (42), GETXATTR 300,000 (20), UNLINK 150,000 (40), RELEASE, WRITE, LOOKUP 151,615; avg 25.9 us; max in flight 7.
  Apple build 66,353 ms; Apple untarT 44,016 / 784 / 14,501; tar sys 7.85 s.
FINDING [V]: during Apple's build (our share idle, 0 requests) our runner burned 24.5 s CPU: 493,609 notifications on the request queue and 151,512 on hiprio with NOTHING in them, each request-queue one polling 50 us (spin_solo test passes: the last caller run is the untar's). Test: Apple-only activity (stat loop, find) and guest disk/no-share activity -> 0 callbacks on ours, so it is not cross-device. find of tree20k on ours: 2,886 callbacks of which 2,871 empty, 3,363 requests taken while polling. [S of the stats + G]: every request kicks (no notification suppression), the kicks of requests we already took while polling arrive later as notifications and are queued on the serial device queue behind the drain loop; after untar's 1.68M polled requests a backlog of ~640k stale notifications drains over ~25 s at 50 us each.
  -> new switch spin_empty=0 (hb2): a notification that takes nothing does not poll.
hold 1 LOCK 16:58:18-17:01:31 (stopped early: ssh in v.sh ate the hold list on stdin; fixed with </dev/null). h1-base (FINAL, hb2 default spin_empty=1): build 67,205 ms runner 11.7 s VM 247.3; untar 43,023 / find 508 / rm 13,462, runner 65.2 s VM 42.3. AFTER the untar the runner kept polling 60 s (cap of the wait) at 1 core: 59.84 s CPU, 1,193,066 empty polls = the stale-notification backlog. [V]
[V] per-CPU busy (cpuload 1 s samples, mean over the step; CPUs 0-5 E, 6-11 fast): ours build: 6,7 at 98/97%, 8-11 at 35-58% (fast total 3.87 cores, E 0.25). ours untar: 6,7 at 91/91%, 8-11 1-2%. Apple's untar: 6,7 at 56/56%. -> the busiest threads always sit on CPUs 6,7 [G: the two Super cores]; in the build the Perf cores 8-11 are half idle, so "an idle fast core" exists during the build too; a spare-CPU rule over all six fast cores would not tell the loads apart. hb3 adds idle_first/idle_last (CPU range) and idle_self=1 (own process CPU counted as idle, max 1 core).
16:5x hold 1b LOCK (h1-apple, se0, dep, bg, idle) running.
h1b results [V]: Apple build 64,932 (VM 244.4), untar 41,442/881/14,386 (VM 64.2, tar sys 6.1 s). se0 (spin_empty=0): build 66,215 (runner 9.85 s, empty polls 30,907 vs 63,985), untar 43,008/509/13,423 (runner 65.3 s), tail after untar 0 s / 0 CPU (base: 60 s / 59.8 s). -> spin_empty=0 KEPT (removes the backlog spin; untar unchanged).
dep (spin_empty=0 spin_yield=2, depress at spin start, abort on hit): build 69,308 (runner 9.7 s), untar 43,276. No gain on either -> REJECTED (single runs).
[V] priorities unreadable without sudo: THREAD_SCHED_TIMESHARE_INFO of the serving thread gives cur 31 base 31 even with pthread_get_qos_class_np = 0x21 (UI) and even inside a thread_switch DEPRESS (expected 0); proc_pidinfo shows 31 for every thread of both processes. So the QoS is known (device queue UI 0x21; vCPU threads [G] default, base 31 reported), the effective priority is not.
bg (spin_empty=0 spin_yield=3, background QoS while polling): build 67,911, untar 42,752 -> no gain, REJECTED.
idle (spin_empty=0 spin_idle=150 over CPUs 6-11): build 66,131, untar 42,927; sampler allowed polling in 354 of 357 build samples (the Perf cores are half idle in the build) -> no separation, REJECTED in this form. Hit estimate at end of build 0.74, of untar 0.94.
hold 1b LOCK 17:02:52-17:13:53.
17:14 rebooted on hb3 (runner 37404, VM 37406). Hold 2 (h2b.txt) from ~17:16.
idleS (spin_empty=0 spin_idle=50 idle_first=6 idle_last=7 idle_self=1: poll only while CPUs 6,7 have >= 50% of one core idle, own CPU counted as idle): build 65,234 (runner 7.3 s, polling refused 128,021 times, hits 3,905), untar 43,152 (polls allowed throughout: 0 refusals). Build -1.5% vs se0, untar same.
hit (spin_empty=0 spin_hit=90, probe 1/16): build 65,606 (runner 7.4 s, refused 114,011), untar pending.
hit untar 41,059/512/13,492 (refused 22,534, probes 1,503; runner 62.3 s). Apple in same hold: build 65,967, untar 41,156/879/14,455. -> spin_empty=0 spin_hit=90 at Apple's level on both loads in single runs; candidate.
hitso0 (spin_solo=0 also): build 65,548, untar 42,526 -> no gain over hit. Hold 2 done 17:23. Part 2 hold p2.txt from 17:24.
Part 2 [V] (p2 hold, Apple's share, tarball cached, same folder macro.1):
  quiet 41,195/776/13,889 (VM 63.4 s, tar sys 6.17 s, CPUs 6,7 at 61%)
  one Mac `yes` hog (default QoS) 31,542/793/13,232 (VM 45.0 s, tar sys 4.13 s, CPUs 6,7 at 98%)  -> -23%
  one `taskpolicy -b yes` (background QoS, runs on E cores 0-5) 41,199 -> no effect
  => a default-QoS busy Mac thread makes Apple's untar 23% faster and cuts the guest's own sys time by a third: the guest's vCPUs run faster [G mechanism: cluster of CPUs 6,7 held at high frequency / out of idle; not separated from "vCPU threads kept off E cores"].
  ours (hb3 FINAL, spin_empty=1) untar then Apple's untar with no wait (`-nt`): ours 42,957; Apple's next 41,248 while our backlog spun (runner 55.4 s during it, CPUs 6,7 at 98%, VM 54.6 s, tar sys 5.21 s) -> our spinning thread does NOT give Apple's untar the `yes` speed-up, though it fills CPUs 6,7 the same. So "CPUs 6,7 busy" is not the separating variable [V]; the kind of load is [G: a polling loop at UI QoS vs a default-QoS integer loop; frequency cannot be read without sudo].
  Mac side during every untar of 150k files: fseventsd ~25 s CPU, mds ~10 s, mds_stores ~5 s (Spotlight indexes the scratch folder) [V via ps diff].
  ours spin_empty=0 untar 42,718 (tar sys 4.36 s, VM 41.6 s, CPUs 6,7 91%).
  ours with one `yes` hog, spin_empty=0 (polling on): 74,938/754/20,835 (!), misses 416,175, runner 87 s -> the poller, the hog and the vCPU thread fight over CPUs 6,7; polling under contention is very bad.
  ours spin_us=0 (no polling) quiet 56,703 (CPUs 6,7 62%), with hog 57,535 (CPUs 6,7 98%) -> on ours the hog gives nothing. So on ours the time is not in guest CPU speed but in the per-request round trip through the notification and the dispatch queue; Apple's path is the one that profits from a fast core [V numbers, G attribution].
  Apple's fresh folder name 39,828 (-3%); tarball evicted (echo 3, tarcached 0%) 41,203 (no effect). VM uptime 0.2-0.4 h over the hold, no drift. p2 hold LOCK 17:24-17:35:32.
Final candidate: FINAL + spin_empty=0 spin_hit=90. fin1 hold from 17:36.
Final rounds (FINAL + spin_empty=0 spin_hit=90, hb3), holds fin1 17:35:44-17:51:47 and fin2 17:51:53-18:07:52 [V]: see final table in the write-up. Apple's r4a untar 32,636 with no hog (tar user 0.41 s, sys 5.03, irq 6 jiffies) among 37.8-41.4 others.
Part 2 key: all guest virtio IRQs land on guest CPU0 (/proc/interrupts: virtio4/6 requests.0 and hiprio only on CPU0). Fast runs have low tar user time and low irq jiffies -> hypothesis: tar running on CPU0 (same vCPU as the completion IRQ) is the fast state. Test: `taskset -c 0|2 tar` (ut2.sh, PIN env).
  pin-a0 (Apple's, tar on CPU0): 27,602/777/13,956, tar user 0.18 sys 4.27, VM 46.4 s.
  pin-a2 (Apple's, tar on CPU2): 41,207 (tar user 0.92 sys 6.17, VM 63.4) ; pin-a0b repeat: 27,643.
  pin-o0 (ours FINAL+se0+hit90, CPU0): 33,422/528/13,509 (tar sys 3.25, VM 33.0, runner 55.2) ; pin-o2 (CPU2): 43,146.
  => UNTAR VARIANCE EXPLAINED [V]: the guest scheduler's placement of tar. On the vCPU that takes the virtio-fs completion interrupts (CPU0, all of them) Apple's untar is 27.6 s, on another vCPU 41.2 s; unpinned runs fall in between or at either end (Apple's 32.6 in r4a, 31.5 with a hog; the hog result is [G] a placement change too). Reproduced on purpose twice each. Same for ours: 33.4 vs 43.1. So in the fast state ours is 21% slower than Apple's; in the slow state 5%.
  [G] why: with tar off CPU0 each reply wakes tar via a cross-vCPU IPI (an exit to the Mac and a vCPU wake); on CPU0 the wake is local.
  pin-a2b repeat: 41,385.
  one `yes` hog again: Apple's 41,760 this time (31,542 earlier) -> the hog itself does not make Apple fast; the earlier 31.5 s was placement [V that it varies; G that placement was the cause in that run].
  ours FINAL (spin_hit=90) with one hog: 58,458 (polling refused 1,511,742 times, runner 40.3 s) vs 74,938 with spin_empty=0 alone and 57,535 with no polling -> the hit rule turns polling off under contention, back to the no-polling level.
Kit rounds 18:15:27-18:20:18 (3 rounds, FINAL+se0+hit90): raw res/kit/kit.tsv. Idle 60 s after (guest idle, both shares mounted): runner 0.02 s CPU, VM 0.13 s [V].
Traced pinned untar (CPU0, bpftrace fuseops; untar+find+rm), 18:21:38-18:23:45: Apple 28,808/900/38,711, ours 34,633/571/14,227. Per-op guest latency avg us Apple/ours: SETATTR 11/20 (454,548 each), GETATTR 14/23 (450,057/300,055), GETXATTR 14/19 (300,000 each), WRITE 13/22, RELEASE 12/23, CREATE 52/41, LOOKUP 28/19 (269,427/151,601), UNLINK 136/42, FLUSH 7/none. Total 2,242,233 req at 26.3 us vs 1,833,495 at 25.2 us. -> in the fast placement ours loses on the small ops: ~8-11 us more per SETATTR/GETATTR/GETXATTR/WRITE/RELEASE; 1.65M such requests x ~9 us = ~15 s of guest-visible latency, partly overlapped [V latencies, G that this is the per-request notification+dispatch round trip on the Mac side].
