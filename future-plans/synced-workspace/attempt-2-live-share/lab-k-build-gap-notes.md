# Lab K (track T10): closing the Maven build gap (running notes, to be written up)

Start 15:11:26. Hard stop measuring 17:01. S = scratch t10.
15:12 VM booted from hbuild (hardened, unmodified), FINAL conf. runner pid 3012.
15:16 coordinator addendum: FSEvents check (C program, FSEventStreamCreate FileEvents|NoDefer, latency 0) of guest actions on both mounts; after final measurements, before cleanup; skip if past hard stop. Section in notes + 1 line in handback.
15:13-15:16 lab: image copy, seed, VM up (IP .64.5), apt openjdk17/maven 3.8.7/bpftrace/git; Dubbo 3.2.20 clone + online package+clean OK on /mnt/vzfs/a/d; cp -Rp to b/d (diff 0).
Kernel src: git.kernel.org plain v6.8 (github raw failed) in S/ksrc.
[S] inode.c:1282 V2 -> SB_NOSEC. inode.c:278 fuse_change_attributes_common clears S_NOSEC at EVERY attr refresh -> probe returns once per inode per attr refresh, not once per inode for ever.
[S] fs/inode.c __file_remove_privs: IS_NOSEC skip; else dentry_needs_remove_privs -> security_inode_need_killpriv (getxattr security.capability); then inode_has_no_xattr sets S_NOSEC only with SB_NOSEC.
[S] V2 obligations: WRITE_KILL_SUIDGID (file.c:1131,1488), OPEN_KILL_SUIDGID on O_TRUNC (file.c:36, dir.c:647 create), FATTR_KILL_SUIDGID on size/chown (dir.c:1927-1938). Caps: with S_NOSEC the kernel's own truncate/write cap removal is skipped -> server must remove security.capability on write/truncate. chown_common sets ATTR_KILL_PRIV unconditionally (not gated by NOSEC) [S from memory of fs/open.c, G].
Server already (killpriv=1) drops set-id on every write and size/chown setattr; never shows set-id (setid=0).
Code (prototype/vzfs-hardened): killpriv=2 grants V2 (+V1), kill_caps() fremovexattr security.capability on WRITE, O_TRUNC OPEN (+set-id drop), SETATTR size. keep_cache=2 exact rule (node kc_size/kc_mt/kc_ct; set at OPEN/CREATE; KEEP only if equal and not O_TRUNC); keep_cache=3 also updates after own WRITE when pre-write state == record (window: Mac write between fstat and pwrite). CREATE: refuse ENFILE before creating; if handle_new still fails and O_EXCL, unlink the just-made file (same ino). Runner: gap histogram (log2 us; polling / after stop) in SIGUSR dumps; spin_adapt=1 polls also when last gap < spin_us.
15:18 confine on new build (default cfg): ALL PASS, 277.
15:20 VM rebooted on S/hb2 (new build), FINAL conf. Warm-ups started (xattr-name probe on ours).
15:2x coordinator addendum 2: during kit rounds: after full stat walk of 151k tree on OUR mount (no drop caches), record guest slabinfo fuse_inode / inode-nr, runner lsof count, kern.num_files before/after; same walk on Apple's with num_files before/after. Section 'Descriptors with the tree cached, hardened' + 1 line.
15:21 warm-ups (no lock): ours 68,436 ms, Apple's 65,070. [V] xattr probe (bpftrace kprobe fuse_getxattr, warm-up build on ours): 61,019 GETXATTR, all `security.capability`; stacks: 61,009 fuse_cache_write_iter->file_remove_privs->cap_inode_need_killpriv, 4 chown_common, 1 do_truncate, 5 exec (get_vfs_caps_from_disk).
15:22 functional (no lock), killpriv=2 keep_cache=3: kctest.py (S/bin) 6/6 PASS on ours and Apple's (Mac edit same size + mtime restored: ctime moved, guest sees new data at next open; guest write/mmap/truncate then Mac edit; guest write only). Negative control keep_cache=1 (unconditional KEEP): 5/6 FAIL (stale data) -> test detects. keep_cache=3: 5 opens+cat of an unchanged file = 1 READ.
[V] caps: setcap cap_net_raw+ep then write / truncate / O_TRUNC open / repeated writes: getcap empty after each, on ours (killpriv=2) and on Apple's.
15:22 LOCK taken (hold 1). VM process pid 4024 (first var.sh run had wrong pid -> vm_cpu/num_files columns of h1-base wrong).
[V] base build server stats: LOOKUP 86,115 of which 75,298 ENOENT (87% missing names); host us/op avg 8.59; Mac-side stage total 14.1 us/request (handle 8.8, return 5.0); the rest of the ~70 us wire time is the transport.
[V] gap histogram base build (log2 us buckets b: [2^(b-1),2^b)): polling hits 121,421: b3 13,336 b4 31,879 b5 52,092 b6 13,544. After stop (wake-up path) 301k: b5 28,197 b6 75,043 b7 25,378 b8 15,209 b9 10,558 b10 8,037 b11 6,126 b12 4,232 ...
Mac: Apple M6, 2 Super + 4 Perf + 6 Eff cores.
15:31 hold 1 done, LOCK released. Clean build (rm then build) single runs, ms [V] (S/res/times.tsv, S/res/h1-*.stats):
  base 68,465 / base2 68,054 | Apple 64,044 / 64,745 | killpriv=2 66,864 | keep_cache=2 67,591 | keep_cache=3 67,588 | killpriv=2+keep_cache=3 66,975.
  requests: base 430,562 / 430,171; kp2 377,155 (GETXATTR 61,019 -> 8,093); kc2 392,928, kc3 392,468 (READ 37,106 -> 9,364); kp2kc3 339,774.
  VM process CPU per build: ours 246-250 s, Apple's 244 s; runner CPU ~12.4-13.1 s ours.
  Cost found: killpriv=2 WRITE host 7.2 -> 14.3 us/op (fremovexattr on every write, 84k writes). The 8,093 remaining GETXATTR: S_NOSEC is cleared at each attr refresh (inode.c:278), so the probe comes back after every GETATTR/LOOKUP refresh of a written file.
  Fix (hb4): on WRITE skip the removal when the nocap memo (same memo GETXATTR uses, valid attr_ttl) says no caps; set memo after removal. Semantics = killpriv=1 + memo (what the kernel would have asked).
  keep_cache saves 27.7k READs but only ~0.5-0.9 s wall: remaining READs are first reads (host 25-55 us/op).
