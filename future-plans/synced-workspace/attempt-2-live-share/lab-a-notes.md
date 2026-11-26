# Lab A notes (fdlab-a)

Scratch: the scratch folder's `lab-a/`
Profile: `colima start fdlab-a --vm-type vz --mount-type virtiofs --runtime docker --cpu 2 --memory 3 --disk 20 --mount $S:w` (20.6 s). colima 0.10.3.
NOTE: colima start switched docker context to colima-fdlab-a; restored with `docker context use colima` immediately.
Baseline kern.num_files=6596 before start.
My VM process: PID 3155 (com.apple.Virtualization.VirtualMachine, started 1 s after hostagent 3149 for colima-fdlab-a; lsof shows lab-a paths in 3155, none in 3349 (fdlab-b)); default's is 39113.
fd counter: libproc proc_pidinfo(PROC_PIDLISTFDS) via ctypes ($S/fdcount.py). 12 fds vs lsof 23 lines at idle (lsof adds cwd/txt/mmap rows).
Guest: kernel 6.8.0-117-generic, Ubuntu 24.04.4 LTS, 2 CPU, 2899 MB.
/sys/module/fuse/parameters: allow_sys_admin_access=N max_user_bgreq=942 max_user_congthresh=942 (no inval_wq -> E2e n/a on 6.8)
slabinfo: fuse_inode 18 active (896 B objs), fuse_request 52.
/proc/mounts: `lima-6c5b7de0f308583c <scratch> virtiofs rw,relatime 0 0`
cgroup2 unified.

## E1 direct in VM (20,000 files / 1,001 dirs, after drop_caches 3)
base: vmfds=14 fuse_inode=36
ls -R: vmfds=21016 (+21002, = 1.0 per entry, files AND dirs) fuse_inode=21024  -> readdir alone costs fds (READDIRPLUS instantiates inodes)
find -printf %s (stat): +0 (already cached)
cat all: +0 fds, Cached +80 MB
5000 negative lookups ([ -e nopeN ]): +0 fds, dentry +71
fuse_inode active - vmfds ~= constant (~8-10): exact estimator.

## E1 extra
cold, xargs stat of 2000 explicit paths (100 dirs x 20): +2103 fds (2000 files + 100 dirs + ancestors), no readdir.
`ls` one 20-file dir: +21; `ls -f` (no stat) another dir: +21; python os.listdir 100 dirs: +2100 => readdir = 1 fd per entry.
fuse_inode active lags by slab granularity (18 objs/slab; per-cpu partials) - +21 fds not visible once.
## E1 container (alpine, -v tree:/t, ctr fdc)
cold ls -R: 48 -> 21049 (+21001); stat after: +0; cat all: +0 (Cached +80MB)
cold: 3000x stat same file + 3000 neg lookups: +4 total
cold find -exec stat: 57 -> 21058 (+21001). Same as VM-direct.
NOTE kern.num_files system-wide reached 54767 due to fdlab-b concurrently.

## E2a drop_caches (tree warm 21,058 fds)
echo 1: fds 21058 -> 21058 (no release), Cached -11MB
echo 2: 21058 -> 66 ; dentry 25977->4999
echo 3: 21067 -> 75
## E2b remount, first try (after warming ext4: find /usr /var, cat /usr/bin/*)
warm: fds 21077 fuse_inode 21024 dentry 28539 ext4 3016 Cached 350436kB
`mount -o remount <mp>`: rc=0, 12 ms; measured ~1 s later: fds 4616, fuse_inode 74, dentry 7802, ext4 3016 (untouched), Cached 350616 (untouched). /proc/mounts options unchanged (rw,relatime).
then drop 2: fds 23, ext4 3016->2895, dentry -> 4965.
(4616 residual: FORGET delivery lag? sampled below)
remount timing (sampled every 0.5 s from Mac): 21024 -> 5728 at first sample (~0.3 s), -> 32 at +0.5 s. Full release < ~0.8 s. Remount syscall itself 1-12 ms.
Pinned case (bash with cwd in d0000, fds 3,4 open on 2 files, find -exec stat running, two remounts at +0.3 s/+0.5 s): both rc=0, find rc=0 and printed all 20000, no stderr; cwd + open fds still readable (100 B each); mount opts unchanged. (find may have finished before the remount — ambiguous on mid-walk)
Containers (alpine): no caps: "permission denied" rc=1, nothing released; --cap-add SYS_ADMIN: "Permission denied" rc=255 (AppArmor docker-default blocks mount), nothing released; --privileged remount of a SUBDIR bind (-v tree/d0000:/sub): rc=0, released whole superblock 21038 -> 46. Bind mounts share the sb, so any bind = whole-share prune.

