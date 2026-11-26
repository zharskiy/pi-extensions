# Lab E notes (fdlab-e1, fdlab-e2)

Scratch: the scratch folder's `lab-e/` ($S)
Baseline kern.num_files before start: 6,620 (02:02).

## Setup
`colima start fdlab-e1 --vm-type vz --mount-type virtiofs --runtime docker --cpus 2 --memory 2 --disk 20 --mount $S/shareA:w --mount $S/shareR`: 18.7 s; `docker context use colima` right after (current context colima).
VM process PID 36607 (hostagent 36601). default's VM 39113.
Trees built on the host (python): shareA/tree20k (1000 dirs x 20), shareA/tree64k (q0..q3, 800 dirs x 20 each), shareA/repo40k (2000 dirs x 20, host git init/add/commit), shareR/ro (10x10), scripts in shareR/bin (read-only in guest, so the scripts add nothing to shareA).
Host fd counter: $S/fdcount.py (libproc PROC_PIDLISTFDS), idle VM 14 fds.

## E5 facts gathered at setup (guest)
util-linux 2.39.3 (mount from util-linux 2.39.3, libmount 2.39.3).
/proc/mounts: `lima-b33b50d32bfd350e <S>/shareA virtiofs rw,relatime 0 0`, `lima-de68f4564167ce58 <S>/shareR virtiofs ro,relatime 0 0`.
/etc/fstab (cloud-init): `lima-b33b... <S>/shareA virtiofs rw,nofail,comment=cloudconfig 0 0` and `lima-de68... <S>/shareR virtiofs ro,nofail,comment=cloudconfig 0 0`. So the shares ARE in fstab, with ro for shareR.
findmnt -t virtiofs: shareA `rw,relatime`, shareR `ro,relatime`.
/bin/bash exists.

## E1 FUSE request counting
function profiler on fuse_simple_request, fuse_lookup_name, fuse_do_getattr, fuse_dentry_revalidate, fuse_readdir (all in available_filter_functions) plus a kprobe `p:fsr fuse_simple_request op=+8($arg2):u32` with `hist:keys=op` (fuse_args.opcode at offset 8). Opcodes: 1 LOOKUP, 3 GETATTR, 25 FLUSH, 52 STATX.
Finding from the trial: an expired cached entry costs 1 LOOKUP issued from fuse_dentry_revalidate (fuse_lookup_name count stays 0, GETATTR 1): revalidation, not a fresh lookup. A pruned entry costs LOOKUP + STATX (coreutils stat asks statx for btime which a fresh inode lacks): 2 round trips per file.

## E1 results ($S/shareR/bin/e1.sh, guest root; fresh populate after drop_caches 2 each row; pass 2 timed; 21,001 entries = 20,000 files + 1,001 dirs)
mode list = `xargs stat < precomputed list` (no readdir); mode find = `find tree20k -type f | xargs stat` (as asked).
list, cached (no remount) ms / LOOKUPs: g0 157/3,090; g0.3 217/7,068; g0.6 547/21,001; g0.9 534/21,001; g1.2 371/21,001 (trial 524-549); g2 545; g5 546; g30 545 (all 21,001 LOOKUP, 1 GETATTR)
list, pruned ms: g0 1,142; g0.3 856; g0.6 1,048; g0.9 794; g1.2 1,153; g2 1,152; g5 1,146; g30 1,165 (each: 21,001 LOOKUP + 20,000 STATX, 41,005 requests)
  (g0/g0.3 cached rows: populate took ~1 s, so its oldest entries were already older than the window at revisit.)
find, cached ms: 179 192 184 217 181 186 218 208 for g 0..30; requests 3,995 each: READDIRPLUS(44) 1,001 + OPENDIR 1,002 + RELEASEDIR 1,009 + 978 dir LOOKUPs (revalidation of dirs) - READDIRPLUS refreshes every child entry, so file entries never expire under find.
find, pruned ms: 778 772 691 770 772 772 771 770; 23,995 requests = the same + 20,000 STATX.
Per entry (list mode): valid ~7.5 us (157 ms with 15 % expired; fine probe 0.6 ms/1000 = 0.6 us at g=0 Python lstat), expired-but-cached ~26 us (545 ms / 21k; 1 LOOKUP from fuse_dentry_revalidate), pruned ~55 us (1,150 ms / 21k; LOOKUP + STATX). Pruned/expired = 2.1x, expired/valid ~3.5-70x.
Fine probe ($S/shareR/bin/e1b.sh, 1,000 files, python os.lstat, populate 60-77 ms, 2 reps per gap): gap 0-0.9 s: 0 LOOKUPs, pass2 0.6-4.4 ms; gap 0.95/1.0/1.05/1.1/1.3: 1,051 LOOKUPs each, 44-54 ms. Oldest entry's age at revisit = gap + ~0.07 s; knee between 0.97 and 1.02 s -> entry validity = 1.0 s (from the reply), attr refreshed by the same LOOKUP (no GETATTR seen). populate (fresh lookup, lstat no btime) 60-77 ms for 1,051 = ~65 us; expired revisit ~47 us each.
Tracing removed at the end of each script (set_ftrace_filter cleared; hist trigger removed). kprobe fsr still registered (removed at cleanup).

