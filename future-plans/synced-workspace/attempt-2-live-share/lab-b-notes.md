# Lab B notes (transport comparison)
- baseline kern.num_files=6605, maxfiles 122880; colima 0.10.3
- colima start --help: --mount-type (sshfs, 9p, virtiofs) default virtiofs; 9p is not supported with vz (lima: 9p is qemu-only) -- not forced
- pinata CREATE_FLAGS: --vm-type vz --mount-type virtiofs, runtime docker default
- tree: copy of node_modules: 19491 files, 1910 dirs, 19 symlinks, 304M; tarball 278MB (share/tree.tar)

## C1 virtiofs (fdlab-b VM pid 3349, identified by lsof showing _lima/colima-fdlab-b; fdlab-a is pid 3155, default 39113)
cmd: colima start --profile fdlab-b --activate=false --vm-type vz --mount-type virtiofs --cpus 2 --memory 3 --disk 20 --runtime docker --mount $S/share:w
fd count via libproc proc_pidinfo(PROC_PIDLISTFDS) (scripts/fdcount.py); kern.num_files fluctuates with lab A, not used for per-process figures
```
== C1-virtiofs root=$SCRATCH/lab-b/share
  [kern.num_files=27717]
M1 fds baseline (after drop): 12
M2 stat cold: 0.990
M1 fds after stat walk: 21432
  [kern.num_files=49131]
M2 stat warm: 0.223
M1 fds after warm walk: 21432
M3 read cold: 3.363
M1 fds after read all: 21475
  [kern.num_files=28176]
M3 read warm: 2.173
M1 fds 10s after readers exited (no drop): 21475
M1 fds after drop_caches: 35
  [kern.num_files=6762]
tar: Exiting with failure status due to previous errors
5.618
M1 fds after untar: 21438
  [kern.num_files=28168]
M4 run1 rm: 1.585
M1 fds after rm: 62
tar: Exiting with failure status due to previous errors
5.614
M1 fds after untar: 21464
  [kern.num_files=28207]
M4 run2 rm: 1.772
M1 fds after rm: 24
M5 git init+add+commit: 8.870
M5 files in repo: 10000
M5 git status cold: 1.851
M5 git status warm: 0.208
M5 git status warm2: 0.126
M1 fds after git: 20892
  [kern.num_files=48635]
clock: host 1795561719.573..1795561719.738 guest=1795561719.725872483
trial1 in-place host write at 1795561723.819
ready
content_seen=1795561723.829 mtime_seen=1795561723.829
trial1 rename host write at 1795561727.919
ready
content_seen=1795561728.052 mtime_seen=1795561728.052
trial2 in-place host write at 1795561732.149
ready
content_seen=1795561732.159 mtime_seen=1795561732.159
trial2 rename host write at 1795561736.216
ready
content_seen=1795561736.392 mtime_seen=1795561736.392
time="2026-11-25T01:09:04+02:00" level=fatal msg="exit status 124"
guest inotify on host edits:
Setting up watches.
Watches established.
guest_wrote=1795561745.830160355
host_saw=1795561745.844
host mtime after guest touch -d 2001: Jan  1 00:00:00 2001
OK   symlink-create
OK   symlink-dangling
OK   chmod+x
OK   hardlink
OK   hardlink-write-through
OK   rename-over
OK   unicode-name
OK   unicode-NFD-vs-NFC
OK   ownership
OK   chown-root
OK   flock
OK   flock-basic
OK   mmap-read
OK   mmap-write-shared
FAIL create-mode-0: Traceback (most recent call last):   File "<string>", line 1, in <module> PermissionError: [Errno 13] Permission denied: 'm0' 
OK   open-unlinked
OK   fifo
FAIL case-sensitive: 
OK   xattr
OK   fallocate
OK   utime
```
- untar on virtiofs: GNU tar fails all 19 symlinks 'Cannot open: Permission denied' (tar creates mode-0 placeholder; virtiofs host side runs as user, cannot open a 0000 file) -- reproduced by M7 create-mode-0
- chown root reports success, stat shows 0 briefly, reverts to 502 (not persisted); sudo-created file shows 0:0 in guest, 502:0 on Mac
- case-insensitive + normalization-insensitive (APFS): Case/case collide, cafe+U+0301 finds café
- volume over share (alpine busybox tar, docker -v share:/w -v fdlabb-nm:/w/nmvol): untar 0.51/0.51s, rm 0.11/0.11s; host fds 36->38 across 2x untar of 19491 files (+2 = tarball read); Mac sees nmvol as empty dir (find count 1)

