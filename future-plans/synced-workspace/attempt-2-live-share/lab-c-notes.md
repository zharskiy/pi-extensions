# Lab C notes (krunkit vs vz)
## Step 0
- colima 0.10.3: `--vm-type` accepts qemu, vz, krunkit. limactl 2.3.0 drivers: vz, krunkit, qemu.
- brew snapshot before: colima 0.10.3, gh 2.102.0, go 1.27.1, lima 2.3.0, uv 0.12.23; taps: (none listed)
- installed (homebrew-core, no tap): krunkit 1.3.2, libkrun 1.19.8, libkrunfw 5.6.4, libepoxy 1.5.10, molten-vk 1.4.2. Nothing upgraded.
- lab B scripts gone; commands reconstructed from lab B's output labels (see scripts in scratch, quoted below).
- tree: cp -a of pinata node_modules: 19491 files, 1910 dirs, 19 symlinks; tarball share/tree.tar 278,564,864 B
- `colima start --profile fdlab-c --activate=false --vm-type krunkit --mount-type virtiofs --cpus 2 --memory 3 --disk 20 --runtime docker --mount $S/share:w` FAILS in 1 s:
  `Failed to set config ... field mountType must be virtiofs or reverse-sshfs for krunkit driver, got 9p` — colima 0.10.3 writes mountType virtiofs to colima.yaml but hands lima 9p for any non-vz VM. So colima cannot run krunkit+virtiofs (only krunkit+sshfs would pass lima's check). Profile deleted (colima delete fdlab-c --force --data).
- Fallback: plain lima (default LIMA_HOME ~/.lima, did not exist before):
  `limactl create --tty=false --name=fdlab-c --vm-type=krunkit --cpus=2 --memory=3 --disk=20 --mount-type=virtiofs --mount-only "$S/share:w" template:docker-rootful`
  downloaded ubuntu-26.04-server-cloudimg-arm64 (release-20261016) into ~/Library/Caches/lima/download/by-url-sha256/274d5996... (new, remove at cleanup)
  `limactl start --tty=false fdlab-c` real 30.15 s (first boot incl. get.docker.com install)
- guest: Linux 7.0.0-38-generic Ubuntu 26.04 aarch64; docker 29.10.1 rootful (overlayfs); fuse API 7.45; dmesg "virtio_fs_setup_dax: No cache capability"
- mount: `lima-0e6f782ecf5c4a81 <share> virtiofs rw,relatime 0 0`
- host processes: krunkit pid 25389 (`krunkit --memory 3072 --cpus 2 ... --device virtio-fs,sharedDir=<share>,mountTag=lima-... --device virtio-net,type=unixgram,fd=13 ...`), lima-driver-krunkit 25377, limactl hostagent 25381, ssh mux 25420. No gvproxy/vmnet process seen (net via unixgram fd from driver).
- krunkit baseline: 122 fds (103 PIPE, 8 KQUEUE, 10 REG, 5 unix, 1 DIR = /private/tmp); RSS 3.79 GB, vmmap physical footprint 3.6G right after boot (whole 3 GiB guest RAM counted).

## K1+K2 bench (scripts/bench.sh, fd count via libproc PROC_PIDLISTFDS; timings measured in guest with date)
commands: stat walk = `find tree -printf '%s\n'`; read = `find tree -type f -print0 | xargs -0 cat`; drop = `sync; echo 3 > /proc/sys/vm/drop_caches`; untar = `tar -xf tree.tar -C u; sync`; rm = `rm -rf u`; git = init, cp -a tree, keep first 10000 files (sorted), add -A, commit (time includes the cp onto the share); status = `git status --porcelain` after drop, then twice warm.
```
== root=$SCRATCH/lab-c/share
  [kern.num_files=6843]
M1 fds baseline (after drop): 122  rss_kb=3788272 vnodes=249863
M2 stat cold: 1.100434958
M1 fds after stat walk: 122  rss_kb=3795984 vnodes=249863
  [kern.num_files=6843]
M2 stat warm: 1.083992375
M1 fds after warm walk: 122  rss_kb=3796016 vnodes=249863
M3 read cold: 9.299885122
M1 fds after read all: 122  rss_kb=3837936 vnodes=249863
  [kern.num_files=6843]
M3 read warm: 6.514466381
M1 fds 10s after readers exited (no drop): 122  rss_kb=3838128 vnodes=249863
M1 fds after drop_caches: 122  rss_kb=3839264 vnodes=249863
  [kern.num_files=6848]
M4 run1 untar+sync: 7.439228284
M1 fds after untar: 122  rss_kb=3887792 vnodes=249863
  [kern.num_files=6814]
M4 run1 rm: 2.857427095
M1 fds after rm: 122  rss_kb=3888864 vnodes=249863
M4 run2 untar+sync: 7.500701325
M1 fds after untar: 122  rss_kb=3888944 vnodes=249863
  [kern.num_files=6791]
M4 run2 rm: 2.864916210
M1 fds after rm: 122  rss_kb=3889296 vnodes=249863
M5 git init+add+commit: 39.936381535
M5 files in repo: 10019
M5 git status cold: 1.050648752
M5 git status warm: 1.018404466
M5 git status warm2: .986501462
M1 fds after git: 124  rss_kb=3953936 vnodes=249863
  [kern.num_files=6771]
```
- kern.num_vnodes constant 249863 throughout (looks like a fixed table size, not a live count -> uninformative)
- GNU tar untar of the 19 symlinks: no tar error on krunkit (vz in lab B: 19 'Permission denied')
- attr cache: warm stat walk == cold (1.08 vs 1.10 s) and warm git status == cold (~1.0 s): consistent with attr_timeout=0 in krunkit's default 'simplified' semantics (notes-krunkit.md)

## K1 rest (krunkit pid 25389)
```
before: fds=125 rss_kb=887312 num_files=6815            (RSS fell from 3.9 GB on its own: host reclaimed guest pages)
holding 2000 (guest python opens 2000 files, ulimit 4096): fds=2125 num_files=8829
after close: fds=125
inotifywait -r -m on tree (1910 dirs), 15 s: fds=125
after inotify exit: fds=125
60k tree: cp -a tree x3 on Mac -> share/big, 64261 entries
before 60k walk (after drop): fds=122 rss_kb=1125008; guest slab fuse_inode 336
after 60k stat walk (find -printf, 3.12 s): fds=122 rss_kb=1193008; guest fuse_inode 64288 (guest really caches 64k inodes)
after 60k read (xargs cat, 28.7 s): fds=122 rss_kb=2609808 (guest page cache 1.2 GB -> guest RAM pages)
after guest drop_caches: fds=122 rss_kb=2618160 (RSS does not shrink: freed guest pages are not returned to host)
kern.num_vnodes 249863 at every point
```
- per-inode host memory, measured in krunkit's malloc zone (vmmap --summary DefaultMallocZone): after drop: 1351 allocs / 568K allocated; after 60k stat walk: 86586 allocs / 11.8M => ~85k allocations, ~11.2 MB for 64k cached inodes = ~175 B per inode. After drop_caches: 1351 allocs / 568K again (FORGET frees it). RSS deltas are dominated by guest RAM pages and are not per-inode host cost.
- Verified: krunkit fd count is flat at 122-125 for stat, read, untar, rm, git, inotify and a 64k-inode cached walk; only open guest handles cost fds (2000 open -> +2000, released on close).

## K3 host->guest visibility (scripts/vis.py drives, scripts/poll.py runs in guest via `limactl shell fdlab-c -- python3 -`)
method: fresh dir per rep under share/vis; guest poller reads state once (warms dentry/attr/page cache), prints ready; host waits 0.2 s, applies the change, records time; guest busy-loops (stat + open/read of 64 KiB file, ~40-100k iterations in 12 s) and logs every state transition with guest time; host->guest clock offset from 7 ssh round trips, min RTT 62 ms => +-31 ms uncertainty (so small negative delays = "immediate").
content: old = 64 KiB 'A', new = 64 KiB 'B'; WRONG = any read that is neither (mixed/short).
(a) python open(r+b).write(new) (in place, no truncate); (b) write f.tmp then os.rename over f; (c) guest stats g -> ENOENT, host creates g; (d) host unlinks f the guest just read; (e) host renames dir d -> d2 (guest reads d/x and d2/x); (f, added) host rm -rf d; mkdir d; write d/x (dir replaced by a new one of the same name)
- harness bug found in a first run: setup did rmtree(vis)+mkdir(vis)+write vis/f; the guest then got ENOENT opening vis/f although it existed on the Mac -> that's case (f); harness changed to a unique dir per rep and (f) added as its own case.
```
clock offset guest-host 0.0309 s (min rtt 0.065)
case a rep 0: final_at=-0.029 transitions=[('-0.029', 'mt=new size=65536 data=new')] done iters 39214
case a rep 1: final_at=-0.029 transitions=[('-0.029', 'mt=new size=65536 data=new')] done iters 38836
case a rep 2: final_at=-0.029 transitions=[('-0.029', 'mt=old size=65536 data=new'), ('-0.029', 'mt=new size=65536 data=new')] done iters 40730
case a rep 3: final_at=-0.029 transitions=[('-0.030', 'mt=old size=65536 data=new'), ('-0.029', 'mt=new size=65536 data=new')] done iters 40567
case a rep 4: final_at=-0.029 transitions=[('-0.029', 'mt=old size=65536 data=new'), ('-0.029', 'mt=new size=65536 data=new')] done iters 42564
case b rep 0: final_at=4.768 transitions=[('-0.030', 'ERR:ENOENT'), ('4.768', 'mt=new size=65536 data=new')] done iters 105189
case b rep 1: final_at=4.771 transitions=[('-0.030', 'ERR:ENOENT'), ('4.771', 'mt=new size=65536 data=new')] done iters 92042
case b rep 2: final_at=4.768 transitions=[('-0.030', 'ERR:ENOENT'), ('4.768', 'mt=new size=65536 data=new')] done iters 79212
case b rep 3: final_at=4.763 transitions=[('-0.030', 'ERR:ENOENT'), ('4.763', 'mt=new size=65536 data=new')] done iters 86671
case b rep 4: final_at=4.769 transitions=[('-0.030', 'ERR:ENOENT'), ('4.769', 'mt=new size=65536 data=new')] done iters 94414
case c rep 0: final_at=-0.029 transitions=[('-0.030', 'exists size=0 data=new'), ('-0.029', 'exists size=65536 data=new')] done iters 47587
case c rep 1: final_at=-0.030 transitions=[('-0.030', 'exists size=65536 data=new')] done iters 44879
case c rep 2: final_at=-0.029 transitions=[('-0.030', 'exists size=0 data=new'), ('-0.029', 'exists size=65536 data=new')] done iters 45047
case c rep 3: final_at=-0.030 transitions=[('-0.030', 'exists size=65536 data=new')] done iters 44770
case c rep 4: final_at=-0.029 transitions=[('-0.030', 'exists size=0 data=new'), ('-0.029', 'exists size=65536 data=new')] done iters 47550
case d rep 0: final_at=-0.030 transitions=[('-0.030', 'ERR:ENOENT')] done iters 180623
case d rep 1: final_at=-0.030 transitions=[('-0.030', 'exists data=readERR:ENOENT'), ('-0.030', 'ERR:ENOENT')] done iters 176322
case d rep 2: final_at=-0.030 transitions=[('-0.030', 'exists data=readERR:ENOENT'), ('-0.030', 'ERR:ENOENT')] done iters 170327
case d rep 3: final_at=-0.030 transitions=[('-0.030', 'exists data=readERR:ENOENT'), ('-0.030', 'ERR:ENOENT')] done iters 170756
case d rep 4: final_at=-0.030 transitions=[('-0.030', 'exists data=readERR:ENOENT'), ('-0.030', 'ERR:ENOENT')] done iters 170571
case e rep 0: final_at=-0.030 transitions=[('-0.030', 'd/x:old d2/x:old'), ('-0.030', 'd/x:ENOENT d2/x:old')] done iters 39623
case e rep 1: final_at=-0.030 transitions=[('-0.030', 'd/x:old d2/x:old'), ('-0.030', 'd/x:ENOENT d2/x:old')] done iters 38821
case e rep 2: final_at=-0.030 transitions=[('-0.030', 'd/x:old d2/x:old'), ('-0.030', 'd/x:ENOENT d2/x:old')] done iters 39220
case e rep 3: final_at=-0.030 transitions=[('-0.030', 'd/x:old d2/x:old'), ('-0.030', 'd/x:ENOENT d2/x:old')] done iters 37874
case e rep 4: final_at=-0.029 transitions=[('-0.030', 'd/x:old d2/x:old'), ('-0.029', 'd/x:ENOENT d2/x:old')] done iters 32683
case f rep 0: final_at=4.768 transitions=[('-0.030', 'd/x:ENOENT'), ('4.768', 'd/x:new')] done iters 77026
case f rep 1: final_at=4.766 transitions=[('-0.030', 'd/x:ENOENT'), ('4.766', 'd/x:new')] done iters 88228
case f rep 2: final_at=4.769 transitions=[('-0.030', 'd/x:ENOENT'), ('4.769', 'd/x:new')] done iters 83314
case f rep 3: final_at=4.766 transitions=[('-0.030', 'd/x:ENOENT'), ('4.766', 'd/x:new')] done iters 81978
case f rep 4: final_at=4.768 transitions=[('-0.030', 'd/x:ENOENT'), ('4.768', 'd/x:new')] done iters 83032
```
- krunkit summary: (a) in-place immediate (<= clock error); (c) new file immediate (no negative caching); (d) delete immediate; (e) dir rename immediate (old path ENOENT, new path works);
  (b) SAFE WRITE (tmp + rename over): guest gets ENOENT on stat AND open of the path for 4.76-4.77 s in 5/5 reps, then sees new content. Never old content, never wrong data — the error is the failure. Explanation: guest's cached dentry points to the old inode, which libkrun addresses as /.vol/<dev>/<ino>; that inode is gone on the host, so getattr/open return ENOENT until the 5 s entry_timeout expires and the kernel re-looks up the name (window = 5 s minus time since the guest's last lookup).
  (f) Mac rm -rf d + mkdir d + write d/x: same, ENOENT for 4.77 s in 5/5.
  transient 'exists size=0 data=new' in (c) and 'mt=old data=new' in (a) are stat/read races with the host write itself, gone in the next iteration (~0.1 ms), not stale data.

