# Bounding the Mac's open files for the workspace share: result of phase 2

Evidence marks, as in the notes: "measured" ([V]), "tested with N cases", "read in source" ([S]) and "guessed" ([G]).
File names are relative to this folder. Ratios are ours divided by Apple's share, so below 1 is faster.
Where three labs measured the same thing, the latest wins: Lab L (`lab-l-polling-notes.md`) over Lab K (`lab-k-build-gap-notes.md`) over Lab J (`lab-j-build-notes.md`). Lab N (`lab-n-parallel-create-notes.md`) adds parallel loads to the same configuration. Lab M (`lab-m-multiqueue-notes.md`) measured a second configuration on a newer kernel; its figures are kept apart.

Terms used throughout:
- Descriptor: an open-file entry in a Mac process. Counted two ways: the number of lines `lsof -p <pid>` prints for a process (this includes mapped libraries, so it overstates open files a little), and `kern.num_files`, the Mac-wide count whose limit `kern.maxfiles` is 122,880 on this Mac.
- Our server, or ours: the hardened file server in `prototype/vzfs-hardened/`. Apple's share: the virtio-fs server built into Apple's Virtualization framework, which colima uses today.
- Eight walkers: the hardest load we have. Eight parallel `ls -R` loops over trees of 20k to 64k files, a `git status` loop, for 20 s.
- Probe: the test kit's one-file latency check during the walker load. Every 50 ms it runs `stat --cached=never` on one file and logs how long it took. The longest probe is the worst stall a program in the guest saw.

## Answer

No option meets all eight criteria.

The one that comes closest is our own virtio-fs device: the hardened server, a file server in C that macOS 27's custom virtio device API attaches to the VM. The guest keeps a stock Ubuntu kernel and mounts the share as ordinary virtiofs. On the Mac the server addresses files by path from one root descriptor, so it holds no descriptor per cached file.

What it buys, measured. The Mac no longer runs out of descriptors: with 151,516 entries cached in the guest, our process stayed at 10 lsof lines and `kern.num_files` at 9,797, against 53,631 lines and 63,391 on Apple's share (Lab K, 1 walk each). The guest sees no "Too many open files" under eight walkers: 0 error lines in 11 runs and a longest probe of 8.5 ms, against 28 to 592 error lines and probes of 3.0 to 4.8 s (Labs J, K, L). Mac deletes reach the guest at once (0.000 s against 1.005 s).

It has two configurations, and each misses criterion 3 (speed) on some loads:
- (a) Stock kernel 6.8, as today, with one request queue. Slower than Apple's share by 2 % on the parallel Maven build and the rebuild (Lab L, 5 rounds), 5 to 7 % on one untar of 151k files (Labs L and N; 21 % when tar runs on the guest CPU that takes the interrupts), 16 % on two untars at once and 2 % on four at once (Lab N, 3 runs each), and 1 to 9 % on removing build outputs and the two untarred trees (removing four at once was 10 % faster). Equal or faster on every other load measured.
- (b) Stock kernel 7.0 with four request queues, against Apple's share on 7.0 (Lab M). One untar 19 % faster, `find` 9 times faster, build and rebuild within 1.1 % (5 rounds). But eight parallel `ls -lR` 29 % slower (2 runs) and four untars at once 20 % slower (2 runs against 1). And 7.0 makes Apple's own share 6.5 % slower on the build than 6.8, so against today's setup (b) builds about 7 % slower.

Recommendation: build configuration (a) first and keep the queue count as a switch. Its misses are smaller and it keeps today's kernel. The two regressions of (b) are unexplained, and 7.0 is slower by itself.

What cannot be removed from outside Apple: each small request costs 6 to 11 µs more through the custom-device API than through Apple's built-in device (Lab L, 1 traced untar; 6 to 12 µs in Lab M). The cause is guessed: two process hops per request. See "What only Apple can fix".

The other criteria not met:
- Criterion 4: IDEA itself was not run. The Mac's file events for guest writes were checked and arrive.
- Criterion 7: it rests on tests (277 cases, 26M fuzzed requests), not on proof. Four known windows remain, and a C server of ours now sits on the trust boundary.
- Criterion 8: the host side is not built. It needs our own lima driver in place of colima (guessed at 4 to 7 weeks) and macOS 27.

Docker question. Replacing colima with Docker Desktop fails criterion 7 in every mode: one shared VM per user that shares `/Users` and more by default, with no way for pinata to pin the VM type, file sharing, kernel or trust store. With Apple's framework it runs the same Apple server (48,242 Mac descriptors after a walk of 67k files). Its other two file servers bound the descriptors but cost speed (gRPC FUSE: untar 5 times longer) or correctness (Docker VMM, in Beta: two processes appending to one file lose about 2 % of lines). Details under "Options compared" (`lab-i-docker-notes.md`). Docker Engine inside colima is what pinata runs today, so swapping the docker CLI changes nothing: the share is a property of the VM, not of docker.

## The eight criteria

Quoted from `track.md`:

1. Host descriptors held for the share do not grow with the number of files the guest has cached, for any number of VMs.
2. No guest-visible errors or stalls under the hardest load we have (eight parallel walkers).
3. Not slower than today's Apple virtiofs on the measured workloads.
4. Mac edits reach the sandbox and sandbox edits reach the Mac at least as promptly as today; file watching in IDEA keeps working.
5. The same files, the whole workspaceRoot, no copies.
6. No change to macOS limits that other programs live under.
7. The sandbox boundary is not weakened.
8. Operable: no custom guest kernel, components that can be installed and kept up to date.

Strict reading: a load slower than Apple's is "not met" for that load, and anything not measured is "not shown", even where the source says it should hold.

## Options compared

The phase-1 option: raise `kern.maxfiles`, plus a "governor", a guest script that empties the guest's cache of the share whenever the number of cached entries passes a set number, the budget (50,000) (`proposal.md`).

| Option | 1 descriptors | 2 no errors | 3 speed | 4 coherence | 5 same files | 6 no limit change | 7 boundary | 8 operable |
|---|---|---|---|---|---|---|---|---|
| Apple's virtiofs today | not met: +50,895 at 130k | not met: 28 to 592 EMFILE, 3.0 to 4.8 s | met: baseline | met: baseline | met | met | met: baseline | met: stock colima |
| Phase-1 limits plus governor | not met: grows to the budget | not met: 0.27 s freezes | not met: cold walk 2.3 to 2.8× | met: Apple's server | met | not met: raises `kern.maxfiles` | met: unchanged | met: script, LaunchDaemon |
| Hidden Apple setting | not met: none exists | not met: as today | met: as today | met: as today | met | not met: only via sysctl | met | met |
| Kernel NFS | not shown: met on paper [S] | not shown: not run | not shown: not run | not shown: not run | not shown: met on paper [S] | not shown: met on paper [S] | not met [S, G]: forgeable handles | not met: root, manual access |
| krunkit | not met: 320 to 16,404 | not met: FIFO unlink hangs | not met: 2.3 to 5.4× | not met: 4.77 s missing | met | met | not shown: not studied | not shown: lima only¹ |
| Docker Desktop, Apple's framework | not met: 48,242 open | met: 3 runs, no errors | not shown: other harness² | met: Apple's server | met | met | not met: shares `/Users` | not met: paid, unpinnable |
| Docker Desktop gRPC FUSE | met: flat 147 to 154 | met: 3 runs, probe ≤ 16 ms | not met: untar 5× | not shown: not tested | met | met | not met: shares `/Users` | not met: paid, unpinnable |
| Docker VMM | met: ceiling about 8,300 | met: 3 runs, probe ≤ 45 ms | not shown: other harness, no build³ | met: 12 ms worst⁴ | met | met | not met: shares `/Users` | not met: Beta, unpinnable |
| Our own virtio-fs device | met: 10 with 151k cached | met: 11 runs, 0 errors | not met: (a) build 1.020, two untars 1.156; (b) eight `ls -lR` 1.29, four untars 1.20 | partly: IDEA not run | met | met | tested, not proven | not met: driver not built |