## E6 ceiling (64,000 files: tree20k + tree44k (2200 dirs x 20), ~67,212 guest fuse inodes incl dirs)
Host: `launchctl limit maxfiles` = 256 unlimited; shell ulimit -n 1048576 / unlimited; `sudo -n true` -> password required (no sudo).
Watchdog ($S/watchdog.sh) sampling sys/vm every 0.5 s, trip at 90000: never tripped (max sys 71,318).
cold os.stat of 64k explicit paths (python, $S/statwalk.py): 1.91 s, avg 33,538/s; 40k/s for first 28k files, ~29-30k/s for 32k-64k. errs={} (no errors).
host fds during walk (0.5 s samples): 48, 10492, 31899, 48693, 54021, 50634 -> settles 53507 after restat.
after walk: vmfds 50,633 while guest fuse_inode 67,212 -> host server caps and recycles; guest does not see it.
restat OLDEST 8000 (evicted on host): works, 29k/s, errs none, host fds +2874 (server reopens).
read (open+read) all 64k twice at ceiling: 8,083/s and 8,262/s, errs none; fine sampling 50 ms: max 55,302 (= 0.9*61440=55,296 + ~6 base fds), sawtooth ~49,800 <-> ~55,000 (drops ~5k at a time = batches of ~10%?). Idle after: 52,342 stable.
No thrashing cliff: read rate identical pass 1 vs pass 2 (both mostly at ceiling); stat of host-evicted ~29k/s vs 40k/s cold-below-ceiling.
E6b: stopped fdlab-a, `(ulimit -n 4096; colima start fdlab-a)`: new VM PID 8308 (ppid 1 = launchd, like hostagent 8302). Read-walk 64k: max fds 55,276 (fine 50 ms sampling), plateau ~50.6k after -> ceiling UNCHANGED by the starter's rlimit. XPC service is spawned by launchd; no rlimit inheritance. Skipped the -Hn 8192 variant (same mechanism). No unprivileged way found; kern.maxfilesperproc change would need sudo (not available: password required) - not attempted.

## E3 pinning (tree20k warm ~21.06k fds, then remount)
2000 files held open (python, 100 dirs x 20; guest needed ulimit -n 8192): warm+held 23,098 (= +2000 -> each OPEN file costs a 2nd host fd); after remount 4,154 (= 2000 x 2 + 100 parent dirs + base); drop_caches 2 same 4,155; after closing + remount 44.
inotify watches on 1001 dirs (python ctypes inotify_add_watch): after remount 1,032 (dirs pinned, their 20k children released); drop2 1,033; after kill + remount 74.
=> watcher pins 1 fd per watched dir (and inode), not per file; open files pin 2 each plus ancestors.

## E4 cost (tree20k, 20,000 files + 1,001 dirs; guest root; $S/e4.sh), 3 runs
find|xargs -0 stat: cold(after drop2) 471/373/357 ms; warm 234/135/170 ms; post-remount 475/416/419 ms
git status: cold 2333/1244/1540 ms; warm 122/118/118 ms; post-remount 1474/1379/2231 ms

