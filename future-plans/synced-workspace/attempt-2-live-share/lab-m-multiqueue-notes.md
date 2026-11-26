# Lab M (track T12): several virtio-fs request queues on a newer stock kernel

18:50-20:42 measuring (hard stop 20:50). S = the scratch folder t12 (emptied). Raw files and scripts: `prototype/share-kit/baseline-build-4/` (`raw/times.tsv` holds every timed step, `raw/rounds.tsv` the five rounds, `raw/kit/kit.tsv` the kit, `raw/stress-qt1.txt` the stall test, `raw/runner.log` the runner's stats; `scripts/` the harness, paths written as S).
One VM, 4 vCPUs, 4 GiB, both shares of one Mac folder, runner `prototype/vzfs-hardened` (hb2 = this source), guest Ubuntu 24.04 with the HWE kernel 7.0.0-44 (6.8.0-117 kept and booted once).
Marks: [V] measured, [S] read in source, [G] guessed.

## Result

Final settings: `mode=serial xattr=1 no_flush=1 killpriv=2 keep_cache=3 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1 spin_empty=0 spin_hit=90 spin_allq=1`, runner `--queues 4` (= vCPUs).
New switches (main.m only, all default off): `--queues N` (existed), `qthreads=1` (a serving thread per request queue), `qshared=1` (one shared polling state, the old behaviour), `spin_max=N` (cap on threads polling at once), `spin_allq=1` (one serving thread; while it polls after a request it also drains the other request queues to empty).
Polling rule with several queues: unchanged rule, kept per queue (hit estimate, caller run, probe counter per queue); one thread, so never more than one spinning thread at all; idle cost 0.02 s runner CPU in 60 s [V].

Stage 0 [S/V]: multiqueue (`mq_map`, `virtio_fs_map_queues`, managed IRQ affinity over the request vectors, queue = `mq_map[raw_smp_processor_id()]`) is absent at v6.9, present at v6.10 and the same in v7.0 [S]. Ubuntu 24.04 arm64: `linux-generic-hwe-24.04` = 7.0.0-44 [V]; 26.04 cloud image exists with 7.0.0-43 [V]. With 4 queues on 7.0: all 4 created, one MSI-X vector each, managed affinity one CPU each (CPU1,3,2,0), and a stat loop pinned to CPU k raised all its interrupts on the queue whose vector sits on CPU k [V]. On 6.8 the 4 queues are created but all vectors sit on CPU0 [V].

Five interleaved rounds on 7.0 (orders ours/Apple, Apple/ours, ours/Apple, Apple/ours, ours/Apple), ms [V]:

| load | ours | med | Apple's | med | ratio |
|---|---|---|---|---|---|
| clean build | 70790 70007 70230 70322 70165 | 70230 | 69298 69748 70423 69070 69876 | 69748 | 1.007 |
| no-change rebuild | 65881 66583 65916 65963 68227 | 65963 | 64995 65285 65456 65245 65183 | 65245 | 1.011 |
| untar 151,516 | 36788 36841 36811 36727 36748 | 36788 | 45478 45620 45433 45612 45662 | 45612 | 0.807 |
| find | 321 318 319 317 312 | 318 | 2749 2821 2823 2833 2826 | 2823 | 0.113 |
| rm -rf | 11564 11498 11539 11644 11542 | 11542 | 11966 11828 11840 11687 11756 | 11828 | 0.976 |
| untar pinned CPU0 | 36934 36532 | 36733 | 29634 29684 | 29659 | 1.239 |
| untar pinned CPU2 | 36770 36833 | 36802 | 45471 45469 | 45470 | 0.809 |
| four untars at once | 101767 102026 | 101897 | 85073 | 85073 | 1.198 |

Pinned runs: 2 per CPU per share, not 3; four untars: 2 ours, 1 Apple's (time). Pinned runs had the tarball in the guest page cache, the rounds did not.
Apple's single request queue has its vector on CPU0: pinned there Apple's untar is 29.7 s, anywhere else 45.5 s. Ours is 36.7-36.8 s wherever tar runs.

Kernel, 7.0 against 6.8 (same VM, Q=4) [V]: Apple's untar 45,612 (5 runs) vs 41715 33749 39249 (med 39,249): +16% on 7.0; Apple's build 69,748 vs 65,470: +6.5%. Ours untar 36,788 on 7.0 vs 42516 42634 on 6.8; ours on 7.0 with one queue (Q=1): 45,620, the same as Apple's. So the 19% gain of ours is the four queues, not the kernel.

Mac CPU, medians [V]: build runner 8.2 s + VM 261.3 (Apple's VM 261.3); rebuild 7.6 + 247.9 (246.6); untar 57.1 + 34.6 (67.8); four untars 155.6 + 163.9 (209.7). 60 s guest idle: runner 0.02 s, VM 0.15 s.

Kit, 2 rounds (not 3), ours / Apple's [V]: stat walk cold 2700 2284 / 2883 2844 ms; warm 575 575 / 1594 1591; git status 257 253 / 325 270; eight walkers 377 376 / 63 58 passes, EMFILE lines 0 0 / 1134 16; eight `ls -lR` 18452 18191 / 14157 14195 (ours 1.30x slower).

## One thread or a thread per queue

Single runs, ours, 7.0, Q=4 [V]: one thread (queues served one notification at a time): build 70.6 s, untar 36.1, four untars 144.3 (runner 221 s). Thread per queue (`qthreads=1`): 73.0, 38.0, 98.9 (216 s). One thread with `spin_allq=1`: 72.0, 36.6, 101.8 (155 s). Eight ls -lR: 17.4 / 18.3 / 18.2 s. Chosen: `spin_allq=1`, same speed as a thread per queue at 70% of the CPU.
Stall test of `qthreads=1` (four threads calling returnToQueue at once, each on its own queue, `ret_lock=0`): 600 s of eight `ls -R` walkers plus four untar loops (716 s wall), 71,198,858 requests sent and completed, none older than 2 s (longest 66.9 ms, bpftrace), pinned statx probes at most 66 ms, heartbeat watcher silent [V]. The earlier stall needed two threads on the same queue, which this mode never does [S].
fsserver.c is thread-safe [S]: node table, handle table, descriptor cache and directory snapshots each under their own lock, statistics atomic; the fuzzer drives it with 3 threads.

## Proof nothing regressed [V]

- confine on the host: ALL PASS, 277 cases. fuzz (UBSan) 2,000,000 requests, 3 threads, seed 20261125: PASS, sentinel unchanged. fsserver.c not changed.
- conform.sh on 7.0: ours 40 PASS / 6 FAIL, Apple's 39 / 7, the same lines as lab L on 6.8 for both shares (kernel changes nothing here).
- coherence.py --reps 10, both shares, rc 0, 320 observations each: later than 0.5 s ours 10, Apple's 32; no case where ours' worst is later than Apple's; guest to Mac 0.000 on both.
- Rule check: queues change only which CPU a request is served from; a request is answered as before, no caching or timing of what the guest sees changed [S].

## Still slower than Apple's

- Eight parallel `ls -lR`: 18.2 s vs 14.1 (1.30). With Q=1 on 7.0 ours is 13.5 s, on 6.8 13.0, so four queues cost it [V]; not polling (`spin_us=0`: 18.2 s) and not the thread count (`qthreads=1`: 17.4 s) [V]; runner CPU doubles (7.9 to 14.0 s) and VM CPU rises 21.4 to 33.7 s [V]; the cause is not measured [G: more notifications per request when eight walkers spread over four queues].
- Four untars at once: 1.20. Same with a thread per queue, so not the serving thread [V]; cause not measured [G: a lock in fsserver.c or APFS].
- Untar with tar on Apple's IRQ CPU: 1.24. Per request ours is slower on the small ops (traced, us ours/Apple's: SETATTR 21/15, GETATTR 23/11, WRITE 21/15, RELEASE 22/14, LOOKUP 18/11) [V]; Apple loses 18.8 s outside requests vs ours 5.2 s when tar is elsewhere [V]. That the 6-12 us are the Mac-side notification and dispatch round trip is [G].
- Build and rebuild: 1.007 and 1.011, within the spread of the runs.

## Running log

[S] virtio_fs.c multiqueue: absent at tag v6.9, present at v6.10 (mq_map, virtio_fs_map_queues, get_vq_affinity, irq_affinity pre_vectors=VQ_REQUEST; queue = VQ_REQUEST + mq_map[raw_smp_processor_id()]). Completion: vq callback -> schedule_work(done_work) (runs on the CPU of the IRQ).
[S] main.m already has --queues N (config space num_request_queues, virtioQueueCount 1+N); notification for any queue>0 -> drain_requests(q, hiprio) on serial g_devq.
18:52 lab: image copy (colima cache b0992ab8, Ubuntu 24.04.4), seed, hb0 = vzfs-hardened unchanged, --queues 4. IP 192.168.64.7.
[V] 6.8.0-117: guest creates virtio6-hiprio + requests.0..3, one MSI vector each (IRQ 39-42), all smp_affinity 0-3 effective 0. Apple's virtio4: hiprio + requests.0 only.
[V] apt-cache policy in guest: linux-generic-hwe-24.04 / linux-image-generic-hwe-24.04 candidate 7.0.0-44.44~24.04.1 (linux-generic 6.8.0-151). Installed linux-image-generic-hwe-24.04 -> 7.0.0-44-generic, grub default = 7.0, 6.8.0-117 entry kept in "Advanced options".
[V] Ubuntu 26.04 (resolute) arm64 cloud image exists (ubuntu-26.04-server-cloudimg-arm64.img), manifest linux-image-7.0.0-43-generic. Not used.
[S] v7.0 virtio_fs.c: same mapping (mq_map holds VQ_REQUEST+q), queue_id = mq_map[raw_smp_processor_id()].
[V] 7.0 boot (runner hb0 9789, VM 9791, 18:55): GICv2m-PCI-MSIX, ours requests.0 -> CPU1, .1 -> CPU3, .2 -> CPU2, .3 -> CPU0 (smp_affinity_list = effective, managed); hiprio/config 0-3 eff 0. Apple's virtio4 requests.0 0-3 eff 0.
[V] taskset -c k python stat+listdir loop x2000: k=0 -> 10001 IRQs on requests.3 (CPU0), k=1 -> requests.0 on CPU1, k=2 -> requests.2 CPU2, k=3 -> requests.1 CPU3. Each completion interrupt lands on the caller's CPU. Stage 0 passes with the unchanged runner (one serving thread, all queues on g_devq).
19:00 lab content: dubbo-3.2.20 clone + online package+clean through /mnt/vzfs/a/d (7.0 kernel), cp -Rp to b/d (diff 0); trees by mktree.py on the Mac, repo40k git on the Mac; src.tar into guest /var/tmp/share-kit.
Code hb1 (main.m only): per-queue polling state (struct qstate: caller run, hit estimate, probe counter, gap stamps; qshared=1 restores one shared state); qthreads=1 (one NSThread per request queue, notification on the device queue only sets pending+signals the semaphore); spin_max=N (cap on threads polling at once, default 0 = none); hiprio drained under g_hiprio_lock (trylock from spin loops); per-queue counters in the stats. --queues N clamps 1..63.
[V] hb1 qthreads=1, taskset loops on CPU0-3: four threads vzfs.q1..q4 started, each queue ~10,000 taken.
[S] fsserver.c shared state locked: node table + nocap + xa_none memo under fs->lock, handles hlock, fd cache fdlock, dir snapshot cache snaplock, per-handle snap_lock; op stats atomic. fuzz.c drives it with 3 threads (dispatch_apply). Earlier modes pool-direct/pool-hop/auto served on concurrent pool threads. main.m: big buffer free list under g_big_lock; serve() uses stack buffers; stats atomic; old polling globals now per queue.
19:08 stress qt1 (qthreads=1 ret_lock=0, 600 s, 8 ls -R walkers + 4 untar loops + 4 pinned statx probes + bpftrace) started under lock
19:09 [V] confine (hb1, VZFS_SET killpriv=2 keep_cache=3): ALL PASS, 277 PASS lines, rc 0 (raw res/confine.txt). fuzz (UBSan -fno-sanitize-recover=all, fsserver.c+fuzz.c of this source, VZFS_KILLPRIV=2 VZFS_KEEP_CACHE=3) 2,000,000 req, 3 threads, seed 20261125: PASS, sentinel UNCHANGED (res/fuzz.txt). fsserver.c not changed in this lab.
19:06-19:18 [V] STRESS qt1 (hb1, FINAL + qthreads=1, ret_lock=0: four serving threads each calling returnToQueue on its own queue, concurrently): 716 s wall (600 s of load + last untars), 8 ls -R walkers 11,436 passes, 16 untars of 151,516 entries (4 loops), 0 error lines; 71,198,858 requests sent = completed, none unanswered at the end, none over 2 s, longest 66.9 ms (bpftrace); pinned statx probes max 53-66 ms, heartbeat watcher 0 lines. Per queue 17.76-17.82M taken. Runner CPU 1593 s (2.2 cores), VM 1475 s. => returnToQueue from different threads on DIFFERENT queues: no stall in 71M requests. Same-queue concurrency never happens in qthreads=1 (one thread per queue). Raw res/stress-qt1.txt.
hb2 = hb1 + spin_allq=1 (qthreads=0 only: while polling, also drain the other request queues to empty).
19:18 booted hb2 (Q=4) on 7.0. ut4.sh copied to the guest at 19:19 (hold A's untar4 runs after that).
Hold A (19:18-) single runs, ours, qthreads=0 / qthreads=1 / spin_allq=1:
- A-qt0 build 70.6 s (first build after boot), untar 36.1 s / rm 11.5 s, untar4 144.3 s / rm 48.0 s (4 parallel = 4 x one untar: no overlap gain with one serving thread).
- A-qt1 build 73.0 s, untar 38.0 s / rm 11.4 s.
- A-qt1 untar4 98.9 s / rm 57.1 s (runner CPU 216 s).
- A-allq (one thread, polls drain all queues): build 72.0 s, untar 36.6 s / rm 11.4 s, untar4 101.8 s / rm 56.8 s (runner CPU 155 s, vs 221 s qt0 and 216 s qt1).
Decision: final = spin_allq=1 (one serving thread). Single untar is equal across the three (36-38 s, noise), untar4 qt1 ~= allq, both 30% faster than qt0, allq at 70% of the CPU. qthreads=1 stays a switch (stress-tested, no stall).
Hold B 19:33:45-19:53:48: R1 ours/Apple, R2 Apple/ours, R3 ours/Apple (final = FINAL + spin_allq=1, Q=4, 7.0). hC (19:53:48-) repeats R3 Apple once by mistake (my edit raced the guard), then R4 Apple/ours, R5 ours/Apple. Extra run reported separately.
R1-R3 [V]: ours build 70790 70007 70230, incr 65881 66583 65916, untar 36788 36841 36811 (find 321 318 319, rm 11564 11498 11539); Apple's build 69298 69748 70423, incr 64995 65285 65456, untar 45478 45620 45433 (find 2749 2821 2823, rm 11966 11828 11840). Apple's untar on 7.0: tar sys 7.1 s (ours 3.7), guest irq jiffies 217-233 (ours 3).
Hold C 19:53:49-20:10:39: R3 Apple again (extra), R4 Apple/ours, R5 ours/Apple. Five rounds (res/rounds.tsv = times.tsv without the extra), ms [V]:
build ours 70790 70007 70230 70322 70165 med 70230 / Apple 69298 69748 70423 69070 69876 med 69748 = 1.007
incr ours 65881 66583 65916 65963 68227 med 65963 / Apple 64995 65285 65456 65245 65183 med 65245 = 1.011
untar ours 36788 36841 36811 36727 36748 med 36788 / Apple 45478 45620 45433 45612 + R5 med 45545 = 0.808 (R5 Apple untar pending at time of note)
find 318 / 2822 = 0.113; rm -rf 11542 / 11834 = 0.975. CPU medians: build runner 8.24 + VM 261.25 (Apple VM 261.28); incr 7.56 + 247.94 (246.59); untar 57.10 + 34.63 (67.79).
Hold D 20:10:39-: pinned untar CPU0/CPU2 x2 each share, untar4 x1 each share (U2 dropped for time).
R5 Apple untar 45662 / find 2826 / rm 11756 (so Apple untar med over 5 = 45612; ratio 36788/45612 = 0.807; find med 2823; rm med 11828).
P1 [V]: ours untarP0 36934 (find 320, rm 11590), untarP2 36770; Apple untarP0 29634 (find 2904, rm 12391; tar sys 4.87 s, irq 1). Apple pinned on CPU0, the CPU of its one request IRQ, is 35% faster than Apple unpinned; ours is the same on CPU0, CPU2 and unpinned.
Pinned, 2 runs each (tarball in guest page cache in all pinned runs, 0% in the unpinned rounds) [V]: ours CPU0 36934 36532, CPU2 36770 36833; Apple CPU0 29634 29684, CPU2 45471 45469. find ours 320-339 / Apple 2862-2988; rm ours 11511-11590 / Apple 12303-12391. Apple CPU2: tar sys 7.2 s, guest irq jiffies 207-210; Apple CPU0: tar sys 4.9 s, irq 0-1. Ours: tar sys 3.7 s on either CPU, irq 1.
Hold D end 20:22:52. untar4 (four untars at once, wall until all done / rm of all four) [V]: ours (allq) 101767 (hold A) 102026 (U1) / rm 56845 57372, runner 155.4-155.8 s + VM 163.9 s; Apple 85073 / rm 59750, VM 209.7 s. Ratio 1.20. qthreads=1 gave 98923 in hold A (runner 215.8 s), so a thread per queue does not close it [V]; what serialises ours is not measured [G: fs->lock around the node table in fsserver.c, or the serial device-queue dispatch].
Hold E (kit 2 rounds, traced untar both, 60 s idle, conform, coherence) started 20:22:52, then h68 (reboot into 6.8: Apple 3 untars + 1 build, ours 2 untars).
Kit 2 rounds 20:22:52-20:26:11 (res/kit/kit.tsv) [V], ours / Apple's: eight ls -lR x5 18452 18191 / 14157 14195 (ours 1.30x SLOWER; lab L on 6.8 had 13,210 / 13,575); stat walk cold 2700 2284 / 2883 2844; warm 575 575 / 1594 1591; git status 257 253 / 325 270; eight walkers 377 376 / 63 58 passes, EMFILE lines 0 0 / 1134 16, probe max 0.4 0.3 / 1325 1131 ms. CPU pw2 runner 14.1 + VM 33.6 (Apple VM 33.0); walks 7.8 + 6.5 (13.2); walkers 21.5 + 33.2 (30.8).
Added to h68.sh: pw2 single rounds with qthreads=1, qthreads=0 without allq, allq (7.0), then allq on 6.8, to find what makes ours' ls -lR slower.
Traced untar (bpftrace fuseops, unpinned, untar+find+rm), 20:26-20:28 [V]: ours 37846/331/12055 (wall 50.2 s), Apple 48363/2880/12220 (wall 63.5 s). Sum of guest-seen request latency: ours 1,821,381 req, 24.7 us avg, 45.0 s; Apple 2,121,431 req, 21.1 us avg, 44.7 s. Time outside requests: ours 5.2 s, Apple 18.8 s. Per op avg us ours/Apple: SETATTR 21/15, GETATTR 23/11, GETXATTR 20/21, WRITE 21/15, RELEASE 22/14, LOOKUP 18/11, CREATE 41/54, UNLINK 39/31, READDIRPLUS 62/1614. Tar sys 4.2 s / 8.9 s, guest irq jiffies 4 / 268.
Hold E end 20:31 [V]: 60 s guest idle: runner 0.02 s, VM 0.15 s CPU.
conform.sh (7.0, final): ours 40 PASS / 6 FAIL, Apple 39 / 7; PASS/FAIL lines identical to lab L's (6.8) on both shares except values (inode numbers, host name). My output filter `grep -v resolve` (for sudo's host warning) dropped the line symlink-dotdot-resolves-in-guest from both files; re-run by hand on both shares: "../../(...)/etc/passwd root" = PASS. So no kernel-only difference in conform.
coherence.py --reps 10, both shares, rc 0, 320 observations each: later than 0.5 s ours 10, Apple 32; no case where ours' worst is later than Apple's worst by more than 50 ms; differences: Mac deletes a name 0.000 / 1.001, missing then created 0.002 / 1.001, replace by rename 0.000 / 0.799. Guest->Mac 0.000 on both.
h68 20:32:54-20:39:12, guest on 6.8.0-117 (grub-reboot one-shot, GRUB_DEFAULT=saved set, default stays 7.0), Q=4 (6.8 uses only the first request queue [S]) [V]: Apple untar 41715 33749 39249 med 39249 (find 876 781 783, rm 14198 13868 13748), build 65470; ours untar 42516 42634 (find 513 514, rm 13603 13530). pw2 6.8 ours 12993 (runner 7.6 + VM 20.3) / Apple 13317 (VM 30.8).
pwx on 7.0 Q=4 (20:31-20:32): ours pw2 qthreads=1 17381, qthreads=0 18272, allq 18164; Apple 14120.
20:39 7.0 with Q=1 (one request queue, IRQ on one CPU) [V]: ours untar 45620 / find 394 / rm 13507, guest irq jiffies 177, runner 66.0 s; pw2 ours 13451 / Apple 14082.
=> On 7.0 four queues take ours' untar from 45.6 s to 36.8 s (-19%), and make eight parallel ls -lR 35% slower (13.5 -> 18.2 s). A thread per queue does not remove it (17.4 s).
