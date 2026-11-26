# Lab D notes (fdlab-d): shipping-form governor

Scratch: the scratch folder's `lab-d/`
Baseline kern.num_files before start: 6768

## Setup
`colima start fdlab-d --vm-type vz --mount-type virtiofs --runtime docker --cpus 2 --memory 3 --disk 20 --mount $S/shareA:w --mount $S/shareB:w`: 20.4 s; context switched to colima-fdlab-d, restored with `docker context use colima` right after.
VM process PID 25958 (Virtualization.VirtualMachine started 1 s after hostagent 25952 for colima-fdlab-d). default's VM is 39113. fdlab-c hostagent 25381 (lima, not mine).
Guest: 6.8.0-117-generic, /bin/sh -> dash, no busybox, perl present, coreutils `sleep 0.1` works. fuse_inode is line 24 of /proc/slabinfo (371 lines, 39.8 KB).
/sys/kernel/slab/fuse_inode/ exists, not aliased (aliases=0) -> `objects` file readable with a shell builtin `read`.
Host sampler: $S/fdsample.py (libproc PROC_PIDLISTFDS, interval arg), summ.py; harness $S/run.sh (drop_caches 2, transient unit pgov via systemd-run, sampler, workload over colima ssh, prune lines from journal).

## Count cost (guest, 1000 iterations, $S/costs.sh)
awk fork over /proc/slabinfo: 282 us/call; dash while-read over slabinfo with break at match: 421 us; `read n _ < /sys/kernel/slab/fuse_inode/objects`: 4 us. `sleep 0.1` loop: 104.4 ms per tick (4.4 ms fork+exec overhead).
Decision: builtin read of sysfs objects (no fork), awk fallback if sysfs file absent. Only fork per idle tick = sleep.

## Mount path unescaping (dash)
bind mounts at "/mnt/with space", "/mnt/b\s", "/mnt/tab<TAB>x" -> /proc/self/mounts shows \040, \134, \011. unescape = sed \NNN -> \0NNN then printf %b (+x sentinel). Test with dedupe disabled: all 5 remounts ok (shareA, shareB, 3 odd paths), failed=0. Dedupe by source tag (one remount per superblock).

## Floor measurement
Immediately after remount guest count 7,883 (from 16,830; RCU-delayed inode free), +10 ms: 92. v1 re-read after a full tick (0.1 s) measured floor ~6,600 during a 4x ls -R (regrowth during the wait) -> trigger inflated to 10.6k. v2: settle 0.02 s then read -> floor ~1,300 under the same load (regrowth during 20 ms + fork), trigger stays at BUDGET.

## T1 (tree64k = 64,000 files, 3,204 dirs; 4x parallel ls -R of quarters; drop_caches 2 before)
v1 (0.1 s host sampling): none: 1.29 s wall host, ls 1105 ms, max 51,110, settled host 11,886 vs guest 67,230 (Apple recycled). B8000: ls 1042 ms, max 13,151, 5 prunes; B30000: ls 1038 ms, max 34,619, 2 prunes.
v2 governor, 20 ms host sampling:
 vm none : ls 1145 ms, max 54,637 mean 21,841, settled host 12,956 / guest 67,212
 vm 8000 : ls 1115 ms, max 13,254 mean 8,036, 5 prunes, guest before 12,024-13,716 (overshoot <= 5,716 over 8000)
 vm 30000: ls 1112 ms, max 35,097 mean 18,316, 2 prunes, before 35,604/31,032 (overshoot <= 5,604)
 ctr none : host wall 1.57 s (incl docker run), max 54,406, settled 48,820 / guest 67,230
 ctr 8000 : 1.46 s, max 13,507 mean 7,380, 5 prunes, before max 13,518
 ctr 30000: 1.41 s, max 30,790 mean 16,995, 2 prunes, before max 31,590