## C3 guest-local ext4 (/var/tmp/lab in the C1 VM; fds column = virtiofs VM pid 3349, flat)
```
== C3-guest-ext4 root=/var/tmp/lab
  [kern.num_files=6746]
M1 fds baseline (after drop): 38
M2 stat cold: 0.170
M1 fds after stat walk: 38
  [kern.num_files=6744]
M2 stat warm: 0.137
M1 fds after warm walk: 38
M3 read cold: 0.584
M1 fds after read all: 38
  [kern.num_files=6744]
M3 read warm: 0.105
M1 fds 10s after readers exited (no drop): 38
M1 fds after drop_caches: 38
  [kern.num_files=57406]
M4 run1 untar: 0.161
M1 fds after untar: 38
  [kern.num_files=57406]
M4 run1 rm: 0.088
M1 fds after rm: 38
M4 run2 untar: 0.128
M1 fds after untar: 38
  [kern.num_files=57409]
M4 run2 rm: 0.090
M1 fds after rm: 38
M5 git init+add+commit: 1.675
M5 files in repo: 10000
M5 git status cold: 0.024
M5 git status warm: 0.013
M5 git status warm2: 0.011
M1 fds after git: 38
  [kern.num_files=57410]
OK   symlink-create
OK   symlink-dangling
OK   chmod+x
OK   hardlink
OK   hardlink-write-through
OK   rename-over
OK   unicode-name
OK   unicode-NFD-vs-NFC
OK   ownership
OK   chown-root
OK   flock
OK   flock-basic
OK   mmap-read
OK   mmap-write-shared
OK   create-mode-0
OK   open-unlinked
OK   fifo
OK   case-sensitive
OK   xattr
OK   fallocate
FAIL utime: touch: setting times of 'a': Operation not permitted 
```
- utime FAIL on ext4 is a test-order artifact: preceding chown-root really made 'a' root-owned on ext4, so the user's touch -d is EPERM. GNU tar untar of 19 symlinks works on ext4.