## E2 results ($S/shareR/bin/e2.sh; drop_caches 2 + governor (transient unit pgov, IDLE=0 unless +idle) per case; host 0.1 s samples $S/e2.host; summary by $S/summ.py; git index warmed in guest first (4.2 s, then 0.28 s))
git = `git status --porcelain` on repo40k (42,0xx fuse inodes incl .git); stat = `find tree64k -type f | xargs stat` (67k inodes).
work=git gov=none pause=0 runs_ms= 3450 235 274 237 host_max=42060 host_end=42057 prunes=0
work=git gov=none pause=5 runs_ms= 3538 413 372 422 host_max=42099 host_end=42099 prunes=0
work=git gov=none pause=30 runs_ms= 4058 422 369 391 host_max=42074 host_end=42074 prunes=0
work=git gov=30000 pause=0 runs_ms= 5010 4737 4663 4667 host_max=40307 host_end=11389 prunes=12
work=git gov=30000 pause=5 runs_ms= 4255 4563 4136 4601 host_max=39362 host_end=16781 prunes=12
work=git gov=30000 pause=30 runs_ms= 4476 4666 4697 4461 host_max=39638 host_end=15234 prunes=12
work=git gov=8000 pause=0 runs_ms= 5073 5022 5035 5089 host_max=40209 host_end=7365 prunes=49
work=git gov=8000 pause=5 runs_ms= 5153 5117 5188 5205 host_max=39662 host_end=4500 prunes=52
work=git gov=8000 pause=30 runs_ms= 5203 5021 5069 5163 host_max=37099 host_end=5877 prunes=50
work=git gov=30000+idle pause=30 runs_ms= 4819 5079 4878 4992 host_max=39236 host_end=16328 prunes=17
work=stat gov=none pause=0 runs_ms= 2407 1451 1385 1416 host_max=55129 host_end=24418 prunes=0
work=stat gov=none pause=5 runs_ms= 2087 1468 1443 1476 host_max=53399 host_end=7290 prunes=0
work=stat gov=30000 pause=0 runs_ms= 3179 3275 3280 3281 host_max=34280 host_end=29028 prunes=11
work=stat gov=30000 pause=5 runs_ms= 2960 3316 3286 3235 host_max=32531 host_end=28829 prunes=11
work=stat gov=8000 pause=0 runs_ms= 4431 4522 4523 4496 host_max=13061 host_end=5558 prunes=53
work=stat gov=8000 pause=5 runs_ms= 4415 4566 4473 4417 host_max=12794 host_end=8038 prunes=51
work=stat gov=30000+idle pause=30 runs_ms= 3174 3433 3460 3372 host_max=33921 host_end=28736 prunes=14
Note: 12,060 dirs + 60 files created on the host in shareA (outside repo40k) during the git none pause-0/5 cases.

## E3b ($S/shareR/bin/e3b.sh): working set within budget, idle prune vs none. tree20k turned into a git repo on the host (21,04x inodes). Governor B=30000, pause 30 s between runs.
warm baseline: git 1,323 (index refresh) then 116 ms.
IDLE=10 git ms: 152 (first, right after start), 2,458 / 2,299 / 1,758 (each after an idle prune during the 30 s pause)
IDLE=10 find|xargs stat (tree20k minus .git) ms: 473 / 807 / 879
IDLE=0  git ms: 1,741 (state left pruned by the IDLE=10 phase) then 203 / 224 / 206 (expired-but-cached, 30 s pause)
IDLE=0  stat ms: 138 / 201 / 221
=> after the same 30 s idle: idle-pruned git status 1.8-2.5 s vs 0.20-0.22 s cached (~10x); stat walk 0.8-0.9 s vs 0.2 s (~4x).
(prune counts from journalctl --since -4min were polluted by earlier cases of the same unit name; discarded.)