## K3 guest->host (guest python writes/renames/unlinks in share/g2h; Mac python busy-poll + node fs.watch recursive). guest clock ~+0.03 s vs host
```
mac 1795563234.845 w:- w2:-
mac 1795563236.935 w: w2:-
mac 1795563236.935 w:v0 w2:-
mac 1795563237.946 w: w2:-
mac 1795563237.946 w:v1 w2:-
mac 1795563238.951 w: w2:-
mac 1795563238.951 w:v2 w2:-
mac 1795563239.953 w:v2 w2:v2
mac 1795563239.953 w:- w2:v2
mac 1795563240.957 w:- w2:-
fsev 1795563236.946 rename w
fsev 1795563237.957 rename w
fsev 1795563238.963 rename w
fsev 1795563239.965 rename w
fsev 1795563239.965 rename w2
fsev 1795563240.969 rename w2
fsev 1795563241.972 rename sub
fsev 1795563241.972 rename sub/n
```
- Mac sees every guest change within clock error (<~30 ms); FSEvents (node fs.watch) fires ~10 ms after each guest op, including nested mkdir/create. (Transient empty "w:" = guest open(w) truncation, normal.)

## K4 correctness (scripts/m7.sh piped to guest bash in share/m7)
```
OK   symlink-create
OK   symlink-dangling
OK   chmod+x
OK   hardlink
OK   hardlink-write-through
OK   rename-over
OK   unicode-name
OK   unicode-NFD-vs-NFC
OK   ownership
FAIL chown-root: 
OK   flock
OK   flock-basic
OK   fcntl-lock
OK   mmap-read
OK   mmap-write-shared
OK   create-mode-0
OK   open-unlinked
OK   fifo
FAIL case-sensitive: 
OK   xattr
OK   fallocate
OK   utime
OK   mknod-socket
OK   gnu-tar-symlink
--- stat in guest
a 502:1000 664;h1 502:1000 664;x.sh 502:1000 775;m0 502:1000 0;
rootfile 502:1000 644
Mac view: a 502:0 664; h1 502:0 664; x.sh 502:0 775; m0 502:0 0; rootfile 502:0 644; xattr user.t=v visible on Mac
as root in guest: a 0:0; as nobody: 65534:65534; `sudo chown root a` rc=0 but uid stays 502
docker (alpine, -v share:/w): root sees 0:0; uid 1234 sees 1234:1234 and can create files (host writes as Mac user); created file shows 502:1000 to guest user
```
- krunkit default "simplified" permission semantics: stat reports the CALLER's uid:gid for every file; chown silent no-op (FAIL chown-root has empty output = rc 0 but uid not 0). Differs from vz (lab B: chown reports success, shows 0 briefly, reverts).
- case-sensitive FAIL (APFS case-insensitive), same as vz.
- Fixed vs vz: create-mode-0 OK, GNU tar symlink extraction OK (vz failed both).
- fcntl/flock: OK between guest processes only; libkrun does not advertise POSIX_LOCKS/FLOCK_LOCKS (notes-krunkit.md) so locks are guest-kernel-local, not visible to Mac processes (not tested from Mac side).
- git: bundle of pinata (`git bundle create --all`) -> guest `git clone` 2.15 s, `git fsck --full` 0.43 s OK (one dangling commit, also in source), `git gc --aggressive` 6.68 s OK, fsck after gc OK; Mac `git fsck --full` OK, Mac `git status` clean.
- stress 60 s: Mac churn.py + guest churn.py x2 (append to own file + write tmp & rename over r-<who>-<n%50> in tree/_churn) + 4 guest readers (os.walk + lstat + read over tree incl. _churn):
```
churn mac iters 526993 errors {} append lines 526993
churn g2 iters 41509 errors {} append lines 41509
reader r4 passes 2 files 34508 errors {'churn:ENOENT': 106} short 0 samples [('churn:ENOENT', 'tree/_churn/r-mac-5'), ('churn:ENOENT', 'tree/_churn/r-mac-2'), ('churn:ENOENT', 'tree/_churn/r-mac-3'), ('churn:ENOENT', 'tree/_churn/r-mac-4'), ('churn:ENOENT', 'tree/_churn/r-mac-49')]
reader r1 passes 2 files 34508 errors {'churn:ENOENT': 105} short 0 samples [('churn:ENOENT', 'tree/_churn/r-mac-5'), ('churn:ENOENT', 'tree/_churn/r-mac-2'), ('churn:ENOENT', 'tree/_churn/r-mac-3'), ('churn:ENOENT', 'tree/_churn/r-mac-4'), ('churn:ENOENT', 'tree/_churn/r-mac-49')]
reader r3 passes 2 files 34508 errors {'churn:ENOENT': 105} short 0 samples [('churn:ENOENT', 'tree/_churn/r-mac-5'), ('churn:ENOENT', 'tree/_churn/r-mac-2'), ('churn:ENOENT', 'tree/_churn/r-mac-3'), ('churn:ENOENT', 'tree/_churn/r-mac-4'), ('churn:ENOENT', 'tree/_churn/r-mac-49')]
reader r2 passes 2 files 34508 errors {'churn:ENOENT': 105} short 0 samples [('churn:ENOENT', 'tree/_churn/r-mac-5'), ('churn:ENOENT', 'tree/_churn/r-mac-2'), ('churn:ENOENT', 'tree/_churn/r-mac-3'), ('churn:ENOENT', 'tree/_churn/r-mac-4'), ('churn:ENOENT', 'tree/_churn/r-mac-49')]
churn g1 iters 41345 errors {} append lines 41345
```
  krunkit fds mid-run: 135. dmesg 545 lines before and after (no new lines), no hang, no EIO/ESTALE, 0 short reads, appends complete (lines == iterations for all three writers).
  ERRORS: every reader got ENOENT ~105 times, ONLY on r-mac-* (files the MAC renamed over, names that always exist after first creation): same stale-/.vol-path effect as K3(b). Zero errors on r-g1-*/r-g2-* (guest-renamed). On a local fs these reads would all succeed.