15:32 VM restarted on S/hb4 (write-path cap memo). runner pid 7163, VM process 7166. hold 2 LOCK 15:33:20-15:45:36.
hold 2 clean builds ms [V]: Apple 65,029 / 64,122 | kp2 (memo) 68,394 (WRITE host back to 6.98 us/op) | kp2+kc3 66,952 | +spin_solo=0 70,090 (runner CPU 17.3 s) | +spin_adapt=1 67,500 (12.8 s) | +spin_us=100 70,680 (15.0 s) | +spin_us=100 solo=0 73,127 (25.6 s) | +spin_us=200 solo=0 75,645 (38.7 s) | base 70,387 (12.9 s).
  Polling: longer/more polling catches the gaps (so0: after-stop gaps below 32 us -> 0; s100so0: below 64 us -> 0) yet the build gets SLOWER, 1 s per ~5 s of runner CPU. VM CPU rises too (247 -> 268 s). [G] The spinning thread competes with the 4 vCPU threads for the 6 fast cores (2 Super + 4 Perf); the build is CPU-bound in the guest (javac), not request-latency-bound. Next: less polling.
  Noise: base 68,054-70,387 across holds (single runs), so differences < ~1.5 s need the 5-round final.
15:46 confine (S/hb5, VZFS_SET="killpriv=2 keep_cache=3"): ALL PASS 277 (incl. new case "create at the handle cap answers ENFILE and leaves no file on the Mac"). Negative controls: without the pre-check only (fallback unlink): PASS; without both: FAIL, file made 1 -> bug 7 reproduced and fixed.
hold 3 LOCK 15:46:35-15:57:12, all with killpriv=2 keep_cache=3, clean builds ms [V]: spin_us=0 65,930 / 64,540 (runner CPU 8.0 / 7.0 s) | spin_us=25 66,287 (9.9) | spin_solo=16 68,198 (10.5) | solo=8 (FINAL rule) 68,387 (11.3) | spin_solo=32 66,016 (9.9) | Apple 64,752 / 64,348 | base FINAL 69,200 (13.3).
  -> less polling = faster build. But Lab notes: untar without polling 1.35x slower. spin_solo=32 keeps solo polling for one-caller loads [G], so chosen; kit loads check it.
  Anomaly: first spin_us=0 run had OPENDIR 26,964 / READDIRPLUS 48,633 (2x the usual 12,902 / 25,460), nodes 36,689; second run normal. Not explained [G: leftover nodes from previous mount].