## C2 sshfs (recreated profile, --mount-type sshfs). Serving: /usr/libexec/sftp-server pid 10833 (child of limactl hostagent 10333) + ssh 10832; VM 10347
guest mount: fuse.sshfs rw,nosuid,nodev,relatime,user_id=502,group_id=1000,allow_other
```
== C2-sshfs root=$SCRATCH/lab-b/share
  [kern.num_files=6743]
M1 fds baseline (after drop): 38 ( 10833:7 10832:7 10333:14 10347:10 )
M2 stat cold: 0.995
M1 fds after stat walk: 38 ( 10833:7 10832:7 10333:14 10347:10 )
  [kern.num_files=6742]
M2 stat warm: 0.270
M1 fds after warm walk: 38 ( 10833:7 10832:7 10333:14 10347:10 )
M3 read cold: 8.633
M1 fds after read all: 38 ( 10833:7 10832:7 10333:14 10347:10 )
  [kern.num_files=6749]
M3 read warm: 8.335
M1 fds 10s after readers exited (no drop): 38 ( 10833:7 10832:7 10333:14 10347:10 )
M1 fds after drop_caches: 38 ( 10833:7 10832:7 10333:14 10347:10 )
  [kern.num_files=14471]
M4 run1 untar: 17.397
M1 fds after untar: 38 ( 10833:7 10832:7 10333:14 10347:10 )
  [kern.num_files=27752]
M4 run1 rm: 4.143
M1 fds after rm: 38 ( 10833:7 10832:7 10333:14 10347:10 )
M4 run2 untar: 17.880
M1 fds after untar: 38 ( 10833:7 10832:7 10333:14 10347:10 )
  [kern.num_files=41835]
M4 run2 rm: 4.651
M1 fds after rm: 38 ( 10833:7 10832:7 10333:14 10347:10 )
M5 git init+add+commit: 23.422
M5 files in repo: 10000
M5 git status cold: 5.064
M5 git status warm: 0.171
M5 git status warm2: 0.133
M1 fds after git: 40 ( 10833:9 10832:7 10333:14 10347:10 )
  [kern.num_files=6746]
clock: host 1795562035.757..1795562036.028 guest=1795562036.012082309
trial1 in-place host write at 1795562040.050
ready
content_seen=1795562040.057 mtime_seen=1795562040.057
trial1 rename host write at 1795562044.089
ready
content_seen=1795562044.103 mtime_seen=1795562044.103
trial2 in-place host write at 1795562048.134
ready
content_seen=1795562048.142 mtime_seen=1795562048.142
trial2 rename host write at 1795562052.194
ready
content_seen=1795562052.201 mtime_seen=1795562052.201
time="2026-11-25T01:14:12+02:00" level=fatal msg="exit status 127"
guest inotify on host edits:
timeout: failed to run command ‘inotifywait’: No such file or directory
guest_wrote=1795562056.468935788
host_saw=1795562056.483
host mtime after guest touch -d 2001: Jan  1 00:00:00 2001
OK   symlink-create
OK   symlink-dangling
OK   chmod+x
FAIL hardlink: 
OK   hardlink-write-through
OK   rename-over
OK   unicode-name
OK   unicode-NFD-vs-NFC
OK   ownership
FAIL chown-root: chown: changing ownership of 'a': Permission denied 
OK   flock
OK   flock-basic
OK   mmap-read
OK   mmap-write-shared
OK   create-mode-0
OK   open-unlinked
FAIL fifo: mkfifo: cannot create fifo 'ff': Operation not permitted 
FAIL case-sensitive: 
FAIL xattr: Traceback (most recent call last):   File "<string>", line 1, in <module> OSError: [Errno 95] Operation not supported: 'a' 
FAIL fallocate: fallocate: fallocate failed: Operation not supported 
OK   utime
inotify retry (after apt-get update):
Setting up watches.
Watches established.
open-hold test: guest holds 2000 files open -> sftp-server fds 2007; after close 7
```
- hardlink FAIL: link created (Mac nlink 2, write-through ok), but guest sees nlink 1 / different inode (no use_ino)
- chown root EPERM; sudo-created file owned 502:0; gid shown as 0 (Mac wheel) not guest gid 1000
- mkfifo EPERM, xattr ENOTSUP, fallocate ENOTSUP; case-insensitive (APFS)
- GNU tar untar of symlinks OK, create-mode-0 OK

## --mount-inotify (sshfs VM restarted with it): colima daemon pid 17401 (--inotify --inotify-runtime docker). inotifywait in guest shell: no events in 8s. inotifywait -r inside alpine container bind-mounting the share: no events within 6s after host append+touch. daemon fds 8 constant, hostagent 15/14. Not investigated further (daemon log shows only 'VM started').

## Cleanup
- colima delete fdlab-b --force --data: "deleting container data ... done"
- stray processes left after delete (lima sshfs reverse mount survived the stop/start + delete): ssh mux 17557, ssh 17703 (runs `sshfs ... -o slave`), sftp-server 17704 -> killed with kill; pgrep "fdlab-b|sftp-server" then empty
- scratch dir removed; ~/.colima and ~/.colima/_lima have no fdlab-b; docker context colima-fdlab-b gone
- colima list: default Running, fdlab-a Running (lab A), pinata Stopped
- kern.num_files 58634 at end: VM pid 8308 (lab A's fdlab-a, recreated) holds 51963 fds; default VM 39113 holds 12. Nothing of mine.