- checksum: sha256 of all 19491 files from guest == Mac (`shasum -a 256`) == source node_modules: IDENTICAL.

## K5 lifecycle (krunkit via limactl)
- 1000 x 8 KiB urandom files written in guest without sync, then `limactl stop fdlab-c` immediately (real 0.85 s): Mac has 1000 files, 0 short, sha256 matches the guest's list. (Without writeback cache writes are synchronous to the host, so this was expected.)
- `limactl start` (2nd boot) real 6.11 s; first create+start 30.15 s incl. docker install. stop 0.85 s. No krunkit/fdlab-c process left after stop.
- after restart: share mounted, docker 29.10.1 up via host socket ~/.lima/fdlab-c/sock/docker.sock (DOCKER_HOST); `limactl shell` works (colima ssh not applicable, colima cannot run it)
- docker bind mount of share: OK (sees 1000 dur files, write visible on Mac). Named volume over share subdir (-v share:/w -v fdlabc-vol:/w/tree/nmvol, busybox tar of tree.tar): 1.21 s, 21421 entries; Mac sees nmvol as empty dir; krunkit fds 128 before and after.
- port forward -p 18080:80 -> curl localhost:18080 from Mac: OK ("hello")
- `docker run --platform linux/amd64 alpine uname -m`: "exec format error" — no Rosetta/binfmt in krunkit (vz in colima can enable Rosetta)
- clock: guest uses chrony (NTP to canonical servers, network required). Skew guest-host right after 2nd boot +0.79 s, +0.89 s after a 30 s SIGSTOP of krunkit (no jump from the pause), +0.98 s 60 s later, +0.53 s ~3 min later (chrony slewing back; host vs time.apple.com -0.0008 s). First boot skew was +0.03 s. Guest clock can be ~1 s off for minutes after boot.

