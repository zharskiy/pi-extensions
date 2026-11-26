# Lab H notes (t3: share kit, addressing costs, krunkit attribution)

[V] measured here, [S] read in source, [G] guess.
Scratch: the scratch folder's `t3/` ($S). Started 2026-11-25 06:50. Baseline kern.num_files 6889.
Other tracks' scratch folders present at start: t1 t2 t4 (not mine, untouched).

## Created (for cleanup)
- `prototype/share-kit/` (kit, kept)
- colima profile lab-t3-vz (created 06:55, `colima start --profile lab-t3-vz --activate=false --vm-type vz --mount-type virtiofs --cpus 4 --memory 4 --disk 20 --runtime docker --mount $S/share:w`, 21.4 s; docker context colima-lab-t3-vz created by colima; current context stayed colima). VM pid 84864 (by lsof on t3/share), hostagent 84850, ssh mux 84898. Guest 6.8.0-117-generic, bpftrace installed in guest by apt.
- krunkit 1.3.2 + libkrun 1.19.8 + libkrunfw 5.6.4 + libepoxy + molten-vk: Homebrew bottles downloaded with curl from ghcr.io (anonymous token, sha256 checked against brew's json) into $S/krun/dl, extracted to $S/krun/x, dylibs copied to $S/krun/lib, install_name_tool to absolute scratch paths, re-signed ad hoc (krunkit with its own entitlements hypervisor + disable-library-validation), wrapper $S/krun/bin/krunkit sets DYLD_FALLBACK_LIBRARY_PATH (libkrun dlopens "libkrunfw.5.dylib" by leaf name). `krunkit --version` -> 1.3.2 [V]. Nothing installed by brew.
- D2 (host micro-benchmark) delegated to a worker agent; its raw notes $S/d2/notes.md, source prototype/share-kit/hostbench/.
- Not mine, seen: ~/.colima/_lima/_disks/colima-fdlab-c (Lab C leftover?), another vz VM pid 85068 (other track). Untouched.

## D1 kit (prototype/share-kit/)
bench.sh, conform.sh, coherence.py (Mac-driven, agents on both sides via a command prefix), loads-c.sh (Lab C loads for D3), helpers/{mktree.py,statx_lat.py,probe.py,cohagent.py,fuseops.bt}, README.md.
Trees for this lab built on the Mac (python3 helpers/mktree.py $S/share/share-kit-trees, 7.2 s; repo40k git init/add/commit on the Mac 12.6 s, 42,003 objects). node_modules of the repo copied to $S/share/nm (21,420 entries, 19 symlinks) and nm.tar 278,564,864 B: same size as Lab C's tree.tar, so same tree.
Self-tests: coherence.py local (both sides on the Mac) all 0.000; over vz one rep: works (numbers below are the real run).

## D2 addressing costs on the Mac (worker agent; raw: prototype/share-kit/hostbench/raw-notes.md; source hb.c, sem.c, run.sh)
Tree 63,000 files (3000 dirs x 21), APFS. Median of 3, spread <=10% unless noted. ns per call, boot Data volume / /Volumes/<volume> (external PCIe APFS, noowners). [V]
"Cold" = before each rep lstat 330k files of another tree (recycles ~333k vnodes > kern.maxvnodes 249,863): vnode and namecache cold, APFS metadata probably still in RAM [G]. 8 threads = aggregate wall per call.
| method | 1T warm | 8T warm aggr | 1T cold | descriptors |
| lstat by path (ref) | 967 / 795 | 357 / 302 | 3744 / 3586 | none |
| lstat /.vol/dev/ino | 1515 / 1250 | 595 / 572 | 4683 / 4296 | none |
| lstat /.vol/dev/pino/name | 1447 / 1169 | 735 / 716 | 4571 / 4060 | none |
| fstatat held dirfd | 1022 / 849 | 519 / 611 | 3864 / 3794 | 1 per dir |
| open dir+fstatat+close | 7849 / 6103 (via /.vol 8227 / 6474) | 4882 / 3283 | 11413 / 9637 | transient |
| getattrlistbulk per entry | 1083 / 993 (~23 us per dir) | 849 / 779 | 2243 / 2095 (20 %) | transient |
| fsgetpath alone | 1179 / 773 | 3293 / 1986 | 3654 / 3150 | none |
| fsgetpath+lstat | 1911 / 1510 | 3402 / 1926 | 5904 / 4696 | none |
| open+close /.vol/dev/ino | 11772 / 11127 | 5126 / 3400 | 17531 / 13014 | transient |
| openat held dirfd+close | 11392 / 8894 | 5131 / 3581 | 16694 / 11681 | 1 per dir |
| open+close by path | 11610 / 8794 | 4997 / 3281 | 16678 / 12397 | transient |
| getattrlist /.vol/dev/ino incl GEN_COUNT | 1620 / 1415 | 597 / 587 | 4946 / 4472 | none |
fsgetpath slower with 8 threads than 1 (global lock) [V]. getppid 100 ns, lstat("/") 510 ns. fd sampler: fd_max 3 during lstat//.vol/fsgetpath/getattrlist runs (nothing held after return) [V]; vnode pinning not observable without root.
openbyid_np: links, EPERM on every call for uid 502 (no entitlement) [V].
/.vol semantics, identical on Data, the repository's volume and a third volume (another external APFS volume on the same disk; scratch folder made and removed by the worker) [V]; no case-sensitive volume mounted:
(a) rename same dir: ino form follows; old name form ENOENT. (b) move to other dir: same. (c) replaced by rename-over: old ino ENOENT even while held open by this process; name form gives the new file. (d) deleted while open: ino form, name form, fsgetpath all ENOENT; only the held fd works (nlink 0). (e) deleted: ENOENT. (f) permissions: no bypass, EACCES with parent 0000/0600; 0100/0300 work; file 0000: lstat ok, open EACCES. (g) non-boot volume works, 10-25 % faster. (h) hard link: ino form ok, nlink 2; fsgetpath gives the newest link name. (i) ino reuse: 0 of 5000 reused (monotonic). st_gen 0; ATTR_CMN_GEN_COUNT readable without root (write counter); DOCUMENT_ID 0.
Cleanup by worker: lock released, scratch folders on both volumes removed (the empty /Volumes/<volume>/.t3-hostbench-scratch was left by the worker, removed by me with rmdir, `ls -a /Volumes/<volume> | grep t3` empty) [V].

## D1 baseline: Apple's built-in share (lab-t3-vz, 4 vCPU, 4 GiB, guest 6.8.0-117, share = $S/share on the boot Data volume) [V]
Lock held 07:28:16-07:33:54 ($S/bin/vzbase.sh: watchdog + VM fd sampler, then bench.sh, conform.sh, coherence.py --reps 3). Raw files copied to prototype/share-kit/baseline-apple/ (vz-bench.tsv, vz-conform.txt, vz-coh.txt/.tsv).
Host load during the run: load average ~3 (other tracks' VMs; another VM held ~55k fds before), so treat +-10 % as noise. VM fd max 61,460 (sampler 0.5 s), kern.num_files max 67,120, watchdog max 68,270 (not tripped).
| test | run1 | run2 | run3 | Lab G/C reference |
| stat_walk_cold (find tree64k \| xargs stat) ms | 4,572 | 2,709 | 2,727 | G2 2,597 |
| stat_walk_warm ms | 1,530 | 1,487 | 1,496 | G2 1,417-1,425 |
| find_walk_cold (find -printf) ms | 1,389 | 1,387 | 1,266 | - |
| find_walk_warm ms | 1,548 | 1,486 | 1,354 | (warm not faster: 67k > what the guest keeps? fuse_inode stays 67,2xx; attrs expire after ~1 s [G]) |
| git_status_warm repo40k ms | 297 | 297 | 295 | G2 234-281 |
| stat_uncached_median us (statx FORCE_SYNC) | 16.7 (p90 21.5) | 10.3 (12.5) | 16.4 (19.6) | - |
| walkers passes in 30 s (8 walkers) | 55 (8 8 8 8 6 3 8 6) | 50 | 43 | G1 none: 8 8 8 8 7 4 8 7 |
| walkers error lines (all EMFILE) | 1,967 | 3,817 | 238 | G1 none: 238 / 0 / 22 |
| walkers probe max ms (50 ms statx probe) | 4,571 | 4,585 | 4,801 | G6 4,405 |
| macro untar 151,516 entries ms | 42,165 | 41,181 | 39,819 | G5 41,282-41,439 |
| macro find ms | 818 | 768 | 766 | G5 773-779 |
| macro rm -rf ms | 14,024 | 13,912 | 13,948 | G5 14,265-14,293 |
(git status loop under the walkers: 1 run per 30 s as in F/G.) Run 1 stat_walk_cold 4.6 s is an outlier (first touch of the Mac-built tree in this VM, [G] Mac side cold).

### conform.sh on Apple's share (first version of the script; TZ bug fixed after) [V]
FAIL (differs from ext4): create-mode-0 (file not created), chown (rc 0, stays 0:0, also after drop), chmod-setuid (4755 -> 755), perm-enforced-write (uid 1000 wrote into a 0751 root file: server does not enforce mode for other users), symlink with ../ x8 target (empty read; rerun with readlink diag in D3 window), name with byte 0xff (EPERM: APFS needs UTF-8), NFD==NFC and case-insensitive (APFS), mtime-ns-set (only TZ of the script: guest TZ +0200; value .123456789 kept, also after drop = ns precision PASS).
PASS: chmod 751 sticks after drop, hard links (same ino, nlink 2, write-through, after drop), symlinks incl. outside share and dangling, rename over, rename dir over empty dir, unlink of open file (read+write after unlink, nlink 0), mmap shared write and private, flock and POSIX lock conflicts between guest processes, user xattr (security.* also settable), mkfifo, socket node, fallocate 10 MiB, sparse 1 GiB (8 blocks, SEEK_DATA 1073741824 / SEEK_HOLE 0 = odd: hole reported at 0 after data at 1 GiB), 1 GiB checksum (write+sync 1,207 ms, read+sha 655 ms after drop_caches 3), names with newline, 0x01, backslash, colon, trailing space, 255 bytes, NFC, *?<>|", 256 rejected, 10,001-entry dir (ls, after drop, find unique), O_APPEND 2 x 2000 lines no tearing.
INFO: root-created 0:0 644; user (uid 1000 -> su as nobody fallback? created by 65534) shows 65534:65534; share root 0:0 755: Apple shows the guest's own uid for files it created (the Mac file is the Mac user's).

### coherence.py on Apple's share, 3 reps, max delay s (0.000 = visible when "changed" arrived, rtt 0.2 ms) [V]
mac->guest: in-place rewrite data+mtime 0; append size, mtime, data 0; new name in listed dir: readdir 0, lstat 0; deleted name: readdir 0, read 0 (ENOENT), lstat still succeeds for 1.000-1.001 s (3/3); rename: new name 0 / listed 0, old name lstat succeeds 1.001 s; missing then created: exists 0, data 1.000 s in 1 of 3 reps (0 in 2) = stale cached size/attr from the instant of creation (Lab C saw 0.92 s, empty read); replace by rename (safe write): new data after 0.790-0.796 s (3/3; Lab C: ENOENT for 0.72 s).
guest->mac: everything 0 (all 7 cases, 3/3).
=> "as good as today": metadata of names looked up is up to 1 s stale (deleted, renamed-away, replace-by-rename 0.8 s, new file content 1 s), data and readdir are immediate.

## D3 so far (partial; run interrupted by hand-back)
vz loads-c (ms) plain1/plain2/trace [V]: stat_cold 794/654/575, stat_warm 217/214/407, read_cold 5214/1897/2056, read_warm 4903/1711/1897, untar 7763/7359/7744, rm 1744/1733/1848, git_commit 20147/18027/18625, git_status_cold 2004/1659/1500, warm 336/281/308, rm_g 2354/2322/1080. Raw: $S/d3/vz/ (guest copy fetched).
vz FUSE trace TOTAL n / avg us / sum ms [V]: stat_cold 15,829/34.1/540; read_cold 95,076/20.9/1,984; untar 318,544/17.5/5,573; git_commit 634,143/21.3/13,498 (maxinflight 1,926); git_status_cold 179,806/35.0/6,296.
vz read_warm still sends OPEN+READ+RELEASE per file (20,770 READ): no FOPEN_KEEP_CACHE on Apple's share [V].
vz `sample` during read_cold [V]: one serial dispatch queue `com.apple.virtualization.virtio.filesystem-device:0`, 495/3,227 samples busy; leaf calls openbyid_np 174, __openat 166, fstatat 40, preadv 19. Apple opens by (fsid,objid) with openbyid_np, which we get EPERM on (entitlement) [V].
krunkit: needed share/krunkit/KRUN_EFI.silent.fd next to bin (copied from bottle); guest has no resolv.conf (replaced with nameserver 192.168.5.3 in guest only). krun D3 run started 08:38:45 under lock ($S/bin/krunrun.sh, log $S/d3krun.log, results in guest at $S/d3/krun/); guard releases the lock by 08:57.
NOT DONE: krun numbers, attribution, statwarm sample, cleanup.

## D3 result: krunkit 1.3.2 / libkrun 1.19.8 vs Apple (same guest image, 4 vCPU, 4 GiB, same share) [V]
loads-c ms (vz plain2 | krun plain1, plain2 | ratio): stat_cold 654|1484,1038 x1.6; stat_warm 214|1151,1167 x5.4; read_cold 1897|7134,5319 x2.8; read_warm 1711|5264,5233 x3.1; untar 7359|11209,11139 x1.5; rm 1733|2973,2981 x1.7; git_commit 18027|41264,41084 x2.3; git_status_cold 1659|1155,1162 x0.7; git_status_warm 281|1137,1141 x4.1; rm_g 2322|3844 x1.7. Raw: prototype/share-kit/d3-raw/{vz,krun}/.
FUSE requests (vz | krun) n, avg us, server ms:
- git_commit: TOTAL 634,143 / 21.3 / 13,498 | 1,950,484 / 16.4 / 31,943. GETATTR 62,003 | 1,382,657 (x22) = 18,475 ms of krun's 31,943.
- read_cold: TOTAL 95,076 | 300,267; GETATTR 30 | 206,401 (2,712 ms). OPEN/READ/LOOKUP counts and avg about equal (LOOKUP 28 vs 13 us).
- untar: GETATTR 39,560 | 221,540 (3,072 ms); SETATTR 14 vs 25 us avg.
- stat_cold: GETATTR 28 | 52,549.
- git_status_cold: krun faster: Apple LOOKUP avg 103 us (36k, 3,722 ms) vs krun 26 us; krun GETATTR 215,712 (5,180 ms).
=> Attribution: the gap is request count, not service time. Almost all extra requests are GETATTR, from attr_timeout 0 in libkrun's simplified cache mode [S worker/passthrough config] (every stat/open/revalidate goes to the host). Average service time per request is equal or lower on krun (13-16 us vs 17-35 us) [V]. Example git_commit: extra GETATTR ~1.32 M x 13 us = 17.2 s of the 23 s gap [V numbers, arithmetic].
Second factor, latency of an isolated request: statx FORCE_SYNC median 106 us on krun vs 10-17 us on Apple [V], while the traced in-guest GETATTR avg is 12-13 us under load. [G] The difference is wake-up: the single fs worker sleeps in kevent/epoll and the vCPU in WFI; a serial one-request-at-a-time pattern (git status warm x4, stat_warm x5.4) pays it on each call.
krunkit `sample` (read_cold, stat_warm; 5 s): threads mostly park in __psynch_cvwait/kevent/semaphore_wait; busy leaves read 2.8k, hv_trap 1.3-1.6k, preadv 627, lstat 159-299, open ~95. The `read` leaf (eventfd/pipe reads of the worker loop) dominates the busy samples more than the file syscalls [V counts, G interpretation]. Apple by contrast: serial dispatch queue, openbyid_np/openat/fstatat.
Fix direction [G]: a non-zero attr_timeout (libkrun main, PR 988) should remove most GETATTRs; not built (no cargo), so unverified.
krun conform: 57 lines in d3-raw/krun/conform.txt (not reviewed).

## Cleanup (08:49-08:51) [V]
Removed: colima profile lab-t3-vz (`colima delete --force --data`; colima list shows only default, pinata); lab-t3-krun (limactl delete failed because krunkit not in PATH; its VM process was already gone; killed its stray lima-driver-krunkit pid 8282 and removed ~/.lima-t3 by hand); watchdog/sampler/queued krunbench.sh + lock waiter killed; scratch t3 emptied (raw data first copied to prototype/share-kit/d3-raw and baseline-apple); /Volumes/<volume> has no t3 folder; no lab-t3 entry in ~/.colima/_lima or its _disks; docker context = colima. Exclusive lock now held by t1 (not mine, untouched).

## Check of the krunkit attribution
(Second t3 agent, from the files only. Raw data moved at 08:52: `d3-raw/krun/` is now `prototype/share-kit/baseline-krunkit/` and `d3-raw/vz/` is now `baseline-apple/loads-c/`. Recomputed with `python3 -I helpers/btsum.py baseline-apple/loads-c/trace/X.bt baseline-krunkit/trace/X.bt`.)
1. git_commit requests: 634,143 on Apple vs 1,950,484 on krunkit. Confirmed [V].
2. GETATTR on git_commit: 62,003 vs 1,382,657, which is 18,475 ms of krunkit's 31,943 ms of server time. Confirmed [V]. The same pattern shows in the other loads: stat_cold 28 vs 52,549 (660 of 937 ms), read_cold 30 vs 206,401 (2,712 of 4,357 ms), untar 39,560 vs 221,540 (3,072 of 8,590 ms), git_status_cold 3,556 vs 215,712 (5,180 of 7,680 ms) [V].
3. "13-16 us vs 17-35 us average" is only partly right. Over the five traced loads the average is 13.8-24.0 us on krunkit vs 17.5-35.0 us on Apple: untar is 18.1 vs 17.5 (krunkit slightly slower) and git_status_cold is 24.0 vs 35.0 [V]. Most of krunkit's lower average comes from the request mix (its many extra cheap GETATTRs pull the mean down). Per opcode GETATTR costs about the same (12-13 vs 9-14 us; 24 us on git_status_cold). Some opcodes are slower on krunkit in git_commit: SETATTR 25 vs 17, UNLINK 56 vs 31, RELEASE 22 vs 15. LOOKUP, CREATE and READDIRPLUS are faster on krunkit [V]. So the conclusion still holds: the gap is the request count, not the service time.
Why attr_timeout is 0 [S]: libkrun 1.19.8 `devices/src/virtio/fs/device.rs:79` sets attr_timeout 0 only for `PermissionSemantics::LinuxSimplified`, which reports the uid/gid of the asking process, so the attributes cannot be cached. krunkit links `krun_add_virtiofs4(.., semantics)` and lima passes no `permissionSemantics`. That simplified mode is in use is shown by the measurements [V]: 0 xattr calls in the stat_warm sample, and conform shows `owner-user-created 0:0` and `owner-as-user 65534:65534` (the owner reported is whoever stats the file). This is a krunkit/libkrun mode choice, not a consequence of addressing files by `/.vol` [S+V].
Host side, stat_warm sample [V]: the fs worker (one thread, `FsWorker::work`) is idle in kevent for 2,220 of 2,907 samples. When busy, lstat accounts for about 300 samples (178 GETATTR, 119 LOOKUP) and open/getdirentries for about 150. The host server is mostly waiting, not computing.
Descriptors [V+S]: krunkit's fd table high-water (proc_pidinfo) grew 320 -> 16,404 during the git_commit load, and kern.num_files rose by about 10.4k, then fell back. libkrun `do_unlink` (passthrough.rs:979-1016) calls `grab_unlinked_fd` and holds one fd per unlinked file until FORGET. So krunkit is descriptor-free for cached files but not for unlinked ones.
krunkit bugs found in the run:
- [V+S] Unlinking a FIFO hangs the whole share. `grab_unlinked_fd` does `openat(O_NOFOLLOW|O_CLOEXEC)` without O_NONBLOCK, so it blocks on a FIFO. conform's cleanup `rm -rf` hung in `fuse_unlink`, and `sample-hang.txt` shows the single fs worker stuck in `do_unlink -> openat`. Opening the FIFO for writing from the Mac freed it.
- [V] `rm -rf g` failed on krunkit in both plain runs with `cannot remove 'g/.git': Directory not empty`. The traced run had no error. Cause not investigated [G: readdir snapshot/offset].
Our own server must open with O_NONBLOCK, or not open special files at all, when it keeps unlinked files alive.
conform, lines that differ from Apple's baseline (57 lines each) [V]:
- krunkit PASS where Apple failed: create-mode-0, chmod-setuid (4755 kept), symlink-dotdot-resolves-in-guest, mtime-ns-set. The mtime line differs only because the guest TZ is UTC.
- Ownership as above: krunkit owner-user-created 0:0 vs Apple 65534:65534; owner-as-user 65534:65534 vs 0:0.
- name-invalid-utf8-ff: still FAIL, but differently. The file is created and listed as `bad\xef\xbf\xbd` (U+FFFD, the name is mangled); Apple returns EPERM.
- fallocate-punch-hole: blocks=0 vs 18432.
- sparse-seek-data-hole: `0 1073741827` (all data, no hole information) vs `1073741824 0`.
- 1 GiB file: write+sync 834 vs 1,207 ms; read+sha 1,208 vs 655 ms.
- The other differences are inode numbers and hostnames only. Same FAIL on both: chown, perm-enforced-write, NFD/NFC, case.
Not done, because the VMs were deleted (by the first agent's cleanup at 08:49): bench.sh on krunkit (stat walk, git status, eight walkers), the walkers under trace (in-flight depth, (c)), coherence.py, and the stat-walk sample. For (c) only the in-load maxinflight is available: 5/5 stat_cold, 10/5 read_cold, 1,926/1,688 git_commit (Apple/krunkit) [V]. Isolated request latency: statx FORCE_SYNC 106 us on krunkit vs 10-17 us on Apple (baseline-krunkit/lat.tsv) [V]; that it is wake-up cost is a guess [G].
Cleanup check (08:53) [V]: `colima list` shows default Running and pinata Stopped only. ~/.lima and ~/.lima-t3 absent. No t3 entry under ~/.colima/_lima or its _disks. `docker context ls` shows colima, default, desktop-linux (no lab-t3). `docker context show` prints colima. `pgrep -fl 'krunkit|lab-t3|lima-t3'` matches nothing (only colima default's own limactl usernet/hostagent run). The t3 scratch folder is empty, and the krunkit binary and libs were only under $S/krun, so they are gone with it. No t3 folder on /Volumes/<volume>. kern.num_files 6,645. The lock is held by t1 and was not touched.
