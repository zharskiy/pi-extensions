# Lab J (track T8): a real parallel Maven build on our virtio-fs device against Apple's

[V] measured here, [G] guessed or inferred. Raw files: `prototype/share-kit/baseline-build/`.

## Lab (rebuilt 13:23-13:38 from `notes-custom-device.md`)

- [V] `sh prototype/vzfs/build.sh S/build` (source unchanged, `git status` clean for `prototype/vzfs/` at the end).
- [V] Image: `gunzip -c ~/Library/Caches/colima/caches/b0992ab8...a1c3 > S/vm/disk.raw` (Ubuntu 24.04.4, raw GPT,
  3.5 GiB), `truncate -s 24g`, cloud-init `growpart` grew `/` to 23 G. Seed: `hdiutil makehybrid -iso -joliet
  -default-volume-name cidata -o seed.iso seed/` with `meta-data` and a `user-data` that adds user `lab` (sudo, ssh key).
- [V] Run: `S/build/vzfs run --disk S/vm/disk.raw --seed S/vm/seed.iso --efi S/vm/run/efi.vars --share S/share
  --console S/vm/run/console.log --conf S/vm/run/vzfs.conf --cpus 4 --mem 4096` (watchdog default 100,000), launched
  from a shell with `ulimit -n` 1,048,576 (hard unlimited; `kern.maxfilesperproc` 61,440; `launchctl limit maxfiles`
  256 / unlimited). `main.m` never calls `setrlimit`, so the runner had the soft limit of the launching shell; under
  launchd's default it would be 256 [V for the launchd figure, G that it would matter: the peak below is 269 lsof lines].
- [V] Guest IP from `/var/db/dhcpd_leases` (192.168.64.4). Traps: the image's `/etc/resolv.conf` points at
  systemd-resolved, which is absent: wrote `nameserver 192.168.64.1`; apt needs `Acquire::ForceIPv4=true`; the
  image's docker and containerd were stopped in the guest; an ssh control socket under the scratch path is longer
  than 104 bytes, so plain ssh per command.
- [V] Settings file FINAL: `mode=serial xattr=1 no_flush=1 killpriv=1 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1
  xattr_memo=1`; the log at FUSE_INIT printed exactly these.
- [V] Mounts `mount -t virtiofs vzfs /mnt/vzfs`, `mount -t virtiofs apple /mnt/apple`; check: `find d -printf "%s %m\n"
  | md5sum` over the source copies, 13,728 entries, same sum through both mounts.
- [V] Guest: openjdk 17.0.21.1, Maven 3.8.7 (Ubuntu packages), bpftrace 0.20.2, kernel 6.8.0-117-generic.

## Project

- [V] Wicket 9.25.0: compile error in `wicket-core` (`javax.servlet.http.HttpServletRequest cannot be converted to
  javax.servlet.http.HttpServletRequest`) twice, dropped. Maven 3.9.11 source: builds (1:12 online) but only 3,308
  entries under `target/`, too small.
- [V] Chosen: Apache Dubbo `dubbo-3.2.20` (depth-1 clone from GitHub), 128 reactor modules, 4,395 tracked files.
  One online `package`, one online `clean` (the clean plugin is not resolved by `package`), then offline.
- Build command (the same for every run): `mvn -o -B -T 4 -DskipTests -Dcheckstyle.skip -Drat.skip -Dspotless.skip
  -Dspotless.check.skip -Dmaven.javadoc.skip -Djacoco.skip clean package`; incremental = the same without `clean`.
- [V] One build writes 11,081 entries under `target/` (7,500 files, rest folders), 3,875 MKDIR + 7,713 CREATE through
  FUSE. Fewer than the brief's "tens of thousands"; a bigger project was not tried for time [V for count].
  Offline on the guest's own disk: 56.8 s.