(busybox date has no %N so in-container ms printed 0; host wall used.)
nf_before reached 55,650 once (system-wide, others' VMs); < 95,000.

## T2 pinned floor (dirs12k = 12,000 empty dirs watched by perl inotify via syscall(26/27), IN_CREATE; max_user_watches already 1048576; walk = 4 parallel `ls -R` loops over tree64k quarters for 30 s)
first attempt: `kill %1` failed in dash (no job control) so the harness hung 150 s idle after the walk; stats cover 188 s: max 19,678, 242 prunes; prunes per second from journal: 8/s throughout the 30 s walk, 0 during the 150 s idle with 12k pinned.
 none : walk 30,123 ms, passes 23/24/23/23 (93), max 55,317 mean 27,688, settled host 34,882 / guest 79,236
 8000 : walk 30,427 ms, passes 27x4 (108, +16%), max 19,655 mean 16,720, 244 prunes (~8/s = every tick: cycle ~0.125 s), floor (after) mean 13,254 (12,042 pinned + regrowth in the 20 ms settle), trigger ~17.3k, guest before max 19,854 -> peak = floor_pinned + ~7.6k, trigger overshoot <= ~2.5k.
 idle with watches 20 s after one ls -R of a quarter: 4 prunes all during the ls; last after=12,239 trigger=16,239; no prune afterwards (no thrash).
Note: the every-tick pruning during the walk comes from the workload rate (~60k/s x 0.125 s = 7.5k > B/2 = 4k headroom), not from the floor.

## T3 (drop_caches 2 before each case; per-iteration ms from guest date +%s%N; guest sampler 50 ms for divergence via $S/diverge.py)
(i) git status --porcelain x5, repo40k (40,000 files, 2,000+4 dirs; index warmed once in the guest beforehand):
 none : 4373 257 300 343 384 ms; host max 42,075, settled 42,070 / guest 42,030
 8000 : 8318 8106 8116 8198 7960 ms; 67 prunes; host max 39,781 (!) mean 6,786
 8000 (rerun with guest sampler): 6041 5990 5408 5383 5442; 61 prunes; host max 41,348; host-guest max +36,732
 30000: 7903 5280 4807 5569 5824 ms; 15 prunes; host max 39,848
 SURPRISE: with prunes every 0.1-0.2 s, the host count climbs to ~37-41k while the guest sawtooths 0-12k (samples at 1795563414.2-.6: host 17k->37k, guest 684..11250). Apple's server releases (FORGET processing) lags behind new lookups under load; it caught up within ~0.5 s once lookup rate fell. The budget does not bound the host under re-lookup thrash.
(ii) find . -type f | xargs stat x10, tree64k:
 none : 3074, then 1439-1528 ms (warm; guest keeps 67k though Apple recycles); host max 55,241
 8000 : 4623-4723 ms every pass; 134 prunes; host max 11,765; host-guest max +11,151
 30000: 4203 4274 4551 4447 4410 4526 4832 5538 6091 5721; 39 prunes; host max 33,143; host-guest max +31,223
(iii) 4 readers, xargs cat over 20,000-file subset (q0 + 4,000 of q1), 30 s (list built by find before drop_caches; that phase sets the max):
 none : 10 passes each; max 33,107 (find phase); settled 21,037
 8000 : 11 passes each; 32 prunes; max 8,789
 30000: 11 passes each; 0 prunes; max 29,209 (list phase) ; harness journalctl grep -c exit 1 when 0 matches (harmless)

## T4 npm ci --ignore-scripts (node:24 container, -v shareA/npm:/w, pinata package.json + lock; network OK; npm cache inside container, so every run downloads)
 warmup none: 5,284 ms; host max 21,511
 none : 4,982 / 4,951 ms; max 21,491 / 21,483; settled 21,490 (guest 21,420)
 30000: 5,020 / 4,942 ms; 0 prunes; max 21,487 / 21,479
 8000 : 4,990 / 5,025 ms; 2 prunes each; max 7,953 / 8,210; settled ~5,900
 node_modules from guest: du -s 315,352 KB; find | wc -l 21,403 entries (1,903 dirs).

## T5 latency probe (perl Time::HiRes, stat + open/read 4 KB/close alternating hot.bin on shareA and shareB, 30 s; 4 walkers on shareA tree64k)
first run had a perl $a/$b sort shadowing bug -> discarded.
 none+walkers : statA p50 561 us p99 1,267 p99.9 1,541 max 62.5 ms; readA 1,455/2,020/50,343 us max 131.1 ms; statB 27/52/119 us max 0.6 ms; readB 111/146/518 us max 0.8 ms; walk passes 24x4; host max 54,907
 8000+walkers : 131 prunes (4.4/s); statA 500/1,165/1,858 us max 3.2 ms; readA 1,366/2,077/3,357 us max 4.2 ms; statB 27/71/364 us max 1.7 ms; readB 115/296/1,503 us max 2.5 ms; passes 26-27x4; host max 13,828
 idle (no walkers, no gov): stat 21/32/38 us max 0.7 ms, read 97/117/131 us max 0.8 ms (both shares)
 Note: prune rate 4.4/s, higher than the 0.5-1/s asked (4 walkers at B=8000); 1-walker variant not run (time).

## T6 robustness (transient pgov B=8000, 20 s of 4 walkers, 89 prunes in the run)
 named volume t6v over shareA/t6/sub in a container appending every 10 ms: 2,826 lines, 0 sequence breaks, no VFAIL
 container cwd /s/tree64k/q3/d03199 doing ls + cat + pwd check every 10 ms: no LSFAIL/CATFAIL/PWDFAIL, still running
 mmap MAP_SHARED 1 MB file on shareA (python3 in guest, test only): 3,135,200 writes, 0 mismatches (read-back via mmap and via read() every 1000), host sees final value 3,135,199
 executable copied to the share and running (/bin/sleep, text mmapped): alive after
 appender (VM-direct echo >> file): 24,751 lines, 0 breaks (checked on host)
 host-guest divergence in this run: max +12,595, median 38.

## G1 CPU (cgroup cpu.stat usage_usec of the unit)
 fixed 0.1 s tick, B=30000, idle 60 s: 589 ms CPU = 0.98 % of one CPU (cost = fork/exec of sleep, ~1 ms/tick)
 final (interval stretched to (trigger-count)/70000 s, clamped 0.1..1 s), B=30000 idle 60 s: 238 ms = 0.40 %
 final, B=30000, 4 walkers 30 s: 659 ms / 29.6 s = 2.2 %, 54 prunes
 T1 with final script (20 ms sampling): B8000 ls 1,100 ms, host max 14,021, guest before max 14,040, 5 prunes; B30000 ls 1,058 ms, host max 34,065, before max 34,218, 2 prunes.

## G2 deployment
(a) persistent: one `colima ssh -- sudo sh -c '<base64 script> | base64 -d > /usr/local/libexec/pinata/...; <base64 unit> > /etc/systemd/system/...; daemon-reload; enable; restart; is-active'` (3,408-byte command): 0.41/0.33/0.31 s. Check (sha256 of script+unit + is-active): 0.17/0.15/0.16 s ("stale" before reinstall after script change, "ok" after).
   colima stop (1.7 s) + start (13.2 s): unit active, check ok without reinstalling. New VM PID 34847. shareB treeB (10,500) then shareA q0+q1 -> prune before=34,128 after=1,134 mounts=2: both shares released.
(b) transient: `systemd-run -q --unit=pinata-share-governor -p Restart=always -p RestartSec=1 --setenv=... /bin/sh /run/pinata/share-governor.sh`, script to /run (tmpfs) in the same ssh command, guarded by is-active + sha256 (no-op when running): first 0.17 s, then 0.16/0.15 s (no-op). systemctl kill -s KILL -> restarted (NRestarts=2 incl. an earlier pkill). After colima stop/start: inactive, /run/pinata gone (nothing persistent); reinstall 0.17 s. No files in /etc/systemd/system.
 Mistake: `pkill -f share-governor.sh` inside `colima ssh sh -c '...'` killed the ssh session's own shell (command line contains the pattern), exit 255.

## T7 kprobe: `p:fev fuse_change_entry_timeout ...` registered (symbol in kallsyms and available_filter_functions), stat of 3 fresh files: 0 events. Second try `p:ftj fuse_time_to_jiffies sec=$arg1 nsec=$arg2` with 3 more fresh files: 0 events. Probes removed (kprobe_events empty). Inconclusive; not investigated further (time).

## Divergence host - guest (host 0.1 s samples matched to guest 50 ms samples within 60 ms; clock offset ~tens of ms)
 t3git-8000: max +36,732 (sustained ~0.5 s, host release lag), median 15
 t3stat-30000: max +31,223, median 76; t3stat-8000: +11,151, median 91; t3read-8000: +8,344; t6-8000: +12,595; t3read-0: +18,919 (at the script's drop_caches)
 negative extremes (guest > host): t3stat-0 -60,480 / median -27,990 (Apple's ceiling recycling), others -2k..-20k right after prunes (guest frees instantly, host lags).
 => the "within a few hundred" agreement holds only at rest (settled values, every run: within 30-110, except ceiling cases).

## Cleanup
`colima delete fdlab-d --force --data`: done. docker context `colima`. Stray `ssh: .../colima-fdlab-d/ssh.sock [mux]` PID 35320 killed; no fdlab-d processes left. Scratch lab-d removed.
colima list: default Running, pinata Stopped, fdlab-c-vz Running (lab C, not mine; its VM PID 30642, context colima-fdlab-c-vz). kern.num_files 6,811 after (baseline 6,766 at my start).