## K6 krunkit: node:24 (v24.22.3) container, -v share/npm:/app (pinata package.json + package-lock.json), `npm ci --ignore-scripts --no-audit --no-fund` (fresh container each time = cold npm cache, network)
- run0: OK, 19481 files in node_modules (timing lost: bc missing in image); krunkit fds 123 before and after
- run1: rm -rf node_modules 3.30 s, npm ci 10.27 s rc=0; fds 123
- run2: rm -rf node_modules 4.42 s, npm ci 12.55 s rc=0; fds 123

## vz comparison profile
- `colima start --profile fdlab-c-vz --activate=false --vm-type vz --mount-type virtiofs --cpus 2 --memory 3 --disk 20 --runtime docker --mount $S/share:w` real 19.48 s (first create; colima's cached image). VM process com.apple.Virtualization.VirtualMachine pid 30642 (found by lsof on colima-fdlab-c-vz), hostagent 30636, ssh mux 30648. Guest kernel 6.8.0-117-generic (krunkit guest was 7.0.0-38: different image, a confound). fdlab-a gone and fdlab-d present in colima list at this point (other labs).
- vz baseline 12 fds, RSS 2.2 GB (krunkit 3.8 GB right after boot)
- same bench.sh:
```
== root=$SCRATCH/lab-c/share
  [kern.num_files=27770]
M1 fds baseline (after drop): 12  rss_kb=2198496 vnodes=249863
M2 stat cold: .984049714
M1 fds after stat walk: 21432  rss_kb=2211744 vnodes=249863
  [kern.num_files=49191]
M2 stat warm: .264937243
M1 fds after warm walk: 21432  rss_kb=2211856 vnodes=249863
M3 read cold: 3.756810730
M1 fds after read all: 21432  rss_kb=2221040 vnodes=249863
  [kern.num_files=49201]
M3 read warm: 2.447248066
M1 fds 10s after readers exited (no drop): 21432  rss_kb=2221328 vnodes=249863
M1 fds after drop_caches: 56  rss_kb=2221696 vnodes=249863
  [kern.num_files=27823]
tar: Exiting with failure status due to previous errors
M4 run1 untar+sync: 7.835051067
M1 fds after untar: 21459  rss_kb=2300096 vnodes=249863
  [kern.num_files=49211]
M4 run1 rm: 1.727738251
M1 fds after rm: 19  rss_kb=2300320 vnodes=249863
tar: Exiting with failure status due to previous errors
M4 run2 untar+sync: 5.562630452
M1 fds after untar: 21421  rss_kb=2315200 vnodes=249863
  [kern.num_files=49165]
M4 run2 rm: 1.714387311
M1 fds after rm: 45  rss_kb=2315328 vnodes=249863
M5 git init+add+commit: 19.191115106
M5 files in repo: 10019
M5 git status cold: 1.863531565
M5 git status warm: .386234688
M5 git status warm2: .294487379
M1 fds after git: 22565  rss_kb=2155392 vnodes=249863
  [kern.num_files=50721]
```
- untar on vz: 19 x "tar: tree/.bin/...: Cannot open: Permission denied" each run (as lab B); none on krunkit

## K3 on vz (same vis.py, SH = colima ssh --profile fdlab-c-vz --; min RTT 163 ms => +-80 ms)
```
clock offset guest-host 0.0770 s (min rtt 0.163)
case a rep 0: final_at=-0.078 transitions=[('-0.078', 'mt=new size=65536 data=new')] done iters 89989
case a rep 1: final_at=-0.078 transitions=[('-0.078', 'mt=old size=65536 data=new'), ('-0.078', 'mt=new size=65536 data=new')] done iters 90018
case a rep 2: final_at=-0.078 transitions=[('-0.078', 'mt=old size=65536 data=new'), ('-0.078', 'mt=new size=65536 data=new')] done iters 90552
case a rep 3: final_at=-0.078 transitions=[('-0.078', 'mt=new size=65536 data=new')] done iters 93209
case a rep 4: final_at=-0.078 transitions=[('-0.078', 'mt=old size=65536 data=new'), ('-0.078', 'mt=new size=65536 data=new')] done iters 89992
case b rep 0: final_at=0.720 transitions=[('-0.078', 'ERR:ENOENT'), ('0.720', 'mt=new size=65536 data=new')] done iters 108769
case b rep 1: final_at=0.717 transitions=[('-0.078', 'ERR:ENOENT'), ('0.717', 'mt=new size=65536 data=new')] done iters 122704
case b rep 2: final_at=0.722 transitions=[('-0.078', 'ERR:ENOENT'), ('0.722', 'mt=new size=65536 data=new')] done iters 117162
case b rep 3: final_at=0.721 transitions=[('-0.078', 'ERR:ENOENT'), ('0.721', 'mt=new size=65536 data=new')] done iters 108082
case b rep 4: final_at=0.722 transitions=[('-0.078', 'ERR:ENOENT'), ('0.722', 'mt=new size=65536 data=new')] done iters 110309
case c rep 0: final_at=-0.078 transitions=[('-0.078', 'exists size=65536 data=new')] done iters 101940
case c rep 1: final_at=0.923 transitions=[('-0.078', 'exists size=0 data=WRONG(len=0,A=0,B=0)'), ('0.922', 'exists size=0 data=new'), ('0.923', 'exists size=65536 data=new')] done iters 102453
case c rep 2: final_at=0.923 transitions=[('-0.078', 'exists size=0 data=WRONG(len=0,A=0,B=0)'), ('0.922', 'exists size=0 data=new'), ('0.923', 'exists size=65536 data=new')] done iters 107169
case c rep 3: final_at=0.922 transitions=[('-0.078', 'exists size=0 data=WRONG(len=0,A=0,B=0)'), ('0.922', 'exists size=65536 data=new')] done iters 106114
case c rep 4: final_at=0.922 transitions=[('-0.079', 'exists size=0 data=WRONG(len=0,A=0,B=0)'), ('0.922', 'exists size=0 data=new'), ('0.922', 'exists size=65536 data=new')] done iters 103875
case d rep 0: final_at=0.719 transitions=[('-0.079', 'exists data=readERR:ENOENT'), ('0.719', 'ERR:ENOENT')] done iters 670293
case d rep 1: final_at=0.718 transitions=[('-0.079', 'exists data=readERR:ENOENT'), ('0.718', 'ERR:ENOENT')] done iters 570773
case d rep 2: final_at=0.717 transitions=[('-0.079', 'exists data=readERR:ENOENT'), ('0.717', 'ERR:ENOENT')] done iters 567425
case d rep 3: final_at=0.721 transitions=[('-0.079', 'exists data=readERR:ENOENT'), ('0.721', 'ERR:ENOENT')] done iters 613886
case d rep 4: final_at=0.720 transitions=[('-0.079', 'exists data=readERR:ENOENT'), ('0.720', 'ERR:ENOENT')] done iters 543598
case e rep 0: final_at=-0.079 transitions=[('-0.079', 'd/x:old d2/x:old'), ('-0.079', 'd/x:ENOENT d2/x:old')] done iters 76988
case e rep 1: final_at=-0.079 transitions=[('-0.079', 'd/x:ENOENT d2/x:old')] done iters 80723
case e rep 2: final_at=-0.079 transitions=[('-0.079', 'd/x:old d2/x:old'), ('-0.079', 'd/x:ENOENT d2/x:old')] done iters 77633
case e rep 3: final_at=-0.079 transitions=[('-0.079', 'd/x:old d2/x:old'), ('-0.079', 'd/x:ENOENT d2/x:old')] done iters 78775
case e rep 4: final_at=-0.079 transitions=[('-0.079', 'd/x:old d2/x:old'), ('-0.079', 'd/x:ENOENT d2/x:old')] done iters 87563
case f rep 0: final_at=0.720 transitions=[('-0.079', 'd/x:ENOENT'), ('0.720', 'd/x:new')] done iters 125951
case f rep 1: final_at=0.720 transitions=[('-0.079', 'd/x:ENOENT'), ('0.720', 'd/x:new')] done iters 124667
case f rep 2: final_at=0.718 transitions=[('-0.079', 'd/x:ENOENT'), ('0.718', 'd/x:new')] done iters 103064
case f rep 3: final_at=0.721 transitions=[('-0.079', 'd/x:ENOENT'), ('0.721', 'd/x:new')] done iters 102119
case f rep 4: final_at=0.714 transitions=[('-0.079', 'd/x:ENOENT'), ('0.714', 'd/x:new')] done iters 120490
```
- vz summary: (a) immediate; (b) safe write: ENOENT 0.72 s 5/5; (c) new file: in 4/5 reps guest stat says size 0 and read returns EMPTY (0 bytes) for 0.92 s while the Mac file has 64 KiB — WRONG data (stale cached attrs from the instant of creation), krunkit never showed this; (d) delete: stat still says exists for 0.72 s (open already ENOENT); (e) immediate; (f) ENOENT 0.72 s.

## K6 vz (same docker command, DOCKER_HOST=~/.colima/fdlab-c-vz/docker.sock), VM pid 30642
- before: 121 fds (after the K3 runs)
- run0: npm ci 4.45 s rc=0, 19481 files; VM fds 21527
- run1: rm -rf 1.98 s, npm ci 4.47 s; fds 21554
- run2: rm -rf 1.97 s, npm ci 4.42 s; fds 21517
- vs krunkit npm ci 10.27 / 12.55 s, rm 3.30 / 4.42 s, fds 123. (network included in both; not separated)

## Cleanup
- `limactl delete --force fdlab-c` (Deleted ~/.lima/fdlab-c); `rm -rf ~/.lima` (did not exist before; lima had created _config with its own ssh key)
- `colima delete fdlab-c-vz --force --data` (done); leftover ssh mux pid 30648 for colima-fdlab-c-vz survived the delete -> killed; pgrep krunkit|fdlab-c -> none
- removed ~/Library/Caches/lima/download/by-url-sha256/274d5996... (ubuntu 26.04 image lima downloaded for fdlab-c)
- `brew uninstall krunkit libkrun libkrunfw libepoxy molten-vk`; `brew list --versions` and `brew tap` diff-equal to the snapshot (colima 0.10.3, gh 2.102.0, go 1.27.1, lima 2.3.0, uv 0.12.23; no taps)
- scratch lab-c dir removed; docker contexts: none named fdlab-c
- colima list at end: default Running, pinata Stopped (fdlab-a and fdlab-d, other labs' profiles, were gone by then — not deleted by me)
- kern.num_files at end 6644