## E3 idle release (governor with PINATA_SHARE_IDLE; $S/shareR/bin/e3.sh then e3c.sh after a fix)
Design: quiet timer = summed sleep ms since the count last grew by more than 64 over a reference (ref follows the count down, resets up only on >64 growth). Idle prune when IDLE>0, quiet >= IDLE s and count > floor + margin, margin = max(1000, BUDGET/16) (1,875 at 30,000). After any prune floor = post-prune count, ref = floor.
First version (e3.sh) BUG: growth was checked after the idle decision, so a jump after a long quiet (watcher start 76 -> 12,024) triggered an idle prune on the first tick that saw it (1544.14, 0.4 s after the jump). Fixed by updating ref/quiet before deciding.
(a) e3.sh: 64k ls -R under B=30000 ended at 32,580 -> two budget prunes (34,488->1,062, 32,580->76); host 30,604 -> 6,195 -> 27 within 0.2 s. A walk that ends below budget: e3.sh q0 walk (16.8k files) ended 1548.01, idle prune 1558.97 (+10.96 s), host 28,831 -> 12,063 (watched floor) between two 0.1 s samples. e3c.sh (fixed): q0 walk ended 1734.57 (17,028), idle prune 1745.34 (+10.8 s), after=75.
(b) see E3b: after an idle prune, first git status 1.8-2.5 s vs 0.20-0.22 s cached-expired at the same 30 s pause; find|stat of 20k 0.8-0.9 s vs 0.2 s.
(c) 12,000 inotify-watched dirs (perl, IN_CREATE): e3c.sh: one idle prune ~9 s after the watcher reached its plateau (before=12,078 after=12,078: releases nothing, sets floor), then 0 prunes in 60 s idle (count 12,078 throughout). e3.sh (buggy order) same: 0 prunes in 60 s.
(d) trickle (one `stat` of a new file per second, 60 s) after a q1 walk (16,866): idle prune at +10.7 s (16,866 -> 130) while the trickle ran (growth 1/s < 64 per reference window, so quiet keeps accumulating), then no prune for the remaining ~50 s (count 130 < floor+1,875). A trickle can re-qualify only after +1,875 entries (~31 min at 1/s) and then prunes once per ~64 s window... i.e. at most one idle prune per ~31 min at 1 file/s.
(e) CPU of pgov over 60 s idle with 12k watched (e3.sh): cpu.stat usage 324,912 us = 0.54 % of one CPU.