## E5 governor (workload: python statwalk.py over 60,000 explicit paths, read=open+read / stat; host fds sampled every 0.1 s by fdcount.py; ext4 cache pre-warmed with find /usr /var + cat /usr/bin/*)
no governor read: 10.83 s (5,542/s) [earlier run 12.30 s], max 54,926 mean 32,632, ends 51,966
no governor stat: 2.94 s (20,392/s), max 55,008 mean 37,403
guest gov B=5000 I=1s read: 9.34 s, max 7,599 mean 3,086, prunes 9 ; stat: 1.88 s, max 28,083 mean 8,507, prunes 3
guest gov B=20000 I=1s read: 6.97 s, max 29,449 mean 11,190, prunes 2 ; stat: 2.37 s, max 32,618 mean 9,515, prunes 2
guest gov B=5000 I=0.1s read: 7.63 s, max 5,041 mean 2,536, prunes 12 ; stat: 2.22 s, max 5,820 mean 3,299, prunes 10
collateral of remount governor: ext4 slab 4901 -> 4914 / Cached unchanged (none)
existing-design mimic (hostgov.sh: lsof every 10 s, >30720 -> drop_caches=2, 30 s cooldown):
 read: max 49,096 mean 19,732 (drop fired at 46,224) ext4 4901 -> 2736, dentry all
 stat: 1.75 s max 54,245 mean 39,476 (no drop during run; drop 12 s later at 51,974, ext4 4914->2738)
 read again: max 54,940 mean 34,686, cooldown blocked, ended at 51,967 for >12 s.
Peak lookup rates: cold os.stat explicit paths 34,312/s single thread; 2 threads 21.5k+21.2k = ~42.7k/s; cold `ls -R` 64k files (READDIRPLUS) 67,266 entries in 1.43 s = 47k/s, 50 ms samples show ~3,400 fds/50 ms = ~68k/s peak.
SURPRISE: during fast ls -R at ceiling host count collapsed 54,153 -> 11,419 in one 50 ms step (server bulk-evicts, not 10%), then regrew to 23,325 while guest held 67k inodes.
drop_caches 2 release of 23k: completed between two 50 ms samples ... (7517 then 29).

## E2c vfs_cache_pressure=10000, no memory pressure: 21,030 -> 21,031 after 15 s. No release. (restored to 100)
## E2d memcg (alpine, -v share:/s, find|xargs stat 64k; cgroup /sys/fs/cgroup/docker/<id>, cgroupfs driver)
--memory 200m: no limit hit (memory.events max 0), cg memory.current 77.3 MB, slab 77.2 MB (~1.15 KB per inode, 67,266 inodes); host max 52,413 (ceiling sawtooth). Not bounded.
memory.reclaim 100M: shell reports "echo: I/O error" rc=1 (EAGAIN: could not reclaim the full amount) in 41 ms, but cg current 77 MB -> 0.3 MB, host fds 27,584 -> 65, ext4 slab/Cached unchanged. Charged only -> container-scoped release. 
--memory 24m: memory.events max=3, walk peak 20,762 fds, ends 7,407, cg 8.8 MB. => memcg limit bounds (with overshoot), but limit also constrains the app.
remount mid-walk: cold `find tree20k tree44k -type f -exec stat` with `mount -o remount` every 50 ms: 30 remounts during the walk, find rc=0, 64,027 lines (all files incl .git), 0 bytes stderr.

## Counting cost at ~40k fds (39,962 by libproc)
`sh -c "lsof -p PID | wc -l"`: 39,973 lines, real 0.13 s (x3). `lsof -Ff`-style run: real 0.04 s.
python3 fdcount.py one-shot process: real 0.01 s (x3); in-process proc_pidinfo(PROC_PIDLISTFDS): 0.122 ms per call.
guest: awk fuse_inode out of /proc/slabinfo: 283 us per call (39,924 active at that moment vs host 39,962).

## Cleanup
`colima delete fdlab-a --force --data`: "Deleted colima-fdlab-a ... deleting container data ... done". docker context back to `colima *` (fdlab-a context gone).
colima list: default Running, pinata Stopped (fdlab-b no longer listed; not mine). Scratch lab-a removed.
Stray `ssh: .../colima-fdlab-a/ssh.sock [mux]` PID 8314 killed; afterwards no fdlab-a processes. kern.num_files 6663 (baseline 6596).
Seen but not mine: limactl create fdlab-c (krunkit), another lab.
Watchdog max system-wide kern.num_files during my runs: 71,318 (E6a) / 61,472 (E6b onward); never tripped 90,000.