15:57 final candidate: FINAL + killpriv=2 keep_cache=3 spin_solo=32. hold 4 LOCK 15:57:30: kit loads 3 rounds + descriptor addendum.
15:58-16:01 kit round 1 with spin_solo=32 [V]: untar 151k 53,771 ms (Apple 41,870) = the no-polling figure -> spin_solo=32 loses untar polling. REJECTED, kit hold aborted (raw S/res/kit-so32-aborted). Lock released 16:01:34.
  Polling conclusion: the build wants less polling (spin_us=0: 64.5-65.9 s), untar needs it (54 s vs 42 s without). spin_solo=8 (FINAL) kept. A rule that tells the two apart needs more than run length (so16 68.2 s single run, untar not measured). Not closed.
16:01:44 hold 4 re-taken: kit 3 rounds with FINAL + killpriv=2 keep_cache=3 (spin_solo=8) + descriptor addendum.
hold 4 LOCK 16:01:44-16:13:05. Kit loads, 3 rounds interleaved, final settings (raw S/res/kitfin/kit.tsv) [V]:
| load, ms | ours 3 runs | Apple's 3 runs | medians | ratio | Lab J hardened/orig ours |
|---|---|---|---|---|---|
| untar 151k | 43,634 43,397 43,560 | 42,047 34,371 28,156 | 43,560 / 34,371 | 1.27 | 43,637 |
| find of it | 466 554 501 | 822 814 827 | 501 / 822 | 0.61 | 431 |
| rm -rf of it | 14,002 13,950 13,821 | 14,395 13,885 14,262 | 13,950 / 14,262 | 0.98 | 14,029 |
| 8x ls -lR tree20k x5 | 13,213 13,319 13,351 | 13,712 13,489 13,513 | 13,319 / 13,513 | 0.99 | 13,485 |
| stat walk cold 64k | 2,533 2,602 2,682 | 2,882 2,847 2,845 | 2,602 / 2,847 | 0.91 | 2,552 |
| stat walk warm | 522 524 523 | 1,495 1,496 1,532 | 523 / 1,496 | 0.35 | 515 |
| find walk cold / warm | 423 406 429 / 420 403 425 | 1,382 1,291 1,289 / 1,499 1,501 1,466 | 423 / 1,291; 420 / 1,499 | 0.33 / 0.28 | 346 / 400 |
| git status warm | 252 249 195 | 296 251 295 | 249 / 295 | 0.84 | 251 |
| walkers 20 s: passes / error lines / probe max ms | 467 454 445 / 0 0 0 / 0.8 0.6 3.2 | 43 28 28 / 353 28 246 / 4,127 4,823 3,779 | | | |
  Apple's untar fell 42.0 -> 34.4 -> 28.2 s over the rounds: not seen in Lab J (41.7-41.8 s x5); cause unknown [G: Mac-side cache state after the aborted run]. Ours equals Lab J -> no regression; the final settings do not change untar.
  Mac CPU per round, ours: macro runner 64.5-64.9 s + VM 41 s; Apple's macro VM 47-64 s. pw2 ours 7.9 + 20.5, Apple's 31. kern.num_files with ours 9.8k flat; with Apple's up to 63.7k.