¹ lima started krunkit (`lab-c-notes.md`); colima cannot start it with virtiofs. The chosen design drops colima too, so that alone is no reason.
² Untar took 46.6 s against 41.3 to 41.4 s for Apple's share under colima, but in a different script and guest, which `lab-i-docker-notes.md` judges comparable within 10 to 20 %.
³ Docker's linuxkit kernel 7.0.14, not interleaved with Apple's share in the same VM: cold `stat` walk 0.6 s against about 2.7 s, untar 14.7 s against about 42 s. No Maven build was run there.
⁴ Its timeouts are 3,600 s, with invalidations pushed from the Mac. A missed event would leave the guest stale for up to an hour. That was not tested.

Why each other option is out:

- **Apple's virtiofs today.** It keeps one Mac descriptor per cached guest inode and purges only at 55,296 (`notes-vz-internals.md`, read in source).
  - +50,895 descriptors with 130,257 files cached (`notes-custom-device.md`, measured); 38 to 53,631 with 151,516 (Lab K).
  - Two VMs filled the Mac table to 121,549 of 122,880 (`track.md`, measured).
  - Eight walkers: 321 to 592 error lines per run and probes of 4.6 to 4.8 s (Lab J, 5 runs); 31 to 268 lines and 3.0 to 4.6 s (Lab L, 3 runs).
- **Phase-1 limits plus governor** (`proposal.md`). It raises `kern.maxfiles`, which fails criterion 6 by design.
  - Under eight walkers it froze the containers 25 to 26 times in 30 s, 260 to 290 ms each.
  - A set above the budget is walked cold every time: 2.3 to 2.8 times as long as a warm walk.
  - `git status` above the budget took 4.8 to 5.4 s with the proposed governor against 0.24 to 0.28 s (Lab F, measured at a budget of 30,000 only; 4.1 to 7.9 s in Labs D and E, with an earlier governor without the freeze).
