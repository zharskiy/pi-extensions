# Lab N (track T13): several create-heavy loads at once, stock 6.8, one request queue

20:46-21:26 (measuring 20:51-21:25). S = scratch t13 (emptied). Raw: `prototype/share-kit/baseline-build-5/raw/` (`times.tsv` every timed run, `*.stats` runner stats per run, `*.bt.untar` / `*.bt.rm` bpftrace, `*.nf` kern.num_files peak); scripts `prototype/share-kit/baseline-build-5/scripts/` (`utN.sh` guest driver, `run.sh` per run, `hold.sh`, `busy.py`).
Marks: [V] measured, [S] read in source, [G] guessed.

## Lab

Fresh VM (lab J recipe): colima's cached Ubuntu 24.04.4 image, 24 GiB raw, 4 vCPUs, 4 GiB, guest kernel 6.8.0-117-generic (image default, no other kernel installed; `/boot` holds only 6.8.0-117) [V]. Runner `prototype/vzfs-hardened` built into S, no `--queues` (log: `request queues 1 qthreads 0 qshared 0 spin_max 0 spin_allq 0`), settings exactly `mode=serial xattr=1 no_flush=1 killpriv=2 keep_cache=3 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1 spin_empty=0 spin_hit=90` (FUSE_INIT line confirms) [V]. Tarball: `mktree.py` src.tar, 151,516 entries, on the guest's disk. Both shares of one Mac folder. Each run: `sync; drop_caches 2`, N `tar xf` at once into `macro.p1..pN`, wall until all done, `find | wc` (not timed), N `rm -rf` at once. Ours remounted before each run.
Holds: A 20:51:39-21:03:42 (four untars), B 21:03:46-21:19:39 (two untars, single anchor; its traced pair aborted, see below), C 21:19:49-21:25:22 (traced four untars).

## Results, ms [V]

| load | ours | med | Apple's | med | ratio |
|---|---|---|---|---|---|
| four untars at once | 82386 82394 81983 | 82386 | 81011 81052 80966 | 81011 | 1.017 |
| rm -rf of the four at once | 29954 27977 29228 | 29228 | 32426 32447 32805 | 32447 | 0.901 |
| two untars at once | 61113 60814 60689 | 60814 | 52731 52041 52617 | 52617 | 1.156 |
| rm -rf of the two at once | 21858 21831 21823 | 21831 | 20275 19325 20068 | 20068 | 1.088 |
| single untar (anchor) | 44111 | | 41878 | | 1.053 |
| single rm (anchor) | 13924 | | 13894 | | 1.002 |

Orders: four untars ours/Apple, Apple/ours, ours/Apple; two untars the same. Every tar and rm exit 0, 606,068 (151,517 x N) entries found, nothing left after rm, zero tar/rm stderr lines, zero new dmesg lines (utN.sh runs as root) on both shares [V]. Traced four untars (bpftrace on, so slower): ours 85921 / rm 30402, Apple 86377 / 32321.
Anchor: ours 44.1 s (expected about 43), Apple 41.9 s (in 33-42 range).
So on 6.8 with one queue, four untars at once are at parity with Apple's (+1.7%), not 20% slower as on 7.0/Q=4 (101.9 vs 85.1 s). Two at once is the worst case here: +15.6%.

## Guest view, traced four untars [V]

Untar phase: ours 6,031,391 requests in 85.9 s = 70.2 k req/s, avg 47.8 us; Apple 7,231,400 in 86.4 s = 83.7 k req/s, avg 38.0 us (Apple sends FLUSH per file, 600,000; ours none, no_flush). Max in flight 5 / 3.
rm phase: ours 1,258,086 in 30.4 s = 41.4 k/s, avg 80.5 us; Apple 1,703,219 in 32.3 s = 52.7 k/s, avg 63.4 us.
Per op avg us, untar, ours/Apple: SETATTR 47/34, GETXATTR 39/36, CREATE 71/74, GETATTR 48/33, WRITE 47/36, RELEASE 47/36, LOOKUP 42/31, MKDIR 71/75. rm: UNLINK 95/61, GETATTR 63/52, LOOKUP 67/73 (ours 3,437 lookups, Apple 466,752), READDIRPLUS 120/477, RMDIR 110/100.
Ours is slower per request on every cheap op but sends 17% fewer requests (half the GETATTRs in untar, no FLUSH, far fewer LOOKUPs in rm).

## Is our serving thread the limit? [V, last line derived]

Runner stats over the whole untimed-trace run (untar + find + rm + drop, wall 116-118 s), three runs: in callbacks 86.2 / 83.4 / 84.5 s = 72-73% of wall; handle+return 83.1 / 80.6 / 81.5 s (per request handle 9.4-9.7 us, return 1.45 us, total 11.0-11.3 us, 7.34 M requests incl. FORGET); one callback per 6.4 requests, largest batch 7,022; taken while spinning 53,689 only. Runner process CPU 88.1-89.0 s, so the one thread is the runner's CPU.
Untar phase estimate: 70.2 k req/s x 11.2 us = 0.79 of one thread busy [derived from V figures; bpftrace run]. So the serving thread is busy about 80% during the four untars and about 70% over the whole run: close to saturated, not pegged. Guest latency 47.8 us vs 11.2 us host work fits requests queueing behind the other tars' requests at one server [G].
The u4T runner stats are not usable: the aborted run (below) left its counters in them (1.2 M UNLINK).

## Mac CPU, s, medians [V] (whole run, untar + rm)

Four untars: runner 88.2 + VM 121.7 = 209.9; Apple VM 203.1. Two untars: 53.4 + 70.6 = 124.0; Apple 111.2. Single: 62.5 + 42.0 = 104.5; Apple 63.9 (single untar polls more: spin_solo).

## kern.num_files [V]

Apple runs peak 66,417-66,925 (max 66,925, traced four untars); sampled every 2 s, never above 100,000, no kill; back to about 11,700 after each run. Purge near 55,000 not seen as such: four untars plateau around 62-66 k, then drop. Ours runs peak 11,575-11,910. End of lab: 11,860.

## Problems

- My first traced attempt hung: `utN.sh` used a bare `wait`, which also waited for the background bpftrace. Killed at 21:19, script changed to wait on the tar/rm pids, rerun in hold C. A script error, not a share error; no other failure with these settings.
- Per-thread CPU from `ps -M` not usable (threads come and go between snapshots); `busy.py` prints it, ignore.

## Cleanup [V]

VM powered off, runner gone; S emptied; no t13, bpftrace or ssh process left; lock released 21:25:22; no vzfs or VM crash report since 14:10 in DiagnosticReports; `docker context show` = colima; `colima list` default Running, pinata Stopped; `~/.lima` absent; worktree `git status --short` empty.