## Descriptors with the tree cached, hardened [V] (S/res/add2.txt, final settings, hb4)
- 151,516-entry tree untarred on ours, caches dropped; guest `/proc/sys/fs/inode-nr` 4,280 before the walk -> 155,803 after the `find -printf %s` walk of ours (151,517 entries, 618 ms): the inodes are cached (slabinfo needs root: not read).
- Ours: runner `lsof` 10 before, 10 after, 10 three seconds later; VM process 38 throughout; `kern.num_files` 9,797 before and after.
- Apple's (caches dropped, inode-nr 4,273 -> 155,793; walk 4,821 ms): VM process `lsof` 38 -> 53,631; `kern.num_files` 9,797 -> 63,391. After drop_caches + rm: VM 63, kern.num_files 9,843.
16:13:10 hold 5 LOCK: final build rounds 1-3 (after / Apple's, clean build + rebuild).

## Final build rounds [V] (hold 5 LOCK 16:13:10-16:26:23, hold 6 16:26:26-16:35:15; raw S/res/h5.out, h6.out, fin-r*-*.stats)
Final settings: `mode=serial xattr=1 no_flush=1 killpriv=2 keep_cache=3 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1` (hb4 binary).
| | ours before (FINAL) | ours after | Apple's | after / Apple's |
|---|---|---|---|---|
| clean build, 5 runs | today 68,054 68,465 69,200 70,387 (single runs, holds 1-3); Lab J median 68,204 | 67,455 66,979 66,950 66,436 67,191 | 64,723 64,359 63,869 64,348 64,903 | med 66,979 / 64,359 = 1.041 (before 1.052) |
| rebuild, 5 runs | Lab J median 63,402 (not re-measured today) | 61,309 62,149 63,635 63,548 61,751 | 59,804 59,840 59,961 59,807 61,317 | med 62,149 / 59,840 = 1.039 (before 1.048) |
Requests per clean build 339,423-339,971 (before 430,171-430,871, -21%); rebuild 325,629-326,189. Server host time 10.4 us/op build, 8.4 rebuild; Mac-side total per request 16.1 / 14.6 us. Guest-side wire latency not traced today.
Mac CPU per run (medians): clean build runner 11.5 s + VM 247.1 s, Apple's VM 242.7 s; rebuild 9.9 + 229.5 vs 227.3. Before: runner 12.9-13.3 s, VM 250-252 s.

## Correctness [V]
- confine: ALL PASS 277 (hb5 = hb4 + new test, VZFS_SET killpriv=2 keep_cache=3).
- fuzz (UBSan, S/fz/fuzz2 built from the final source, VZFS_KILLPRIV=2 VZFS_KEEP_CACHE=3): 2,000,000 requests 3 threads seed 20261125 PASS (sentinel UNCHANGED, handles max 511 of 512); 3,000,000 seed 7 PASS.

## FSEvents check (addendum 1) [V] (S/bin/fse.py, S/fsev/fsev; raw S/res/fse-*.txt)
Guest actions over one persistent ssh shell, Mac FSEvents stream (FileEvents|NoDefer, latency 0) on the folder; delay from sending the command on the Mac.
Every action produced its event on both shares, 13.7-19.9 ms ours, 12.5-16.2 ms Apple's (command itself 1.5-9.9 ms).
| action | ours flags | Apple's flags |
|---|---|---|
| create | Created Modified File | Created Modified Owner File |
| append | Modified File | Created Modified Owner File (history of the same path coalesced) |
| rename | Renamed Modified (old) + Renamed (new) | Created Renamed Modified Owner (old) + Renamed (new) |
| chmod | Renamed Owner File | same |
| delete | Removed Renamed Owner File | same |
| mkdir / rmdir | Created Dir / Created Removed Dir | Created Owner Dir / Created Removed Owner Dir |
| write in 3 new levels | 3x Created Dir + Created Modified File | same with Owner |
Difference: no ItemChangeOwner on create/mkdir with ours (Apple's share chowns after create; ours creates as the Mac user). No missing event. Created/Removed/Renamed/Modified, what an IDE watcher uses, match.
- conform.sh (16:35): ours 40 PASS / 6 FAIL, PASS/FAIL lines identical to Lab J hardened; Apple's 39 / 7 (create-mode-0 extra FAIL). Raw conform-*.txt.
- coherence.py --reps 10, both shares, exit 0, 320 observations each: later than 0.5 s ours 9, Apple's 32; no case where ours is later than Apple's (worst per case compared); differs: Mac deletes a name 0.001 / 1.001, missing then created 0.002 / 1.001, replace by rename 0.000 / 0.794. Guest->Mac 0.000 on both. Raw coh-*.txt/tsv.
Raw files copied to prototype/share-kit/baseline-build-2/ (scripts/ with S for the scratch path).

## What remains slower and why
Clean build +2,620 ms (4.1%), rebuild +2,309 ms (3.9%), against 5.2% / 4.8% before. The requests are now fewer than Apple's (339k against Lab J's 455k for Apple's), so what is left is not the request count:
- Transport: about 16 us of Mac-side work per request against Apple's in-kernel path; the two XPC hops per request cannot be removed through the API (Lab J / custom-device notes) [S of earlier notes].
- Polling competes for CPU: every bit of extra polling slowed the build (spin_us=0 64.5-65.9 s in single runs, about Apple's) while untar needs it (53.8 s without against 43.6 s with). The rule spin_solo=8 is kept; one that serves both loads was not found (spin_solo=32 loses untar). [V single runs, G mechanism]
- 75k LOOKUP misses (87% of LOOKUPs) stay: caching missing names is ruled out.
- 8k GETXATTR stay with killpriv=2: Linux clears S_NOSEC at each attribute refresh (inode.c:278) [S].

## Cleanup (16:38) [V]
VM stopped (runner and VM process gone); t10 scratch empty; no runner, sampler, monitor tail, fuzz or ssh left; lock released (absent); crash reports from 15:11 on: none (only fuzz-2026-11-25-141018, before this track); docker context colima; colima default Running, pinata Stopped; ~/.lima absent; kern.num_files 9,852; prototype/vzfs: no file newer than 15:11; no build products in the worktree.