- **Hidden Apple setting.** None exists. The purge point is `kern.maxfilesperproc × 9/10`, read once through `sysctlbyname`. The only override is a test hook in the process that nothing writes. No environment variable, preference or boot argument is read (`notes-vz-internals.md`, read in source).
- **Kernel NFS** (Network File System, the Mac's built-in server; `notes-nfs.md`).
  - The Mac resolves a file handle against the whole volume, with no check that the file lies under the export (read in source). Whether a guest with root can forge a valid handle depends on the APFS file id layout, which is closed source (guessed; `forge-probe.py` would settle it and was not run).
  - A rescue exists on paper: export only the root of a volume that holds nothing but the share, so a forged handle reaches only the share (read in source, plus guess).
  - Under lima's user-mode network the guest arrives as 127.0.0.1, so the export is open to every local user and every user-mode VM (read in source). vzNAT would give the guest its own address to export to (guessed).
  - It needs root setup and Full Disk Access granted by hand. Speed and coherence were not measured; the scripts in `prototype/nfs-lab/` were not run.
- **krunkit** (a VM program built on libkrun). Lab H, krunkit 1.3.2 and libkrun 1.19.8, measured:
  - Its descriptors grew from 320 to 16,404 during a git commit, because it holds one per unlinked file until the guest forgets it.
  - 2.3 times slower on a git commit, 2.8 on cold reads, 5.4 on a warm `stat` walk. Cause: an attribute timeout of 0. A git commit sent 1,950,484 requests against 634,143, of them 1,382,657 GETATTR against 62,003.
  - The timeout of 0 comes from its default "simplified" permission mode. The "complete" mode has 5 s attribute timeouts, but stores owner and mode in an extended attribute and creates Mac files as 0600 (`notes-krunkit.md`, read in source, not measured). On paper that fails criteria 4 and 5.
  - Unlinking a FIFO hangs the share. A Mac rename-replace reads as missing for 4.77 s against 0.72 s (Lab C).
- **Docker Desktop**, all three modes (`lab-i-docker-notes.md`). It changes the file server only if Docker VMM is picked, and every mode fails the boundary:
  - One Docker Desktop VM per user, and one engine, carries all of the user's containers. pinata's sandbox would sit next to every other container of the user, and a privileged container of the user would see it.
  - That VM shares `/Users`, `/Volumes`, `/private`, `/tmp` and `/var/folders` by default, so root in it reaches `~/.ssh` and `~/.pi/agent`. The `filesharingDirectories` key could narrow the list, but it is user-global, it would break the user's other Docker work, and it was not tested.
  - pinata can pin neither the VM type, the file sharing, the kernel (linuxkit 7.0.14) nor the trust store. The CA install into the VM has no supported path (only a privileged container).
  - The licence is paid for companies with 250 or more employees or $10M revenue.
  - With Apple's framework it runs the same Apple server: 48,242 Mac descriptors after a walk of 67k files. Under Docker's 7.0.14 kernel, Apple's server gave no errors and no stalls under the walkers (3 runs, probes up to 91 ms). Under Ubuntu's 7.0.0-44 it did (Lab M, 2 runs), so the kernel version alone does not explain it. The cause was not studied.
  - gRPC FUSE (Filesystem in Userspace over gRPC, a remote call protocol) keeps descriptors flat at 147 to 154, but untar takes 204 s, 5 times longer.
  - Docker VMM (Docker's own VM program and file server, in Beta) keeps at most about 8,300 descriptors and was faster in another harness. Its guest kernel receives invalidations pushed from the Mac. But two processes appending to one file lose about 2 % of lines (3,910 to 3,934 of 4,000 in 4 runs), a correctness failure outside the eight criteria.

## The chosen design

The device. macOS 27 adds `VZCustomVirtioDeviceConfiguration`. A program gives it a virtio device id and queue sizes. When the guest signals that a queue holds new requests (a "kick"), the framework calls the program back through `VZCustomVirtioDeviceDelegateProvider`. The program takes requests with `nextElement` and answers with `returnToQueue`, which is also the only signal to the guest: the API has no interrupt call. It needs only the `com.apple.security.virtualization` entitlement with ad-hoc signing (`notes-vz-custom-api.md`, measured).

The guest. We announce device id 26, virtio-fs. The stock Ubuntu 24.04 kernel 6.8.0-117 binds its ordinary `virtiofs` driver and mounts the share by tag. No guest change is needed (measured).

Where the server runs. The callback runs in the process that owns the `VZVirtualMachine`. Under lima that is the driver process the host agent starts. So our server runs in lima's driver process, unsandboxed, where Apple's runs inside Apple's own VM service (`notes-shipping.md`, read in source). Because the process is ours, it could be sandboxed to the share root; Apple's server cannot be (`notes-custom-device.md`, guessed, not tried).

Addressing without descriptors. A node's identity is (device, inode, type) and its place is (parent node, name). Each request rebuilds the path from the root and calls the `*at` form of the system call on the one root descriptor. The server holds no directory descriptor between requests. If the Mac renames something, the server finds the node again with `fsgetpath` and accepts the answer only if it starts with the root's path from `F_GETPATH`. Apple's `/.vol` paths and `openbyid_np` are not used.

Confinement. Every lookup uses `AT_RESOLVE_BENEATH` and `AT_SYMLINK_NOFOLLOW_ANY` (or the `O_`, `RENAME_` and `XATTR_` forms of these flags). So no path can leave the root and no symbolic link is followed on the Mac. Extended-attribute calls run with the thread's working directory set to the root descriptor (`pthread_fchdir_np`). Calls that make a new entry (`mkdirat`, `symlinkat`, `mkfifoat`, bind, CREATE) run on a fresh `O_SEARCH` open of the parent beneath the root, after checking its identity and that the name is one valid component. READLINK opens the link beneath the root with `O_SYMLINK` and reads it with `freadlink`. Set-id bits are neither shown nor taken (`setid=0`). These flags cost 613 to 850 ns per GETATTR against 1,043 to 1,326 ns before (`notes-hardening.md`, measured).

The handle cap. The server raises its own descriptor limit to 8,192 with `setrlimit` and allows at most 4,096 open handles. Beyond that, OPEN, CREATE and OPENDIR answer ENFILE. A CREATE refused at the cap now refuses before it makes the file (fixed in Lab K; a new confinement case, and its negative control fails). The worst case is about 5,400 descriptors per VM (read in source), whatever the number of cached files.

Coherence. Ubuntu 24.04's 6.8 virtiofs driver has no notification queue, so the server cannot push an invalidation (`notes-custom-device.md`, read in source; newer kernels can, see "Future levers"). It answers instead with short validity times:
- names and folder attributes: 1 s, as Apple's server does;
- a regular file's attributes: min(1 s, now minus its change time) (`adapt_ttl=1`), so a file just edited on the Mac is checked again at once;
- a node removed on the Mac answers ESTALE (`stale_gone=1`), so Linux looks the name up again at once. Apple's server keeps serving the old node until the 1 s timeout ends.

That is why Mac edits show up at least as fast as on Apple's share: the same timeouts, but shorter ones where something changed. Guest writes go straight to the Mac file. The server keeps no write cache.

### Settings

The server has two configurations, measured below:
- (a) stock kernel 6.8, one request queue: `mode=serial xattr=1 no_flush=1 killpriv=2 keep_cache=3 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1 spin_empty=0 spin_hit=90`.
- (b) stock kernel 7.0, four request queues: the same plus `spin_allq=1`, runner `--queues 4` (see "Four request queues on kernel 7.0").

- `mode=serial`: requests are answered one at a time by one serving thread. Two threads calling `returnToQueue` at once on the same queue stalled it for good, once, after about 11,400 requests (`notes-custom-device.md`, cause unknown).
- `xattr=1` serves extended attributes. `no_flush=1` answers FLUSH once with "not supported", so the guest stops sending it; the server holds no remote locks a FLUSH would release. `xattr_memo=1` remembers "no visible extended attribute" for a node until its change time moves.
- Polling. Each kick reaches our process as a message from Apple's VM service, and each answer goes back the same way: two process hops per request. To save the wake-up for the next request, the server keeps checking the ring for 50 µs after an answer (`spin_us=50`). It does so only while the last 8 or more requests came from the same guest thread, read from the FUSE header (`spin_solo=8`): a lone thread issuing requests back to back, as tar or rm do.

The four settings added in Labs K and L:
- `killpriv=2` grants Linux's second kill-privileges flag: the server, not the guest, removes set-id bits and `security.capability` on write, truncate and owner change. Linux then stops asking for `security.capability` before each write (GETXATTR per build 61,019 to 8,093). The guest observes the same result: after a write, a truncate or an `O_TRUNC` open, `getcap` was empty on both shares (Lab K, measured).
- `keep_cache=3` lets the guest keep a file's cached pages across opens only when the file's identity, size, modification and change times equal what the server recorded at the last open or at its own write. Any Mac edit moves the change time, so the guest reads again. A stale-page test passed 6 of 6 on both shares; keeping pages unconditionally failed 5 of 6, so the test detects staleness (Lab K, measured). READ per build fell from 37,106 to 9,364.
- `spin_empty=0`: no polling after a kick that found no request. It removes CPU waste only; every request is still answered when it is taken (Lab L).
- `spin_hit=90`: poll only after a kick that brought a request, and only while at least 90 % of recent polls found one (a moving average with weight 1/16). Otherwise poll 1 time in 16, to measure again. It only decides whether the serving thread waits by spinning or by sleeping, so answers are the same (Lab L).

## Measured against Apple's share

Configuration (a) unless a heading says otherwise. Same guest for both shares (4 vCPU, 4 GiB, kernel 6.8.0-117), both shares of one Mac folder, rounds interleaved. Times in ms; the median is shown. Each row names its lab.

Maven build of Dubbo 3.2.20 (128 modules, 4,395 tracked files, 11,081 entries under `target/` per build), `mvn -o -B -T 4 -DskipTests clean package`, `~/.m2` on the guest disk. Five rounds in Lab L, in the orders ours/Apple's, Apple's/ours, ours/Apple's, Apple's/ours, ours/Apple's. All runs exited 0 with no error line.

| Load | Lab, runs | Ours, runs | Apple's, runs | Ours | Apple's | Ratio |
|---|---|---|---|---|---|---|
| Clean build | L, 5 | 65,176 67,343 66,127 67,185 66,030 | 65,215 64,470 64,975 64,399 64,834 | 66,127 | 64,834 | 1.020 |
| Rebuild, nothing changed | L, 5 | 61,350 60,863 61,472 62,491 60,783 | 59,940 61,547 60,160 60,114 60,314 | 61,350 | 60,160 | 1.020 |
| `rm -rf` of every `target`⁵ | L, 5 | 1,763 1,731 1,687 1,733 1,615 | 1,712 1,548 1,710 1,605 1,828 | 1,731 | 1,710 | 1.012 |
| `git status` after the build | J, 3 | 358 348 376 | 784 778 778 | 358 | 778 | 0.46 |

⁵ From the raw file `prototype/share-kit/baseline-build-3/raw/times.tsv`; the Lab L notes do not list this row.

Requests per clean build: 331,806 to 332,266 on ours (Lab L, raw file), against 455,369 on Apple's (Lab J, 1 traced build). Ours sends 27 % fewer, so what is left of the gap is the cost per request, not the count.

Test kit (`prototype/share-kit/`). Untar, `find` and `rm -rf` of the kit's 151,516-entry tree: Lab L's five final rounds. The other loads: Lab L's three kit rounds (raw `prototype/share-kit/baseline-build-3/raw/kit/kit.tsv`), except the `find` walks. Lab L did not run those, so they come from Lab K, with the settings before `spin_empty` and `spin_hit`.

| Load | Lab, runs | Ours, runs | Apple's, runs | Ours | Apple's | Ratio |
|---|---|---|---|---|---|---|
| Untar 151k files | L, 5 | 42,030 42,536 43,195 43,182 43,231 | 40,470 37,807 41,051 32,636 41,433 | 43,182 | 40,470 | 1.067 |
| `find` of them | L, 5 | 495 503 515 506 506 | 753 812 806 781 807 | 506 | 806 | 0.63 |
| `rm -rf` of them | L, 5 | 12,610 13,159 13,488 13,491 13,430 | 14,381 14,401 14,392 14,160 14,524 | 13,430 | 14,392 | 0.93 |
| Eight `ls -lR` of a 20k tree | L, 3 | 13,210 12,947 13,480 | 13,575 25,247 13,277 | 13,210 | 13,575 | 0.97 |
| `stat` walk of 64k files, cold | L, 3 | 3,015 2,487 2,531 | 2,710 2,750 2,777 | 2,531 | 2,750 | 0.92 |
| `stat` walk, warm | L, 3 | 519 517 529 | 1,477 1,523 1,491 | 519 | 1,491 | 0.35 |
| `find` walk, cold | K, 3 | 423 406 429 | 1,382 1,291 1,289 | 423 | 1,291 | 0.33 |
| `find` walk, warm | K, 3 | 420 403 425 | 1,499 1,501 1,466 | 420 | 1,499 | 0.28 |
| `git status` of a 40k repo, warm | L, 3 | 195 200 271 | 291 291 245 | 200 | 291 | 0.69 |
| Eight walkers, passes in 20 s | L, 3 | 484 355 463 | 29 30 43 | 463 | 30 | |
| Eight walkers, error lines | L, 3 | 0 0 0 | 31 201 268 | 0 | 201 | |
| Eight walkers, longest probe | L, 3 | 0.4 8.5 1.4 | 4,627 3,999 3,033 | | | |

Where single runs cross: the first cold `stat` walk on ours (3,015) is slower than every Apple run, and the third round of `ls -lR` is slower on ours (13,480 against 13,277). Eight walkers made 15 times as many passes on ours. Lab J (5 runs) and Lab K (3 runs) also had 0 error lines on ours, with longest probes of 0.6 to 0.9 ms and 0.6 to 3.2 ms.

Untar varies with where tar runs in the guest (Lab L, measured). All virtio interrupts of both shares land on guest CPU0 (`/proc/interrupts`). With tar pinned by `taskset`:

| tar pinned to | Apple's | Ours | Ratio |
|---|---|---|---|
| CPU0, the interrupt CPU | 27,602 27,643 | 33,422 | 1.21 |
| CPU2 | 41,207 41,385 | 43,146 | 1.04 |
| Unpinned, five final rounds (median) | 40,470 | 43,182 | 1.067 |

Unpinned runs fall between or at either end. Apple's 32,636 in round 4 of the final rounds was one of these. Earlier labs' untar ratios were this effect: 0.84 in Lab J (Apple's runs all slow, ours partly fast, guessed from the spread of the runs) and 1.27 in Lab K (Apple's fell from 42.0 to 34.4 to 28.2 s over three rounds). Ruled out on Apple's share: the tarball in the guest page cache, a fresh folder, VM uptime. Why the interrupt CPU is faster is guessed: off CPU0, each answer wakes tar through an interrupt between virtual CPUs, which costs a VM exit and a wake-up on the Mac.

The remaining per-request difference. In one traced untar with tar on CPU0 (Lab L, bpftrace), ours sent 1,833,495 requests against 2,242,233, but each small operation took 6 to 11 µs longer: SETATTR 20 against 11 µs, GETATTR 23 against 14, GETXATTR 19 against 14, WRITE 22 against 13, RELEASE 23 against 12. CREATE (41 against 52), LOOKUP (19 against 28) and UNLINK (42 against 136) were faster on ours. The cause is guessed: the API's two process hops per request. Our process spends 14.1 to 16.1 µs per request in a build, the answer call included (Lab K, measured), but it was not split out in the traced untar.

Descriptors with the tree cached (Lab K, 1 walk per share). The 151,516-entry tree was walked with `find` after the guest dropped its caches; guest `inode-nr` rose from 4,280 to 155,803, so the inodes were cached.
- Ours: 10 lsof lines before, after and 3 s later; `kern.num_files` 9,797 before and after.
- Apple's: 38 to 53,631 lsof lines; `kern.num_files` 9,797 to 63,391.
- Peaks over the other loads on ours: 24 lsof lines over the kit and 232 during builds (Lab J). Under 5,000 opens: 4,106 lsof lines, ENFILE at exactly 4,096 open handles (Lab J).

Mac CPU (Lab L, medians, seconds of CPU per run). Our process is the runner; Apple's server runs inside Apple's VM process, whose figure also carries the guest's own work.

| Load | Our process | VM process with ours | Sum with ours | VM process with Apple's | Ours / Apple's |
|---|---|---|---|---|---|
| Clean build | 7.3 | 242.8 | 250.1 | 243.5 | +2.7 % |
| Rebuild | 6.6 | 228.5 | 235.1 | 228.8 | +2.8 % |
| Untar, `find` and `rm` round | 64.1 | 42.4 | 106.5 | 63.0 | +69 % |
| Eight `ls -lR` | 7.6 | 20.4 | 28.0 | 31.1 | −10 % |
| `stat` walks and `git status` | 7.4 | 6.8 | 14.2 | 11.3 | +26 % |
| Eight walkers (15 times the passes) | 19.3 | 29.2 | 48.5 | 30.8 | +57 % |

Idle for 60 s with both shares mounted, our process used 0.02 s. In Lab J the kit round cost 89 to 99 s against 63 s (+41 to +57 %). Memory of our process (Lab J): footprint 9.9 MB after the builds (peak 26 MB), 50 MB after the kit (peak 132 MB).

Coherence (`coherence.py --reps 10`, Lab L, 320 observations per share, no failure on either). Observations later than 0.5 s: 8 on ours, 31 on Apple's. Worst delay until the guest sees a Mac change:

| Mac change | Ours | Apple's |
|---|---|---|
| Deletes a name | 0.000 s | 1.005 s |
| Replaces a file by rename | 0.000 s | 0.799 s |
| Creates a name the guest looked up before | 0.002 s | 1.001 s |
| Renames, old name gone | same on both (1.001 s in Lab J) | |
| Guest writes, Mac reads | 0.000 s | 0.000 s |

Lab J measured the third row as 0.002 s against 0.000 s, so that one case was 2 ms later on ours in one lab; Labs K and L measured Apple's at 1.001 s.

Mac file events for guest writes (Lab K, an FSEvents stream with no latency on the shared folder; the notes do not say how often each action was repeated). Every guest action produced its event on both shares: 13.7 to 19.9 ms on ours, 12.5 to 16.2 ms on Apple's, of which the command itself took 1.5 to 9.9 ms. Created, Removed, Renamed and Modified flags match. Ours lacks the owner-changed flag on create and mkdir, because ours creates files as the Mac user and Apple's changes the owner after creating. IDEA itself was not run.

Conformance (`conform.sh`, Lab L): 40 pass and 6 fail on ours, 39 and 7 on Apple's. The failures are the same lines apart from `create-mode-0`, which fails only on Apple's.

### Several untars at once (Lab N)

Agents often run several create-heavy jobs at once, and one serving thread answers them all. Lab N measured that on configuration (a): a fresh VM of the same recipe on 6.8.0-117, one request queue, the settings under "Settings" (`lab-n-parallel-create-notes.md`, measured). Each run: drop the guest's caches, start N `tar xf` of the 151,516-entry tarball at once into N folders, time until all finish, then N `rm -rf` at once. Ours was remounted before each run. Orders ours/Apple's, Apple's/ours, ours/Apple's. ms.

| Load | Ours, runs | Apple's, runs | Ours | Apple's | Ratio |
|---|---|---|---|---|---|
| Four untars at once | 82,386 82,394 81,983 | 81,011 81,052 80,966 | 82,386 | 81,011 | 1.017 |
| `rm -rf` of the four at once | 29,954 27,977 29,228 | 32,426 32,447 32,805 | 29,228 | 32,447 | 0.901 |
| Two untars at once | 61,113 60,814 60,689 | 52,731 52,041 52,617 | 60,814 | 52,617 | 1.156 |
| `rm -rf` of the two at once | 21,858 21,831 21,823 | 20,275 19,325 20,068 | 21,831 | 20,068 | 1.088 |
| Single untar (anchor) | 44,111 | 41,878 | | | 1.053 |
| Single `rm -rf` (anchor) | 13,924 | 13,894 | | | 1.002 |

Every tar and rm exited 0, all 151,517 entries per tree were found and removed, with no error line and no new kernel message on either share. The anchor fits Lab L (ours about 43 s, Apple's 33 to 42 s). Four untars at once are at parity on 6.8 with one queue, not 20 % slower as on 7.0 with four. Two at once is the worst case measured: +15.6 %.

Guest view, one traced run of four untars per share (bpftrace on, so slower: ours 85,921 ms, Apple's 86,377):
- Untar phase: ours 6,031,391 requests, 70.2k per second, 47.8 µs average; Apple's 7,231,400, 83.7k per second, 38.0 µs. Ours sends 17 % fewer: no FLUSH (Apple's sends 600,000) and half the GETATTRs. At most 5 requests in flight on ours, 3 on Apple's.
- `rm` phase: ours 1,258,086 requests, 41.4k per second, 80.5 µs; Apple's 1,703,219, 52.7k per second, 63.4 µs.
- Ours is slower on every cheap operation (GETATTR 48 against 33 µs, SETATTR 47 against 34, WRITE 47 against 36, LOOKUP 42 against 31), and close on CREATE (71 against 74) and MKDIR (71 against 75).

How busy our serving thread was (runner statistics, 3 untraced runs of four untars, measured; the busy share is derived): handling took 9.4 to 9.7 µs per request and the answer call 1.45 µs, 11.0 to 11.3 µs in all. The thread was inside callbacks 72 to 73 % of the wall time over the whole run. In the untar phase 70.2k requests per second at 11.2 µs makes it about 79 % busy: near its limit, not at it. That the rest of the 47.8 µs guest latency is requests queueing behind the other tars at one server is guessed.

Mac CPU, medians, seconds per run (untar and rm): four untars 88.2 (our process) + 121.7 (VM) = 209.9 against 203.1 for Apple's VM process (+3.3 %); two untars 53.4 + 70.6 = 124.0 against 111.2 (+11.5 %); single 62.5 + 42.0 = 104.5 against 63.9 (+64 %, polling for a lone thread).

Descriptors (`kern.num_files`, sampled every 2 s): Apple's runs peaked at 66,417 to 66,925; four untars plateaued around 62,000 to 66,000 and then dropped back to about 11,700. A purge at 55,296 was not seen as such. Ours peaked at 11,575 to 11,910.

### Build gap

Lab J: 5.2 %. The hardened server took 68,204 against 64,846 ms for the clean build (1.052) and 63,402 against 60,495 for the rebuild (1.048), 3 rounds. A traced build sent 422,934 requests at 66.5 µs each against 455,369 at 31.3 µs on Apple's, at most 11 in flight. Lab J guessed the build was bound by this latency. It also found that polling helped: without it the build was 1.15 (1 run).

Lab K: requests cut, 4.1 %. Two changes, both explained under "Settings":
- `killpriv=2`. A bpftrace probe showed all 61,019 GETXATTR of a build asked for `security.capability`, almost all from the guest's write path. With the flag: 8,093. The rest return because Linux clears its "no security attributes" mark at every attribute refresh (read in the 6.8 source).
- `keep_cache=3`: READ 37,106 to 9,364. It saved only about 0.5 to 0.9 s, because the remaining reads are first reads.
- Requests per clean build fell from about 430k (430,171 to 430,871) to about 340k (339,423 to 339,971), −21 %.
- 75,298 of the 86,115 LOOKUPs are for names that do not exist. Caching missing names would delay a Mac create, so it was ruled out.

Lab K's single runs, clean build in ms, in three locked sessions with Apple's runs in each. Apple's: 64,044 and 64,745; 65,029 and 64,122; 64,752 and 64,348. Lab K judged differences under about 1.5 s to be noise for single runs.

| Lab K settings | Ours, single runs | Our process CPU |
|---|---|---|
| Lab J's settings | 68,465 68,054 70,387 69,200 | 12.4 to 13.3 s |
| `killpriv=2` alone | 66,864 | |
| `keep_cache=2` (exact rule, no update after own writes) or `keep_cache=3` alone | 67,591, 67,588 | |
| `killpriv=2 keep_cache=3`, polling as in Lab J | 66,975 66,952 68,387 | 11.3 s (third run) |
| the same, no polling (`spin_us=0`) | 65,930 64,540 | 8.0, 7.0 s |
| poll 25 µs | 66,287 | 9.9 s |
| poll after every request (`spin_solo=0`) | 70,090 | 17.3 s |
| poll only for runs of 16 or 32 | 68,198, 66,016 | 10.5, 9.9 s |
| poll also when the last gap was shorter than 50 µs | 67,500 | 12.8 s |
| poll 100 µs | 70,680 | 15.0 s |
| poll 100 µs after every request | 73,127 | 25.6 s |
| poll 200 µs after every request | 75,645 | 38.7 s |

The build and untar want opposite things: less polling made the build faster, but untar needs polling. About 1 s of build time was lost per 5 s of extra CPU in our process. Lab K guessed that the spinning thread takes a fast Mac core from a guest CPU (this Mac has 2 Super, 4 Performance and 6 Efficiency cores). But `spin_solo=32` made untar 53,771 against 41,870 ms, the same as without polling, so it was rejected.

| Lab K, final 5 rounds | Ours, runs | Apple's, runs | Ours | Apple's | Ratio |
|---|---|---|---|---|---|
| Clean build | 67,455 66,979 66,950 66,436 67,191 | 64,723 64,359 63,869 64,348 64,903 | 66,979 | 64,359 | 1.041 |
| Rebuild | 61,309 62,149 63,635 63,548 61,751 | 59,804 59,840 59,961 59,807 61,317 | 62,149 | 59,840 | 1.039 |

Lab L: a polling bug, a new rule, 2.0 %.
- The bug. The guest kicks for every request, and polling does not stop those kicks. So the kicks of requests the server had already taken while polling arrived later as empty notifications, and each was polled for 50 µs. After an untar this spun a Mac core for 60 s (59.8 s of CPU, 1.19M empty polls). During a build on Apple's share, with our share idle, it cost 24.5 s of our CPU. `spin_empty=0` removed it: build 66,215 ms with 9.9 s of our CPU, untar 43,008, no spinning after.
- The rule. Lab L tried three ways to tell the build from untar (single runs, build then untar, ms):

| Lab L idea | Build | Untar | Kept |
|---|---|---|---|
| `spin_empty=0` alone | 66,215 | 43,008 | yes |
| Lower the thread's priority while polling | 69,308 | 43,276 | no |
| Background priority class while polling | 67,911 | 42,752 | no |
| Poll only while fast Mac cores are idle (all six) | 66,131 | 42,927 | no |
| The same over two cores, own CPU counted idle | 65,234 | 43,152 | no: needs a side thread and a CPU map |
| Poll only while 90 % of polls find a request (`spin_hit=90`) | 65,606 | 41,059 | yes |
| `spin_hit=90` with `spin_solo=0` | 65,548 | 42,526 | no gain |
| Apple's in the same sessions | 64,932 to 65,967 | 41,156 to 41,442 | |

- Under contention. With one busy Mac program (`yes`) during untar, `spin_empty=0` alone took 74,938 ms, no polling 57,535, and the final rule 58,458: the rule refused polling 1.51M times and fell back to the no-polling level.
- The five final rounds are in the first table above: 1.020 for both the build and the rebuild. Our process now uses 7.3 s of CPU per build, against 11.7 s before Lab L.

What is left (Lab L): the 6 to 11 µs per small request described above. The polling rule no longer costs the build measurably, and the request count is below Apple's.

### Four request queues on kernel 7.0 (Lab M)

Why it was tried. All virtio interrupts of both shares land on guest CPU0, and untar on ours was 21 % slower than Apple's when tar ran there (Lab L, measured). Apple's device has one request queue on any kernel, so it cannot spread its interrupts. Ours can declare several queues. If each guest CPU had its own queue, each answer would interrupt the CPU that asked.

Facts (`lab-m-multiqueue-notes.md`):
- The Linux virtio-fs driver maps CPUs to request queues from v6.10. The code is absent at v6.9 and the same in v7.0 (read in source). On 6.8 four queues are created, but only the first is used and all vectors sit on CPU0 (measured).
- Ubuntu 24.04's stock hardware-enablement kernel, `linux-generic-hwe-24.04`, is 7.0.0-44; the 26.04 cloud image has 7.0.0-43 (measured). A stock newer kernel meets criterion 8; a custom one would not.
- With four queues declared on 7.0, each queue gets one interrupt vector on its own CPU, and a loop pinned to CPU k raises its interrupts on CPU k (measured).
- One serving thread still answers every queue. While it polls after a request it also empties the other queues (`spin_allq=1`). This is configuration (b): the settings of (a) plus `spin_allq=1`, runner `--queues 4`.

Same VM recipe (4 vCPUs, 4 GiB), booted on 7.0.0-44, both shares on 7.0. ms. Five interleaved rounds where 5 runs are listed. Pinned runs had the tarball in the guest page cache; the rounds did not.

| Load on 7.0 | Ours, runs | Apple's, runs | Ours | Apple's | Ratio |
|---|---|---|---|---|---|
| Clean build | 70,790 70,007 70,230 70,322 70,165 | 69,298 69,748 70,423 69,070 69,876 | 70,230 | 69,748 | 1.007 |
| Rebuild | 65,881 66,583 65,916 65,963 68,227 | 64,995 65,285 65,456 65,245 65,183 | 65,963 | 65,245 | 1.011 |
| Untar 151k files | 36,788 36,841 36,811 36,727 36,748 | 45,478 45,620 45,433 45,612 45,662 | 36,788 | 45,612 | 0.807 |
| `find` of them | 321 318 319 317 312 | 2,749 2,821 2,823 2,833 2,826 | 318 | 2,823 | 0.113 |
| `rm -rf` of them | 11,564 11,498 11,539 11,644 11,542 | 11,966 11,828 11,840 11,687 11,756 | 11,542 | 11,828 | 0.976 |
| Untar, tar on CPU0 | 36,934 36,532 | 29,634 29,684 | 36,733 | 29,659 | 1.239 |
| Untar, tar on CPU2 | 36,770 36,833 | 45,471 45,469 | 36,802 | 45,470 | 0.809 |
| Four untars at once | 101,767 102,026 | 85,073 | 101,897 | 85,073 | 1.198 |
| Eight `ls -lR` of a 20k tree | 18,452 18,191 | 14,157 14,195 | 18,322 | 14,176 | 1.29 |
| `stat` walk, cold | 2,700 2,284 | 2,883 2,844 | 2,492 | 2,864 | 0.87 |
| `stat` walk, warm | 575 575 | 1,594 1,591 | 575 | 1,593 | 0.36 |
| `git status`, warm | 257 253 | 325 270 | 255 | 298 | 0.86 |
| Eight walkers, passes | 377 376 | 63 58 | | | |
| Eight walkers, error lines | 0 0 | 1,134 16 | | | |
| Eight walkers, longest probe | 0.4 0.3 | 1,325 1,131 | | | |

Medians of two runs are their mean. Ours' untar is 36.5 to 36.9 s wherever tar runs. Apple's is 29.7 s with tar on CPU0, the CPU of its one interrupt, and 45.5 s elsewhere. In a traced unpinned untar (1 per share), tar spent 4.2 s of system time on ours against 8.9 s on Apple's, the guest counted 4 against 268 interrupt jiffies, and time outside requests was 5.2 s against 18.8 s (measured). Apple's share on 7.0 still gave "Too many open files" under the walkers, so the 7.0 kernel alone does not explain the clean walker runs under Docker's 7.0.14 kernel (`lab-i-docker-notes.md`).

Two new regressions, both caused by the four queues and both of unknown cause:
- Eight parallel `ls -lR`: 1.29 (a pair of single runs gave 18,164 against 14,120 ms, also 1.29). With one queue on 7.0 ours took 13,451 ms against Apple's 14,082 (1 run). Ruled out (measured, 1 run each): polling (`spin_us=0`: 18.2 s) and the thread count (a thread per queue: 17.4 s). Our process's CPU rose from 7.9 to 14.0 s and the VM process's from 21.4 to 33.7 s. Guessed: more notifications per request when eight walkers spread over four queues.
- Four untars at once: 1.20. A thread per queue gave 98,923 ms (1 run), so the serving thread is not the cause. Guessed: a lock in our server (its node table) or APFS.

The kernel effect. In the same VM booted on 6.8, Apple's untar took 41,715 33,749 39,249 ms (median 39,249) against 45,612 on 7.0: +16 %. Apple's build took 65,470 ms (1 run) against 69,748: +6.5 %. Why 7.0 is slower is not known. Ours on 7.0 with one queue took 45,620 ms for the untar (1 run), the same as Apple's, so the 19 % gain comes from the queues, not the kernel. Against today's setup, Apple's share on 6.8, configuration (b) is about 7 % slower on the build (70,230 against 65,470) and 6 % faster on untar (36,788 against 39,249).

Thread choices (ours on 7.0, single runs): one thread serving one notification at a time took 144.3 s for four untars at once and 221 s of our CPU; a thread per queue 98.9 s and 216 s; one thread with `spin_allq=1` 101.8 s and 155 s. The build and a single untar were within 36 to 38 s and 70.6 to 73.0 s across the three. `spin_allq=1` was kept for the same speed at 70 % of the CPU. Mac CPU with it (medians): build 8.2 + 261.3 s against 261.3 s, untar 57.1 + 34.6 against 67.8 s, four untars 155.6 + 163.9 against 209.7 s.

The stall test. A thread per queue means four threads call `returnToQueue` at once, each on its own queue. Run for 600 s under eight `ls -R` walkers and four untar loops (716 s wall, 1 run): 71,198,858 requests sent and all answered, none older than 2 s, longest 66.9 ms (bpftrace). The stall of the original server needed two threads on the same queue, which this mode never does (read in source). So that stall is not a reason against several queues.

Unchanged with four queues (measured): 277 confinement cases pass, 2M fuzzed requests find nothing, conformance 40 pass and 6 fail on ours and 39 and 7 on Apple's (the same lines as on 6.8), coherence 320 observations per share with no case where ours' worst is later than Apple's.

Conclusion: four queues are a trade, not a win. They remove the interrupt-CPU effect and make one untar 19 % faster than Apple's on the same kernel, but they add two regressions, of 20 and 29 %, and the kernel they need is slower by itself.

## Verdict per criterion

1. **Met for caching in one VM, with a cap.**
   - Evidence: 10 lsof lines with 151,516 entries cached and `kern.num_files` flat (Lab K, 1 walk). 24 lsof lines at peak over the kit, 232 during builds (Lab J). During four untars at once, `kern.num_files` peaked at 11,910 on ours against 66,925 on Apple's (Lab N).
   - The original server held 5 plus 5 for two VMs with 260,514 files cached and the Mac-wide count flat at 6,638 (`notes-custom-device.md`, measured).
   - Limit: two VMs were not tested with the hardened server. Open handles still count: up to 4,096 per VM, about 5,400 descriptors at worst (read in source).
2. **Met for the loads run.**
   - Evidence: 0 error lines in 11 walker runs on 6.8 (5 in Lab J, 3 in K, 3 in L), longest probe 8.5 ms, and in 2 runs on 7.0 with four queues (Lab M, probes 0.3 and 0.4 ms). All builds exited 0 with no error line (6 in Lab J, 10 in K's final rounds, 10 in L's). Every parallel untar and removal in Lab N exited 0 with no error line and no new kernel message.
   - Limit: a guest with more than 4,096 open files on the share gets ENFILE. No workload here came near it: guest descriptors on the share peaked at 215 during a build. No soak was run.
3. **Not met in either configuration.**
   - Configuration (a), kernel 6.8, one queue, slower than Apple's on 6.8:
     - clean build 1.020, rebuild 1.020, untar 1.067, `rm -rf` of the build outputs 1.012 (Lab L, 5 rounds each);
     - untar with tar on the interrupt CPU 1.21 (Lab L, 1 run against 2);
     - two untars at once 1.156, their removal 1.088, four untars at once 1.017 (Lab N, 3 runs each);
     - single untar 1.053 and single `rm -rf` 1.002 (Lab N, 1 run each).
   - Configuration (a), at or under Apple's: `find` 0.63 and `rm -rf` of the 151k tree 0.93 (5 rounds); `ls -lR` 0.97, cold `stat` walk 0.92, warm 0.35, `git status` 0.69 and the walkers (3 rounds, Lab L); `find` walks 0.33 and 0.28 (3 rounds, Lab K); `git status` after a build 0.46 (3 rounds, Lab J); removing four trees at once 0.90 (3 runs, Lab N).
   - Configuration (b), kernel 7.0, four queues, slower than Apple's on 7.0 (Lab M):
     - clean build 1.007 and rebuild 1.011 (5 rounds each, within the spread of the runs);
     - untar with tar on the interrupt CPU 1.24 (2 runs against 2);
     - eight parallel `ls -lR` 1.29 (2 runs against 2);
     - four untars at once 1.20 (2 runs against 1).
   - Configuration (b) against today's setup, Apple's share on 6.8: clean build 70,230 against 65,470 ms, about 7 % slower (5 runs against 1).
   - Configuration (b), at or under Apple's on 7.0: untar 0.81, `find` 0.11, `rm -rf` 0.98 (5 rounds); untar with tar on CPU2 0.81, cold `stat` walk 0.87, warm 0.36, `git status` 0.86, the walkers (2 runs each).
   - Limit: builds and untars are where an agent spends its time, so these are open regressions.
4. **Partly met. Not shown for IDEA.**
   - Evidence: no Mac change reached the guest later than on Apple's share in Labs K and L (worst delay per case, 10 repetitions each). In Lab J one case was 2 ms later.
   - Guest writes reach the Mac file at once (0.000 s), and the Mac's file events for them arrive (13.7 to 19.9 ms against 12.5 to 16.2 ms, Lab K). The ranges overlap, but ours' slowest event came 3.7 ms after Apple's slowest.
   - Limit: IDEA itself was not run. The owner-changed flag is missing on create.
5. **Met.** The server serves the Mac folder in place; one device can carry the whole `workspaceRoot`. Limit: one share per device, so more mounts need more devices (read in source).
6. **Met.** No `sysctl`, no sudo, no LaunchDaemon. Only the server's own descriptor limit is raised, to 8,192, inside its own process (`main.m`, read in source; `setrlimit` worked, measured).
7. **Tested, not proven.**
   - Tests: 277 confinement cases pass with the final settings. 26M fuzzed requests after the hardening fixes, then 5M in Lab K and 2M in Lab L with the final settings, found no escape and no memory error. 313 rename swaps under race allowed no request while the folder was outside.
   - When the Mac moves a folder out of the share, ours answers ESTALE to everything and writes nothing outside. Apple's answers EPERM or EACCES but lets `touch ../../escaped` create a file elsewhere in the share (measured, Lab J).
   - Limit: a C server of ours, unsandboxed, now sits on the boundary in place of Apple's, and four windows remain (see "Costs"). Tests show no known hole; they do not show there is none.
8. **Not met: the host driver is not built.**
   - The guest side is met: stock kernel, ordinary driver (measured).
   - The host side does not exist yet: our lima driver is unbuilt, lima's driver API is experimental, the Go binding's version is unreleased, and it needs macOS 27.

`notes-custom-device.md` reports criterion 7 met for 142 of 142 cases and all eight criteria met. A later review in `track.md` found the original server writes outside the share after a move-out (reproduced in Lab J: 3 entries). This document uses the hardened figures only.

## Costs and what is not proven

- **Per-request latency.** Each guest request crosses from Apple's VM service to our process, and its answer crosses back: two process hops.
  - One caller (`notes-custom-device.md`, original server, measured): 36.5 to 36.7 µs without polling, 27.6 to 29.4 µs with it, against 15.1 to 17.8 µs on Apple's.
  - On the interrupt CPU, small operations take 6 to 11 µs more than on Apple's (Lab L, 1 traced untar). On 7.0 with four queues, 6 to 12 µs (Lab M, 1 traced untar per share).
  - Apple's API offers no way around the hops. Longer timeouts would cut LOOKUP and GETATTR requests, but would weaken criterion 4; not tried.
- **Four request queues are a trade.** On 7.0 they make one untar 19 % faster but eight parallel `ls -lR` 29 % slower and four untars at once 20 % slower, causes not measured (Lab M; see "Four request queues on kernel 7.0").
- **Mac CPU of polling.** Configuration (a): +2.7 % per build, +69 % per untar round, +57 % per walker run for 15 times the passes (Lab L); four untars at once +3.3 % (Lab N). Configuration (b): +3.1 % per build, +35 % per untar, +52 % for four untars at once (Lab M). Power and heat on battery were not measured.
- **macOS 27 only.** The API does not exist before it. Apple silicon only; Intel was not checked.
- **Our own lima driver, colima dropped.** colima accepts only `qemu`, `vz` and `krunkit`. Plan: a patched copy of lima's vz driver (about 2,000 lines of Go) started through `limactl`, and a pinata lima template that redoes colima's provisioning (image, docker install and updates, docker socket, data disk). Guessed at 2 to 4 weeks for the driver and 2 to 3 weeks for the lima backend (`notes-shipping.md`).
- **A C server on the trust boundary.** It runs inside lima's driver process on the Mac, unsandboxed. A crash stops the VM. A memory error a guest could trigger would run as the user on the Mac. Fuzzing ran under UBSan with malloc guards; an ASan build hangs at start on this macOS.
- **Confinement windows left** (`notes-hardening.md`, read in source):
  1. One new entry can land in a folder the Mac moves out between the parent's open and the call. Microseconds; not seen in 20,000 raced requests.
  2. Root-relative calls after a check can reach the wrong object inside the share. This is a coherence issue, not an escape.
  3. An open handle keeps its object after the Mac moves it out of the share. A strict mode is designed, not built.
  4. A successful LOOKUP does not check the parent's identity.
- **Designed, not built:** paths beyond `MAXPATHLEN`, birth time as a generation number against inode reuse, the strict mode, a cache of read-only descriptors, and the parent check on LOOKUP.
- **Not measured:**
  - a soak over hours (the longest continuous run, about 15 min and 28.8M requests, was on the original server);
  - power on battery;
  - volumes other than APFS (`adapt_ttl`, `xattr_memo` and `keep_cache` rely on APFS change times);
  - two VMs at once with the hardened server;
  - the failing machine itself and its real workspace, and IDEA;
  - why two threads calling `returnToQueue` at once on the same queue stalled it (not reported to Apple; threads on different queues did not stall in 71M requests, Lab M);
  - lima's experimental driver API, never used to start a VM here;
  - the Go binding Code-Hex/vz v4, whose custom device support is merged (PR #271) but in no release;
  - `~/.m2` on the share;
  - the causes of the two regressions of four queues: eight parallel `ls -lR` 1.29 and four untars at once 1.20 (Lab M; ruled out: polling and the thread count for the first, the serving thread for the second);
  - why kernel 7.0 makes Apple's share slower than 6.8 (untar +16 %, build +6.5 %, Lab M);
  - the real profile: every lab used 4 vCPUs and 4 GiB, while pinata's profile has 8 vCPUs. Queue count, interrupt spread and the serving thread's load may differ there;
  - the real workload: a project of 1,000 or more Maven modules was never built; the build measured is Dubbo, 128 modules.
- **Few runs in places.** Lab M ran some rows twice: the pinned untars, the kit rounds and ours' four untars at once. Apple's four-untar figure there (85,073 ms) is a single run, and so are Apple's 6.8 build (65,470 ms), ours on 7.0 with one queue, and the single-untar anchor of Lab N. Lab N's parallel rows are 3 runs each.

Future levers, outside the criteria today:
- **Pushed invalidations.** The Mac would tell the guest when a file changes, so validity times could be longer and fewer requests sent. Docker VMM does this with 3,600 s timeouts. It needs a guest kernel newer than Ubuntu 24.04's 6.8, and a change feed on the Mac. FSEvents may merge or drop events, and per-file kernel event sources cost one descriptor each. With the 1 s timeouts kept as a safety net it saves no requests; with longer timeouts a missed event means stale data in the guest.

## What only Apple can fix

Apple's built-in server already has what it needs to stay bounded (`notes-vz-internals.md`, read in source):
- It purges cached descriptors only when it holds `kern.maxfilesperproc × 9/10` of them, 55,296 on this Mac. That threshold is a fraction of the per-process limit and applies per VM, so two VMs together can approach the Mac-wide limit of 122,880 (they reached 121,549, `track.md`, measured).
- It can already reopen a purged node by file id (`openbyid_np`, then the saved path), and every guest OPEN already goes through that call.

So it would only need to close descriptors it is not using, for example after a short idle time or at a small fixed count. The guest would see the same files; the cost would be one reopen per later request on such a node. That would give a result with no cost on any criterion: Apple's speed, Apple's coherence, Apple's place on the trust boundary, stock colima. Filing a feedback report with Apple is the one path to it. This is our suggestion, not something measured or tried.

## Path to shipping

`notes-shipping.md` gives the parts, not an order. This order puts the cheapest test of each risk first.

1. **Ship configuration (a) first.** Stock kernel 6.8, one request queue, the settings under "Settings". Keep `--queues` as a switch, off by default. State the remaining gap to users (2 % on the build, up to 16 % on two untars at once). Fallback: keep Apple's share.
   - Multi-queue (configuration (b)) comes later, behind that switch, once its two regressions (eight parallel `ls -lR` 1.29, four untars at once 1.20) are explained and fixed, and once it is clear why 7.0 itself is slower. Would show criterion 3 met on the loads where (b) is faster. Fallback: stay on (a).
2. **Fix what review found.** The LOOKUP parent check, the strict mode for open handles, a sandbox for the server, and the `returnToQueue` stall (report it to Apple). Then fuzz again. Proves criterion 7 has no known hole. Fallback: none; this must hold before users get it.
3. **Repeat the tests not yet run on the hardened server.** Two VMs at once, a soak of several hours, polling power on battery, IDEA watching guest edits, and a non-APFS volume. Proves criteria 1, 2 and 4 for this build. Fallback: Apple's share.
4. **Build the lima driver.** Copy lima's vz driver, port it to Code-Hex/vz v4 at a pinned commit, attach our device with the same mount tags, and redo the space escaping of `05-lima-mounts.sh`. Needs the macOS 27 SDK; this Mac has 26.1. Proves that a VM starts under lima with our share. Fallback: lima's `override.yaml` with our `vmType` under colima (a hack, not tried), or a fork of v3.8.0 with our own Objective-C.
5. **Replace colima with a lima backend in pinata.** A lima template, provisioning, the docker socket and context, docs and the threat model. Proves criterion 8 on a clean Mac. Fallback: keep colima with Apple's share.
6. **Distribute.** A prebuilt darwin-arm64 binary in an optional npm dependency, ad-hoc signed, built on the `xcode-27` runner (in preview); `brew install lima` in `pinata install`; a pinned lima version range. Proves install and update. Fallback: a self-hosted macOS 27 runner.
7. **Run it on the failing machine** with the whole workspace, Maven and IDEA. Proves the original complaint is gone. Fallback: Apple's share and the phase-1 proposal.

On macOS before 27, `notes-shipping.md` has pinata refuse to start. This document instead proposes the phase-1 proposal (`proposal.md`) as the fallback there; the owner decides.

## Where the evidence is

Neither the prototype code nor the raw run outputs that the lab notes cite are in the repository. Paths that start with `prototype/` in these documents do not resolve. The lab notes carry the tables with every run, and the documents describe what the code does.

- `track.md`: the criteria, the plan, review findings and summaries per task.
- `proposal.md`: phase 1, Mac limits plus the guest governor.
- `lab-a-notes.md` to `lab-g-notes.md`: phase-1 labs on Apple's share and the governor.
- `lab-h-notes.md`: Apple's baseline and krunkit with request counts.
- `lab-i-docker-notes.md`: Docker Desktop in three file-sharing modes.
- `lab-j-build-notes.md`: the hardened server against Apple's share, first Maven build and kit.
- `lab-k-build-gap-notes.md`: `killpriv=2`, `keep_cache=3`, polling runs, descriptors with 151k cached, file events.
- `lab-l-polling-notes.md`: the empty-notification bug, the polling rule, the untar variance, the final rounds of configuration (a).
- `lab-m-multiqueue-notes.md`: four request queues on kernel 7.0 (configuration (b)), the kernel comparison, the stall test of a thread per queue.
- `lab-n-parallel-create-notes.md`: two and four untars at once on kernel 6.8 with one queue, serving-thread load, descriptor peaks.
- Raw files per lab, in `prototype/share-kit/`:
  - `baseline-build/`: Lab J (conformance, kit, open-5000 test, traces, running notes).
  - `baseline-build-2/`: Lab K (per-run runner stats of every trial and of the five final rounds, `times.tsv`, coherence, file events, fuzz and confinement output).
  - `baseline-build-3/`: Lab L (`raw/times.tsv`, `raw/kit/kit.tsv`, coherence, conformance, confinement; `scripts/`).
  - `baseline-build-4/`: Lab M (`raw/times.tsv`, `raw/rounds.tsv`, `raw/kit/kit.tsv`, `raw/stress-qt1.txt` for the stall test, `raw/runner.log`; `scripts/`).
  - `baseline-build-5/`: Lab N (`raw/times.tsv`, runner stats, bpftrace and `kern.num_files` peaks per run; `scripts/`).
- `notes-vz-internals.md`: Apple's server read in its binary; no hidden setting.
- `notes-vz-custom-api.md`: the macOS 27 custom virtio device API.
- `notes-custom-device.md`: the original server, latency, two VMs, the `returnToQueue` stall.
- `notes-hardening.md`: the confinement design, its tests, fuzzing and the windows left.
- `notes-shipping.md`: lima driver, colima, Code-Hex/vz, distribution, risks.
- `notes-nfs.md`: the Mac's NFS server and why it fails the boundary.
- `notes-krunkit.md`, `notes-kernel.md`, `notes-ecosystem.md`: krunkit, guest kernel options, other projects.
- `prototype/vzfs-hardened/`: the hardened server (`fsserver.c`), the VM runner (`main.m`), the API header (`vz27.h`), the fuzzer (`fuzz.c`), `build.sh`.
- `prototype/vzfs/`: the original server; superseded, unsafe when the Mac moves a folder out (`prototype/vzfs/SUPERSEDED.md`).
- `prototype/share-kit/`: the test kit (`bench.sh`, `conform.sh`, `coherence.py`, `loads-c.sh`, `helpers/`, `hostbench/`) and the baselines for Apple's share, krunkit and the builds.
- `prototype/nfs-lab/`: NFS setup and forged-handle probe, not run.
- `prototype/share-governor-backpressure.sh`, `prototype/pinata-share-governor.service`: the phase-1 governor.