- `~/.m2` (647 MB) on the guest's disk for every run. The `.m2`-on-share variant was NOT run.
- Two copies: `S/share/a/d` (unpacked through `/mnt/vzfs`) used only through `/mnt/vzfs/a/d`; `S/share/b/d` (`cp -Rp`
  on the Mac, `diff -rq` equal) used only through `/mnt/apple/b/d`. One untimed warm-up build each first
  (no lock): ours 85,216 ms, Apple's 68,330 ms, both rc 0.

## Method

`bin/step.sh` (guest): `sync; echo 3 > /proc/sys/vm/drop_caches`, then one timed step (`date +%s%N`), prints
ms, exit status and the count of `[ERROR]`/`Too many open files`/`EMFILE` lines. `bin/hold.sh` (Mac): per round
and share, in order `rm` (find -name target -prune, rm -rf), `build` (clean package from no targets), `incr`
(package, nothing changed), `git` (`git status --porcelain`; `target/` is in Dubbo's `.gitignore`, so outputs are
ignored, not listed); Mac CPU of the runner (`vzfs`) and of the VM process (`com.apple.Virtualization.VirtualMachine`,
pid 27876) from `ps -o time` before/after each step; a 1 s sampler of `lsof -p` line counts of both and
`kern.num_files`.

## Hold 1 (lock 13:40:22-13:55:40): build, incremental, rm, git status, 3 rounds interleaved, FINAL [V]

| measure, ms | ours runs | Apple's runs | median ours / Apple's | ratio |
|---|---|---|---|---|
| clean parallel build | 68,554 69,203 69,274 | 65,290 65,722 65,248 | 69,203 / 65,290 | 1.060 |
| incremental, nothing changed | 62,614 64,680 88,549 | 60,772 60,519 59,632 | 64,680 / 60,519 | 1.069 |
| `rm -rf` of all `target` | 1,821 1,861 1,825 | 1,653 1,522 1,608 | 1,825 / 1,608 | 1.135 |
| `git status` after build | 812 373 306 | 805 796 792 | 373 / 796 | 0.47 |

Every build and step exit status 0, zero error lines, on both shares. Two more ours/Apple's clean builds under
the trace (hold 2): 69,410 / 65,845 (1.054); rm 1,860 / 1,705. The incremental outlier 88,549 (ours, round 3):
Maven's per-module times show the demo modules at 11 s instead of about 6; not explained [V for the times, cause
unknown]. The "incremental" build is not cheap here: Dubbo's `package` re-runs shading and jar steps, so it is
nearly a full build.