## E5 read-only share
before prune and after an idle prune (e3c.sh): /proc/mounts shareR `virtiofs ro,relatime`; `touch shareR/x` -> "Read-only file system" rc=1; `echo y > shareR/ro/d00000/f00` -> "cannot create ...: Read-only file system" rc=2. Identical before/after.
Where remount takes options: LIBMOUNT_DEBUG shows `trying to apply fstab (src=(null), target=.../shareR)`, `/etc/fstab ... apply entry: optstr: ro,nofail,comment=cloudconfig`, synced vfs 'ro,remount'. So plain `mount -o remount <path>` re-applies the fstab line (lima/cloud-init writes the shares to fstab).
SURPRISE: `mount --options-source=disable -o remount shareR` made the guest mount rw (/proc/mounts rw,relatime; libmount synced 'rw,remount'); a write then failed with "Operation not permitted" (Apple's server enforcing ro) instead of EROFS. `mount --options-source=mtab -o remount` keeps the current flags (kept rw when rw, kept ro after `remount,ro` restore) and prunes the same (42,120 -> 111). Restored shareR to ro with `mount -o remount,ro`.
=> plain remount is right only while fstab matches the live mount; `--options-source=mtab` uses the live flags (util-linux 2.39.3 accepts it) and is the safer choice for the governor (not changed in the script; see report).

## E7 ceiling per process or per share ($S/shareR/bin/e7.sh; fdlab-e1 only, ungoverned, no other lab VM; shareR/t40k = 40,000 files 2,000 dirs created on the Mac)
20 s: 4 `ls -R` loops over shareA tree64k quarters (13 passes each) + 2 loops over shareR t40k (find -exec stat of half + ls -R; 9 passes each). Host 20 ms samples ($S/e7.host, 839 samples).
host max 55,298 (= ceiling seen in labs A/D with one share), median of second half 34,200 (sawtooth), last 35,770; guest fuse_inode at end 109,224. kern.num_files 42,446 after.
Guest errors: stderr of all walkers 0 bytes; dmesg only the drop_caches line.
lsof split of the VM's fds by path every ~1.5 s (A / R): 17,082/11,346; 20,918/16,736; 29,932/22,336; 11,061/9,004; 20,321/16,388; 22,517/6,722; 11,184/9,290; 17,875/13,974; 28,151/23,435; 21,312/16,413; 1,462/2,858; 21,326/16,976; 28,358/23,142 -> both shares drop together: one per-process pool, purges hit both shares' entries.
=> ceiling is per VM process (~55,300), shared by all shares; not per share.

## E4 two VMs (fdlab-e2: PID 41306, `--mount $S/shareE2:w --mount $S/shareR`, shareE2 = APFS clone (cp -cR, 8.3 s) of tree64k + repo40k; e2 git index warmed then pruned). Host sampler $S/e4.host (0.1 s, both pids + kern.num_files); safety loop $S/safety.sh (0.1 s kern.num_files, >108,000 -> colima ssh into both VMs: pkill -x ls/git, remount virtiofs mounts).
Load $S/shareR/bin/e4load.sh: 4 parallel `ls -R` loops over tree64k quarters + `git status` loop, 30 s; then 15 s idle (IDLE=10).
INCIDENT (my harness bug): the first run of cases (i) and (ii) was driven from a zsh loop with `set -- $c`; zsh does not word-split, so the gov argument arrived empty, `[ $gov != none ]` failed ("unary operator expected") and NO governor started: both cases ran with BOTH VMs UNGOVERNED, against the rule. Results of that accidental run:
  "i" (both ungoverned): e1 max 61,440, e2 max 60,591, sum max 109,211, kern.num_files max (0.1 s samples) 116,205; safety max 121,549 (maxfiles 122,880)
  "ii" (both ungoverned): e1 max 60,286, e2 max 61,440, sum max 110,225, kern.num_files max 117,163
  safety loop tripped 10 times (110,026-121,549); reaction (colima ssh) too slow to stop the climb.
  Guests saw errors: /tmp/e4err e1 3,695 lines (3,317 "Too many open files" = EMFILE from the VM process at kern.maxfilesperproc 61,440; 239 "Too many open files in system" = ENFILE, the Mac's table full), e2 4,825 lines (4,463 EMFILE, 241 ENFILE). So the Mac's file table actually filled for moments; other Mac processes may have seen ENFILE then. No guest dmesg lines.
  SURPRISE: the ~55,300 self-purge ceiling is not a hard cap: under 4 parallel ls -R + git status the process reached 61,440 and returned EMFILE to the guest (in E7, 6 walkers on one VM, it stayed at 55,298).
Fixed harness (explicit args, script aborts unless pgov is active), case (i) both governed B=30000 IDLE=10:
  e1 max 59,767, e2 max 58,077, sum max 113,907, kern.num_files max 120,821 (at +1.9 s); safety tripped once (110,026 at +1.1 s after load start). Medians over the load: e1 24,787, e2 23,222, sum 47,516; samples with kern.num_files >100k: 4 of 326.
  Guest errors: e1 97 lines, e2 190 lines, all "Too many open files in system" (ENFILE) from the first ~2 s.
  Timeline (s from load start, e1/e2/kern.num_files): 0.8 5,276/3,222/15,402; 1.3 28,172/25,855/60,926; 1.4 32,884/31,098; 1.9 58,254/55,653/120,821; 2.0 25,614/15; 2.1 19/15. e1 governor pruned at +0.69 s (31,968 -> 1,170) and the host kept climbing for another ~0.5 s to 58k: Apple's FORGET processing lags, host = unreleased old + new lookups. e2 again 58,077 at +3.4 s after its prune at +2.1 s (32,922 -> 1,116); fell at +3.5 s.
  passes: e1 19 x4 ls + 2 git; e2 19-20 x4 ls + 2 git; prunes 42 / 43 over the case.
  15 s after load: e1 guest 94 (idle prune 20,610 -> 94), e2 76 (idle prune 8,604 -> 76); host 80 / 31; kern.num_files 6,789.
Case (ii) (e1 governed, e2 ungoverned) NOT rerun: after (i) showed the governed VM itself reaches ~58-60k under a cold parallel burst, (ii) would be ~61.4k + ~60k + 6.8k > 122,880 and the safety loop proved too slow. Both-ungoverned arithmetic: measured above (accidentally): 2 x 61,440 + ~6,800 base = 129,680 > 122,880 -> ENFILE, as observed.
E6 (bash fifo tick): not run (time).

## Cleanup
safety loop stopped (stop file), samplers killed. `colima delete fdlab-e2 --force --data` and `colima delete fdlab-e1 --force --data`: "deleting container data ... done". Stray `ssh: .../colima-fdlab-e1/ssh.sock [mux]` PID 36655 and `.../colima-fdlab-e2/ssh.sock [mux]` PID 41312 killed; no fdlab-e processes left; ~/.colima/_lima has no fdlab-e dirs. docker context `colima`. colima list: default Running, pinata Stopped. Scratch lab-e removed. kern.num_files 6,658 (baseline 6,620).