Mac CPU per clean build (s): runner `vzfs` 13.50 13.23 13.31 (ours), 0.01 (Apple's); VM process 248.96 251.43
252.04 (ours), 246.32 247.16 244.50 (Apple's). So ours costs about 13 s of extra Mac CPU per 69 s build, about 0.2
core, most of it the 50 us polling [G: 423,048 requests in 13.3 s CPU = 31 us per request, against 2.5-6.6 us of
host work measured earlier].

Descriptors (`lsof -p` lines, which include mapped libraries): runner peak 269 in hold 1 (153 in hold 2), VM process
peak 18,416 (it serves Apple's share; it climbs during Apple's runs). `kern.num_files` peak 27,226 in hold 1 (Apple's
builds), 8,8xx-9,5xx after ours. Guest descriptors open on the share during a build, 1 s sampler (`find /proc/*/fd
-lname /mnt/X/*`): peak 197 on ours, 181 on Apple's. No EMFILE anywhere, so no rerun with `ulimit -n 10240`.

## Hold 2 (lock 13:56:30-14:12:20): request trace, and the polling rule

Trace (`fuseops.bt` of the kit, `btsum.py`), one clean build per share [V]:

| op | ours n | ours avg us | ours sum ms | Apple's n | Apple's avg us | Apple's sum ms |
|---|---|---|---|---|---|---|
| LOOKUP | 86,359 | 76 | 6,619 | 87,708 | 25 | 2,269 |
| WRITE | 84,079 | 61 | 5,134 | 84,151 | 20 | 1,738 |
| READ | 36,981 | 82 | 3,060 | 37,062 | 44 | 1,638 |
| GETXATTR | 61,019 | 45 | 2,757 | 61,019 | 27 | 1,706 |
| RELEASE | 28,491 | 93 | 2,664 | 28,479 | 41 | 1,173 |
| GETATTR | 24,800 | 96 | 2,384 | 25,054 | 23 | 592 |
| OPEN | 20,778 | 92 | 1,914 | 20,766 | 59 | 1,226 |
| READDIRPLUS | 25,460 | 54 | 1,382 | 12,643 | 55 | 697 |
| STATX | 15,837 | 71 | 1,139 | 15,804 | 23 | 378 |
| OPENDIR / RELEASEDIR | 12,902 / 12,902 | 75 / 52 | 977 / 677 | 12,902 / 12,902 | 41 / 16 | 531 / 211 |
| CREATE / MKDIR | 7,713 / 3,875 | 89 / 81 | 689 / 316 | 7,713 / 3,875 | 106 / 100 | 824 / 389 |
| FLUSH | 0 | | | 30,835 | 19 | 587 |
| READDIR | 0 | | | 12,604 | 16 | 205 |
| SETATTR, UNLINK, RMDIR, RENAME | 1,852 | | 141 | 1,852 | | 69 |
| TOTAL | 423,048 | 70.6 | 29,853 | 455,369 | 31.3 | 14,232 |

Most in flight at once: 10 on both. `rm -rf`: 47,581 requests, avg 33.1 us, 1,577 ms summed / 48,280, 28.5 us,
1,374 ms (ours sends READDIRPLUS twice per folder where Apple's sends READDIRPLUS + READDIR; UNLINK 53 vs 33 us).

Reading:
- [V] Ours sends 7 % fewer requests (no FLUSH, READDIRPLUS instead of READDIR) but each one waits 2.3x as long:
  70.6 against 31.3 us, and every opcode is slower except CREATE and MKDIR (where APFS work dominates).
- [V] The rate is about 6,100 requests per second (423,048 in 69 s), a tenth of the 70,000-82,000 per second that
  ours sustains with four callers. So this build is NOT at the request-rate ceiling.
- [G] It is latency-bound in the serial parts: 15.6 s more summed wire time, spread over about four busy build
  threads, is about 4 s of wall time, which is the gap (69.2 against 65.3 s). The 70 us average, twice the 28-37 us
  of a lone caller, says requests also queue behind each other on the one serving queue (up to 10 in flight).
- Polling rule, [V], FINAL otherwise unchanged, remount between, interleaved with Apple's:

| setting | ours clean build ms | Apple's in the same rounds | ratio |
|---|---|---|---|
| FINAL (`spin_us=50 spin_solo=8`) | 68,554 69,203 69,274 69,410 | 65,290 65,722 65,248 65,845 | 1.06 |
| `spin_solo=0` (poll after every request) | 73,965 73,980 | 65,252 65,546 | 1.13; runner CPU 21.3 s |
| `spin_us=0` (no polling) | 81,910 | 70,948 | 1.15; runner CPU 8.3 s |

  Polling helps (without it 15 % slower), polling for everyone hurts (13 %), so the FINAL rule is the best of the
  three and the remaining 6 % is not the polling rule [V for the three; G that no other spin value does better].
- Fixable? [G] Not in a few lines of the server: host work is 2.5-6.6 us of the 70; the rest is the two XPC hops per
  request and waiting in the single device queue. Serving on a pool (`pool-direct`, `pool-hop`) was slower for the
  parallel `ls -lR` in holds 6/7 of the earlier notes and was not tried on the build. What would cut it is sending
  fewer requests: e.g. longer entry/attribute timeouts for LOOKUP/GETATTR/STATX (124,000 of the 423,000 are these),
  which costs coherence (criterion 4). Not tried.

No change to the server: `prototype/vzfs/` is unchanged.

## Hold 3 (lock 14:13:43-14:27:55): the share-kit loads, 5 rounds interleaved, original server, FINAL [V]

`bench.sh --runs 1` per load (macro: untar of the kit's 151,516-entry tarball, `find`, `rm -rf`); `pw2`: eight
parallel `ls -lR` of tree20k, 5 passes, after `echo 2 > drop_caches`.

| load, ms | ours 5 runs | Apple's 5 runs | medians | ratio |
|---|---|---|---|---|
| untar 151k | 43,825 43,643 43,578 43,637 43,585 | 41,832 41,694 41,849 41,815 41,686 | 43,637 / 41,815 | 1.04 |
| find of it | 429 505 522 425 431 | 786 778 823 816 810 | 431 / 810 | 0.53 |
| rm -rf of it | 14,085 13,953 13,941 14,040 14,029 | 13,788 13,914 13,875 13,600 13,712 | 14,029 / 13,788 | 1.02 |
| 8x `ls -lR` tree20k x5 | 13,432 13,517 13,485 13,437 13,488 | 13,508 13,641 13,490 13,531 13,725 | 13,485 / 13,531 | 1.00 |
| stat walk cold (tree64k) | 2,551 2,568 2,567 2,552 2,541 | 2,713 2,833 2,718 2,786 2,923 | 2,552 / 2,786 | 0.92 |
| stat walk warm | 515 513 513 517 517 | 1,502 1,498 1,519 1,494 1,523 | 515 / 1,502 | 0.34 |
| find walk cold / warm | med 346 / 400 | med 1,294 / 1,478 | | 0.27 / 0.27 |
| git status warm (repo40k) | 253 251 190 268 221 | 255 247 296 256 246 | 251 / 255 | 0.98 |

Zero errors in every `ls -lR` run. Peaks over the hold: runner 18 lsof lines, VM process 55,223, `kern.num_files`
64,405 (during Apple's untar; under the watchdog's 100,000).

## Original server, guest cases (no lock) [V]

- `conform.sh`: ours 40 PASS / 6 FAIL, Apple's 39 / 7 (raw `conform-orig-*.txt`).
- 3a, a shell whose working folder `t3a/inner` the Mac moves out of the share (`mv share/f/t3a outside/`):
  ESCAPE on the original server. The shell kept listing and reading, and `echo new > created`, `mkdir newdir`,
  `echo new2 > created2` landed in `outside/t3a/inner/`, outside the share (`find outside` after the test).
  `../../marker` was not readable (the guest resolves `..` from its own dentries). Apple's: every access
  `Operation not permitted`/`Permission denied`, nothing written outside; `touch ../../escaped` lands in the share
  folder the guest still thinks is the grandparent, on both servers.
- 3b, Mac renames a cached folder: new name readable after 0.001 s, no errors, both shares.
- 3c, a guest FIFO, a Mac FIFO, an AF_UNIX socket bound in the guest: same on both.
- 3e, runner RSS (`ps -o rss`): 2,761,552 kB after hold 3 (five untars of 151k entries plus the builds), 2,886,224
  kB after a cold `find` of the 151,516-entry tree; 10 lsof lines at rest. [G: the node table is never trimmed.]

## Hardened server (`prototype/vzfs-hardened/`, read `notes-hardening.md`)

- [V] `sh prototype/vzfs-hardened/build.sh S/hbuild`: built, no error, folder not edited. Same disk, seed, share and
  FINAL settings file (`mode=serial xattr=1 no_flush=1 killpriv=1 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1
  xattr_memo=1`, echoed by the log at FUSE_INIT); the original VM was powered off from the guest first. The runner was
  launched from a shell with `ulimit -n 256` (launchd's default) to exercise its `setrlimit`; no `perror` line in
  its log. VM process pid 80311.

### Hold A (lock 14:34:58-14:48:15): Maven, 3 rounds interleaved, hardened against Apple's [V]

| measure, ms | hardened runs | Apple's runs | medians | ratio | original's ratio (hold 1) |
|---|---|---|---|---|---|
| clean parallel build | 68,555 68,153 68,204 | 67,246 64,695 64,846 | 68,204 / 64,846 | 1.052 | 1.060 |
| incremental, nothing changed | 63,453 63,402 63,358 | 60,411 60,495 60,832 | 63,402 / 60,495 | 1.048 | 1.069 |
| `rm -rf` of all `target` | 1,867 1,641 1,721 | 1,845 1,623 1,634 | 1,721 / 1,634 | 1.053 | 1.135 |
| `git status` after build | 358 348 376 | 784 778 778 | 358 / 778 | 0.46 | 0.47 |

All exit status 0, zero error lines. Mac CPU per clean build (s): runner 12.61 12.90 12.79 (original 13.2-13.5);
VM process 249.5 250.4 250.7 on ours, 245.7 244.5 244.7 on Apple's. The VM process carries the guest's own
CPU (the build), so Apple's server cost is inside its 245 s and not separable; the whole Mac cost is about 263 s on
ours against 245 s on Apple's (+7 %) [V for the sums, G for the reading]. Peaks: runner 232 lsof lines, VM process
18,408, `kern.num_files` 27,640 (Apple's builds; about 9,200 during ours).

### Hold B (lock 14:48:29-15:02:40): trace, coherence, kit loads [V]

Traced clean build on hardened: 68,757 ms, rc 0, 422,934 requests, avg 66.5 us, wire sum 28,105 ms, at most 11 in
flight (original 423,048 / 70.6 us / 29,853 ms; Apple's 455,369 / 31.3 us / 14,232 ms in hold 2). Same opcode mix as
the original (no FLUSH, no READDIR, 25,460 READDIRPLUS). Runner CPU over rm + build 16.7 s. Guest descriptors on the
share peak 215. Raw `hB/htr.*`.

`coherence.py --reps 10` on both shares (`--guest-cmd` = the ssh wrapper): no case failed on either. Worst delays
that differ: Mac deletes a name, guest still sees it: hardened 0.000 s, Apple's 1.001; Mac replaces a file by
rename, guest reads new data: 0.000 / 0.800; Mac creates a missing name, guest reads its data: 0.002 / 0.000. Mac
renames, old name gone in the guest: 1.001 on both. Raw `hB/coh-*.txt`.

### Correctness, hardened [V]

`conform.sh`: hardened 40 PASS / 6 FAIL, exactly the original's lines (only the inode number and the 1 GiB file's
random checksum differ, run-dependent). Against Apple's (39 / 7): `create-mode-0` PASS on ours, FAIL on Apple's
(EACCES); `name-invalid-utf8-ff` fails on both, EILSEQ on ours, EPERM on Apple's. Shared FAILs: chown, chmod-setuid,
perm-enforced-write-0755-other, name-nfd-distinct-from-nfc, name-case-sensitive (APFS and running as the Mac user).

### Guest cases [V]

- 3a, cwd folder moved out by the Mac: on hardened every access fails with `Stale file handle` (ls, cat, create,
  mkdir, `../../marker`, touch `../../escaped`); `find outside/` shows only `marker` and the moved `file`, nothing
  created; nothing new in the share either. After `mv` back, the same shell lists, reads and writes `back` again.
  The original server let the shell write into the moved-out folder (above); Apple's fails with EPERM/EACCES but
  lets `touch ../../escaped` create a file in the share folder.
- 3b: new name readable after 0.001 s, no errors, old name gone (same as Apple's, 0.0 s).
- 3c: guest FIFO, Mac FIFO through the share, AF_UNIX socket: same as Apple's.
- 3d: `open5000.py` (raises its own rlimit to 5,100) on hardened: 4,096 opened, the 4,097th ENFILE (`Too many open
  files in system`), 50 more tries all ENFILE, after closing 100 of 100 reopen. Runner peak 4,106 lsof lines (so
  above the 256 it was launched with: `setrlimit` worked; the value 8,192 is read from `main.m`, not measured: macOS
  has no way to read another process's rlimit without a debugger). `kern.num_files` 9,189 before, 9,179 after; guest
  uptime and ssh fine. Finding: the 50 refused creates still left their files: `t3d` held 4,146 names, so a refused
  CREATE has already made the file on the Mac [V for the count, G for the reason].
- 3e: RSS of the runner includes the guest memory it maps (`footprint`: phys_footprint 9.9 MB, peak 26 MB, against
  RSS 2.47 GB after the builds), so the RSS figures of the original (2.76 GB / 2.89 GB) are not a leak measure.
  Hardened after the builds: 10 lsof lines, footprint 9,875 kB.

### Kit loads, hardened against Apple's: hold B (3 rounds, all loads) + hold C (lock 15:02:57-15:06:16, 2 more rounds of the loads under a minute) [V]

| load, ms | hardened runs | Apple's runs | medians | ratio | original's ratio (hold 3) |
|---|---|---|---|---|---|
| untar 151k | 40,150 34,271 35,274 | 42,007 41,966 41,750 | 35,274 / 41,966 | 0.84 | 1.04 |
| find of it | 504 517 548 | 812 848 890 | 517 / 848 | 0.61 | 0.53 |
| rm -rf of it | 13,804 13,678 13,485 | 13,981 14,394 14,386 | 13,678 / 14,386 | 0.95 | 1.02 |
| 8x `ls -lR` tree20k x5 | 13,320 13,120 13,171 13,072 12,999 | 13,574 13,513 13,531 13,504 13,581 | 13,120 / 13,531 | 0.97 | 1.00 |
| stat walk cold | 2,984 2,611 2,597 2,566 2,500 | 2,802 2,749 2,792 2,780 2,719 | 2,597 / 2,780 | 0.93 | 0.92 |
| stat walk warm | 524 521 526 535 547 | 1,510 1,495 1,495 1,543 1,541 | 526 / 1,510 | 0.35 | 0.34 |
| find walk cold / warm | med 445 / 409 | med 1,386 / 1,497 | | 0.32 / 0.27 | 0.27 / 0.27 |
| git status warm | 253 258 259 244 197 | 250 258 295 256 297 | 253 / 258 | 0.98 | 0.98 |
| walkers (`--walk-secs 20`), passes | 451 464 460 465 452 | 28 29 28 35 29 | 460 / 29 | 15.9x | not run |
| walkers, EMFILE lines | 0 0 0 0 0 | 592 455 321 579 530 | | | |
| walkers, probe max ms | 0.6-0.9 | 4,557-4,778 | | | |

The hardened untar is faster than the original's in hold 3 (35-40 s against 43.6 s) in a different boot; not
explained, and the first hardened run (40.2 s) is close to the original [V for times, cause unknown].

Mac CPU per macro round (untar + find + rm, s): hardened runner 61.1 56.4 57.4 + VM process 38.0 32.7 33.8 (about
90 s); Apple's VM process 63.1 63.5 63.4. Per walkers run: runner 19 s + VM 28.7 s against VM 27 s. Peaks over hold
B: runner 24 lsof lines, VM process 58,360, `kern.num_files` 64,832 (Apple's untar).

3e, after the three untars and finds of the 151k tree and the walkers: runner 10 lsof lines, phys_footprint 50 MB
(peak 132 MB), RSS 2.73 GB (mapped guest memory, see above). The original's footprint was not taken before its VM
stopped, so only lsof (10 against 10) compares [V].

## Cleanup (15:07) [V]

Guest powered off (no `vzfs` process, only colima default's VM process left); `t8` emptied (0 entries; disk, image
copy, builds of both servers and the share removed); lock released after each hold (no `exclusive.lock`); no crash
report from `vzfs` or the VM process (the two at 14:10 are `timeout`/`fuzz`, not this track's); `docker context show`
= colima; `colima list` default Running, pinata Stopped; no `~/.lima`; `kern.num_files` 9,322. `prototype/vzfs/`
unchanged; `prototype/vzfs-hardened/` not edited (newest file 14:10:51, built at 14:32). Raw files, the drivers
(`scripts/`) and the running notes: `prototype/share-kit/baseline-build/` (1.8 MB, scratch path written as `S`).
Not done: `.m2` on the share; a second hardened trace; the original's `footprint`.
