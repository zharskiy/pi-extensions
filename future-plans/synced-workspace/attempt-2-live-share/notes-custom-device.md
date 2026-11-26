# T1: a virtio-fs device of our own on macOS 27's custom virtio API (notes)

Started 2026-11-25 06:50. Marks: [V] measured or verified here, [S] read in source, docs or disassembly, [G] guess.

Scratch: the scratch folder's `t1/` (S below).
Prototype source: `prototype/vzfs/` in this folder.

## P0: the API surface

### How it was learned

- [V] Objective-C runtime dump (`S/introspect/dump.m`: `dlopen` of Virtualization.framework, `class_copyMethodList`, `protocol_copyMethodDescriptionList`). The installed SDK (26.1, Command Line Tools) has no headers for these classes.
- [S] Apple's documentation JSON, fetched 06:50 from `https://developer.apple.com/tutorials/data/documentation/virtualization/<name>.json` (`custom-drivers`, `vzcustomvirtiodevice`, `vzcustomvirtiodeviceconfiguration`, `vzcustomvirtiodevicedelegate`, `vzvirtioqueue`, `vzvirtioqueueelement`, `vzvirtiosharedmemoryregion`, `vzcustomvirtiodevicedelegateprovider`, `vzcustomvirtiodeviceconfigurationdelegate`, `vzguestmemorymapping`, `vzvirtiodevicespecificconfiguration`, `vzvirtiofeatureset`). All say "macOS 27.0".

### Public surface (runtime dump, type encodings in brackets)

```
VZVirtualMachineConfiguration
  @property customVirtioDevices : NSArray<VZCustomVirtioDeviceConfiguration>   (also private _customMMIODevices)

VZCustomVirtioDeviceConfiguration : NSObject <NSCopying>
  deviceID (uint16), PCIClassID (uint8), PCISubclassID (uint8), virtioQueueCount (uint16)
  mandatoryFeatures / optionalFeatures : VZVirtioFeatureSet (subset0, subset1 : uint32, read-write)
  - setMandatoryFeatures:(uint32) atIndex:(NSUInteger)   - setOptionalFeatures:atIndex:
  deviceSpecificConfiguration : VZVirtioDeviceSpecificConfiguration  (-initWithConfigurationData:(NSData))
  provider : VZCustomVirtioDeviceProvider
  sharedMemoryRegions : NSArray<VZVirtioSharedMemoryRegionConfiguration>  (-initWithRegionID:(uint8) size:(uint64))
  supportsSaveRestore (BOOL)
  + maximumAllowedSharedMemoryRegionCount
  private: _setPCIVendorID: _setPCIDeviceID: _setPCISubsystemVendorID: _setPCISubsystemID: _setPluginName: _setPluginPersonality:

VZCustomVirtioDeviceDelegateProvider : VZCustomVirtioDeviceProvider
  - initWithDeviceQueue:(dispatch_queue_t) delegate:(id<VZCustomVirtioDeviceConfigurationDelegate>)
  docs: "The delegate runs in the same process as the guest's VZVirtualMachine instance."

protocol VZCustomVirtioDeviceConfigurationDelegate
  - customVirtioConfiguration:didCreateDevice:            (optional)

VZCustomVirtioDevice
  delegate (weak), deviceQueue (readonly), negotiatedFeatures (subset0/subset1), sharedMemoryRegions
  - queueAtIndex:(uint16) -> VZVirtioQueue
  - guestMemoryMappingAtPhysicalAddress:(uint64) length:(uint64) -> VZGuestMemoryMapping (mutableBytes, physicalAddress, length)
  - guestMemoryAtPhysicalAddress:length:      (undocumented twin)
  - driverFeaturesAt:(uint32) error:           (undocumented)
  - requestDeviceReset
  - updateDeviceSpecificConfiguration:completionHandler:
  ivars: _device_queue, _messenger_queue, _connection (xpc), _anonymous_connection (xpc), _device_manager (Vz::CustomVirtioDeviceManager), _queues

protocol VZCustomVirtioDeviceDelegate (all optional)
  - customVirtioDevice:didReceiveNotificationForQueue:
  - customVirtioDeviceDidAcceptDriverOk:
  - customVirtioDeviceWillPause: / WillResume: / WillReset: / WillStop:
  - customVirtioDeviceSaveStateForRestore: -> NSData    - customVirtioDeviceShouldRestore:saveState: -> BOOL

VZVirtioQueue
  queueIndex, queueSize (uint16)
  - nextElement -> VZVirtioQueueElement or nil
  ivars: _queue (VzCore::Hardware::VirtioQueue, in OUR process), _shared_memory_map (Vz::SharedMemoryMap)

VZVirtioQueueElement
  readBuffersByteCount, readBuffersAvailableByteCount, writeBuffersByteCount, writeBuffersAvailableByteCount, writtenByteCount
  - readBuffers -> NSArray<NSData>
  - readBytesWithExactLength:error: -> NSData      - readBytesIntoBuffer:(void*) exactLength:error: -> BOOL
  - readBytes:error:  - readBytesInto:length:error:  - peekIntoReadBuffers:error:  - peekIntoReadBuffersWithExactLength:error:
  - write:(NSData) error:   - writeData:error:   - writeBuffer:(void*) exactLength:error:   - writeData:length:error:
  - returnToQueue

VZVirtioSharedMemoryRegion
  regionID, size
  - mapMemory:(void*) atOffset:(uint64) size:(uint64) completionHandler:
  - unmapMemoryAtOffset:size:completionHandler:
```

### Private twins

- `_VZCustomVirtioDevicePluginProvider -initWithPluginName:pluginPersonality:`, `_VZCustomVirtioDevicePluginBridge -initWithXPCConnection:personalityDictionary:personalityClass:connectionDelegate:options:`, `_VZPluginService +xpcMain`, `PluginInstanceDelegate`, `_VZCustomMMIODevice…`, `_VZMMIORegion -initWithBaseAddress:length:writeSynchronously:`. [V they exist] See P3 for what they suggest.

### First reading of the architecture

- [S] The ivars say the virtqueue is parsed in our process (`VZVirtioQueue._queue` is a `VzCore::Hardware::VirtioQueue`, `_shared_memory_map` a `Vz::SharedMemoryMap`): guest RAM is mapped into the process that hosts the delegate. The device object holds two XPC connections and a "messenger" queue: kicks arrive as XPC messages from the VM's XPC process, and completions must tell it to raise the interrupt.
- [S] Docs: "The Virtualization framework performs all operations on the VZCustomVirtioDevice and VZCustomVirtioDeviceDelegate through a serial queue" (the `deviceQueue` given to the provider).


## P0 checkpoint (07:17): PASSED

- [V] `VZCustomVirtioDeviceConfiguration` with `deviceID = 26`, `PCIClassID = 0x01`, `PCISubclassID = 0x80`, `virtioQueueCount = 2`, 40-byte device configuration (tag `vzfs`, `num_request_queues = 1`), provider `VZCustomVirtioDeviceDelegateProvider(deviceQueue:delegate:)` passes `validateWithError:` together with Apple's own `VZVirtioFileSystemDeviceConfiguration` (tag `apple`) of the same folder, and the VM starts. Binary signed ad hoc with the single entitlement `com.apple.security.virtualization`. No sudo, no sysctl.
- [V] Guest: colima's own image (Ubuntu 24.04.4, kernel 6.8.0-117-generic, copied from colima's cache and booted directly with EFI + NoCloud seed, no lima), `virtio4 0x001a virtio:d0000001Av00001AF4 virtiofs` (ours) and `virtio6` (Apple's) both bound by the stock `virtiofs` module; `mount -t virtiofs vzfs /mnt/vzfs` and `mount -t virtiofs apple /mnt/apple` both succeed and list the same folder.
- [V] Log of the device: `custom device id 26, 2 queues, features mandatory 0 0x1 optional 0x30000000 0x4` (defaults of the class: VERSION_1 mandatory; INDIRECT_DESC, EVENT_IDX, RING_PACKED optional), `DRIVER_OK features 0x30000000 0x5, queue sizes 256 256` (Linux took all three: packed ring, event idx, indirect), `FUSE_INIT guest 7.39 flags 0x7bfffffb flags2 0x1f max_readahead 131072`.
- [V] The device object is created at `VZVirtualMachine` init (callback `customVirtioConfiguration:didCreateDevice:` on the main queue, before start). The EFI firmware also drives the device once before Linux (`DRIVER_OK features 0 0x1, queue sizes 0 256` and one notification on queue 1: EDK2 has its own virtio-fs driver), then resets it.
- [V] Notifications arrive on the dispatch queue given to the provider (`vzfs.device`), on a worker thread of this process (not the main thread), at the queue's QoS (0x21 user-interactive).
- [V] Guest kernel has `CONFIG_FUSE_DAX=y`, `CONFIG_VIRTIO_FS=m`.
- [V] `getattrlistbulk` gives every `stat` field of a directory's entries in one call, identical to `lstat` (2,086 entries, 0 mismatches) once a directory's link count is computed as entry count + 2 (APFS reports 1 through getattrlistbulk).
- Commands: `sh prototype/vzfs/build.sh S/build`; `S/build/vzfs run --disk S/vm/disk.raw --seed S/vm/seed.iso --efi S/vm/run/efi.vars --share S/share --console S/vm/run/console.log --conf S/vm/run/vzfs.conf --cpus 4 --mem 4096`.

## P1/P2 state at 07:28 (functional; timings below marked exploratory are to be repeated under the lock)

### The server (`prototype/vzfs/fsserver.c`, plain C, no VM needed to test it)

- [V] No descriptor per inode. A node is a table row {dev, ino, type, lookup count, generation}; node id = generation << 32 | row. Every request addresses the file as `/.vol/<dev>/<ino>` (or `/.vol/<dev>/<ino>/<name>` for a child), so nothing stays open between requests. Descriptors exist only per open file handle (guest OPEN/CREATE) and for the moment of a request.
- [V] After 118,728 requests (walks of 64k + 20k + 40k trees, conform runs): `descriptors in this process 5`, Mac-wide open files 7,121.
- [V] Names are checked before use: not empty, at most 255 bytes (else ENAMETOOLONG), no `/`, not `.` or `..`; the parent must be a row recorded as a directory; the last component is never followed (`AT_SYMLINK_NOFOLLOW`, `O_NOFOLLOW`, `O_SYMLINK` where a link itself is the target).
- [V] READDIRPLUS is answered from a per-handle snapshot built with `getattrlistbulk` (one syscall per ~hundreds of entries, no per-entry `lstat`).
- [V] Requests are copied out of guest memory before parsing (the guest cannot change a request under the server).
- Still ENOSYS: ACCESS (not sent: the mount has `default_permissions`), GETLK/SETLK/SETLKW/FLOCK (the guest then locks locally, as it does on Apple's share without FUSE_POSIX_LOCKS), COPY_FILE_RANGE (kernel falls back to read+write), IOCTL, POLL, BMAP, SETUPMAPPING/REMOVEMAPPING (DAX).

### Linux 6.8 behaviour that shaped it

- [V] `fstat()` on an open file arrives as GETATTR by node id with no file handle; a file unlinked while open has no `/.vol` path any more, so the server falls back to an open handle of the same node (`handle_of_node`). Same for SETATTR.
- [S] virtiofs in 6.8 uses one request queue whatever `num_request_queues` says (multi-queue came in 6.10). [V] mount options are always `rw,relatime` with `default_permissions,allow_other` implied.
- [S] FUSE clears `SB_NOSEC`, so each `write()` asks GETXATTR `security.capability` first, unless the server once answered ENOSYS to GETXATTR. A server with xattrs (Apple's) pays that extra round trip per write; `xattr=0` here avoids it. Both settings are measured below.

### Conformance (`prototype/share-kit/conform.sh`, T-shared kit) [V]

- Ours, xattr=1, owner=1: 40 PASS. Not PASS: `chown` (ignored, rc=0), `perm-enforced-write-0755-other` (y), `name-invalid-utf8-ff`, `name-nfd-distinct-from-nfc`, `name-case-sensitive`. Every one of these is identical on Apple's share (they come from APFS and from the owner rule below). Ours passes `create-mode-0` and `chmod-setuid`, which Apple's share fails.
- First run of ours failed `unlink-open-file`, `mknod-socket`, `fallocate`, SEEK_DATA/SEEK_HOLE, a 256-byte name (EINVAL instead of ENAMETOOLONG) and ownership; all fixed in the server (handle fallback, `make_socket` bind+rename, `F_PREALLOCATE`/`F_PUNCHHOLE`, lseek mapping of Linux 3/4 to macOS 4/3, `bad_name`, `owner=1`).
- `fallocate-punch-hole rc=0 blocks=18432` and `sparse-seek-data-hole 1073741824 0` are the same on both shares.

### Apple's owner rule, reproduced [V]

- On Apple's share every file is owned by whoever asks: `stat` as uid 1000 says 1000:1000, `sudo stat` 1.2 s later says 0:0 (inside 1 s the cached answer of the other user is served). `chown` returns 0 and changes nothing. Permission bits for "other" are therefore never the ones applied.
- `owner=1` (default) does the same: uid/gid of the request header go into every attribute answer; chown is accepted and ignored. Outputs of the alternating `stat`/`sudo stat` sequence are identical on both shares.

### Confinement (criterion 7) [V]

- `vzfs confine <empty dir>` plays a hostile guest kernel against the server without a VM: raw FUSE requests a real kernel would never send. Share root with `link-abs -> <outside>`, `link-up -> ..`, `link-file -> ../outside/secret`, and a folder `outside/secret` next to the root.
- 142 checks, 142 PASS (07:28): ten bad names (`..`, `.`, empty, `sub/f`, `../outside`, `../outside/secret`, `/etc/passwd`, `link-abs/secret`, `link-up/outside/secret`, `sub/../../outside/secret`) × LOOKUP, CREATE, MKDIR, MKNOD, UNLINK, RMDIR, SYMLINK, RENAME (both sides), LINK all refused; 256-byte name refused; links are answered as links; LOOKUP/OPENDIR/CREATE/MKDIR/UNLINK/RENAME with a link as parent refused; OPEN, truncate, chmod, setxattr, LINK on `link-file` do not touch its target; forged node ids (0, 2, 0xdeadbeef, the inode number of `outside`, a valid row with a wrong generation, ~0) refused; a directory swapped on the Mac for a link to outside keeps meaning the directory (the node is dev+ino, not a path). After the run `outside` holds only `secret`, content `SECRET`, mode 0640, link count 1.
- In the guest (earlier, through the real kernel): `cat /mnt/vzfs/t1-small/link-abs` reads the guest's own `/etc/passwd` (the guest resolves links, as on Apple's share), `ls link-up/` lists the guest-side parent.
- Residual, same as any path-based server: `/.vol/<dev>/<ino>/<name>` is resolved by the kernel in one step for a single component with no-follow, so there is no window between check and use for the last component; the parent is addressed by inode number, not by a path that could be swapped.

### Per-request round trip, first numbers (EXPLORATORY: taken at 07:20 without the exclusive lock; repeated below)

- Guest `statx(AT_STATX_FORCE_SYNC)` of one cached file = exactly one GETATTR; 5,000 calls × 3 runs, 4 vCPUs.
- Ours, serial mode (serve on the device queue, complete there): median 33.7 / 33.8 / 33.6 µs (min 32.2-32.5, p90 36.4-38.4, p99 43.0-46.8).
- Apple's: median 15.9 / 16.2 / 16.2 µs (min 13.2-14.5, p90 18.5-18.8, p99 21.0-21.7).
- Host-side stages of ours per request: `nextElement` 0.19 µs, read 0.09 µs, GETATTR work 1.5-2.6 µs, write 0.07 µs, `returnToQueue` 4.39 µs. So about 25 µs of the 33.7 are not in our code: the kick's way in (guest exit, VM process, XPC to us, dispatch) and the completion's way out (XPC to the VM process, interrupt).

### Trap found

- `g_conf_path = opt[@"conf"].fileSystemRepresentation` kept a pointer into an autoreleased buffer; the reload at FUSE_INIT then silently read nothing, so `conf.sh` changes did not apply before 07:26. Every comparison of options made before that time used the defaults. Fixed with `strdup`; the log now prints `vzfs: conf mode ...` at each FUSE_INIT.

## DAX window through `VZVirtioSharedMemoryRegion` (07:31-07:38): possible [V]

- [V] `--dax-mb 512` adds `VZVirtioSharedMemoryRegionConfiguration(regionID: 0, size: 512 MiB)` to the custom device. The stock guest logs `virtiofs virtio6: Cache len: 0x20000000 @ 0x180000000` and `mount -t virtiofs -o dax=always vzfs /mnt/vzfs` succeeds (`rw,relatime,dax=always`). FUSE_INIT from the guest then carries FUSE_MAP_ALIGNMENT (flags `0x7ffffffb`); we answer `map_alignment = 14` (16 KiB, the Mac's page size; Linux accepts anything up to its 2 MiB range size).
- [V] Linux then sends FUSE_SETUPMAPPING by node id (`fh = -1`), 2 MiB pieces at 2 MiB window offsets, and FUSE_REMOVEMAPPING. The server opens the file for the moment of the `mmap`, closes it, and hands the address to `-[VZVirtioSharedMemoryRegion mapMemory:atOffset:size:completionHandler:]`. Descriptors in the process stay at 5.
- [V] Results, one 5 MiB file of random bytes, `md5sum` in the guest equals `md5` on the Mac (a1575c068ab3e23da2cad33ae10dd664) with: anonymous memory holding a copy (dax_mode=2); the file mapped `MAP_SHARED` read-write (dax_mode=1); the file mapped `MAP_PRIVATE` read-write (dax_mode=3).
- [V] With dax_mode=1: guest `dd conv=notrunc` at offset 100 -> the Mac reads `GUESTWROTE` at once; the Mac writes at offset 3,000,000 -> the guest reads `MACWROTE` at once (same pages, no 1 s wait: file data is more coherent than on Apple's share); guest `mmap` write + `flush` -> the Mac reads `MMAPED`.
- [V] Cost: `mapMemory` 44-48 µs per 2 MiB piece (n = 3 and 5), `unmapMemory` 78 µs (n = 2), each on top of the FUSE round trip that carries it.
- Three hard rules of the API found by breaking them:
  1. [V] `mapMemory:` must be called on the device queue: from a pool thread our process dies in `dispatch_assert_queue` inside `-[VZVirtioSharedMemoryRegion mapMemory:atOffset:size:completionHandler:]` (crash report `vzfs-2026-11-25-073600.ips`).
  2. [V] Its completion handler is delivered on the device queue too: waiting for it on that queue never ends (`no completion within 3 s (called on queue vzfs.device)`). A server must finish the SETUPMAPPING reply from the handler, not block. The prototype hops to the device queue and waits on a pool thread, so the window needs `mode=pool-direct` here.
  3. [V] The memory must be mapped read-write in our process. A `PROT_READ` `MAP_SHARED` mapping (what a read-only SETUPMAPPING naturally gives) does not return an error: the VM's service process hits a trap on its queue `com.apple.virtualization.virtio.custom-device:0` and the VM dies with `VZErrorDomain Code=1 "The virtual machine stopped unexpectedly."` (twice: 07:32:56 and 07:37:37, crash reports `com.apple.Virtualization.VirtualMachine-2026-11-25-073256.ips`, `-073737.ips`). So a file the Mac user may only read has to go in as a private read-write view (dax_mode=3 form), never as a read-only one.
- Worth it? [G, from the numbers above] Not for the criteria here. DAX replaces READ/WRITE round trips of a file's data by one SETUPMAPPING (round trip + 45 µs) per 2 MiB piece touched and later a REMOVEMAPPING; for a small file that is more expensive than the single READ it replaces, and trees of small files are what every benchmark of criterion 3 is made of. It pays for large files read or mapped repeatedly (no double caching in the guest, `mmap` shared with the Mac, immediate data coherence). It should be an opt-in mount option, off by default. Not measured: throughput of large-file I/O with and without the window.
- Trap for the cleanup list: each crash left a report in `~/Library/Logs/DiagnosticReports/` (three files named above); removed at the end.

## Hold 1 of the exclusive lock (07:43:49-07:59:45): transport, walks, walkers, first macro

All [V], one boot of the lab VM (4 vCPUs, 4 GiB, kernel 6.8.0-117), both shares of the same Mac folder mounted
(`/mnt/vzfs` ours, `/mnt/apple` Apple's), the lock held, watchdog at 100,000 Mac-wide open files armed.
Scripts (scratch, removed at the end): `vm/latmodes.sh`, `vm/lat1.sh`, `vm/ab.sh` = `bench.sh` of the share-kit in the
guest; raw TSV copied below.

### Functional answers about the queue API

- `nextElement` works from a thread of our own (`--set poller=1`: 91,372 requests taken by an `NSThread`, conform 39
  PASS, no error) [V]. `returnToQueue`, `readBytesIntoBuffer`, `writeBuffer` work from pool threads [V].
- Two threads in `returnToQueue` at once is NOT safe [V, one occurrence]: `mode=pool-direct` (each request read, served
  and completed on a concurrent pool thread) survived 15,000 one-at-a-time requests, then stalled for good after about
  11,400 requests of the first 4-process run (26,423 of 35,009 done, "most in flight 4"; no thread of ours busy in
  `sample`, the guest's four `statx` callers never returned; VM had to be restarted). The same load with completions
  under one lock (`ret_lock=1`) or with taking and completing under one lock (`ret_lock=2`) ran 2 x 20,000 parallel
  requests each without a stall. So: any thread, but one `returnToQueue` at a time.
- `mapMemory:` only on the device queue (see the DAX section).

### Per-request round trip (the P1 question)

Guest: `lat.py <file> 5000` = 5,000 `statx(AT_STATX_FORCE_SYNC)` of one cached file, each exactly one GETATTR.
Three runs per configuration on ours; `4 procs` = four such processes at once. Microseconds.

| configuration | ours, median of each run | ours p99 | ours 4 procs: median, total req/s | Apple's same minute: median, 4 procs |
|---|---|---|---|---|
| `mode=serial` (serve on the device queue) | 36.7 / 36.7 / 36.5 (min 30.6-32.3) | 67.2 / 43.8 / 43.1 | 48, 81,739 | 17.8 (p99 36.6); 27, 142,364 |
| `mode=serial spin_us=50` | 29.4 / 27.6 / 27.8 (min 19.2-20.3) | 58.1 / 38.6 / 39.7 | 30, 70,000, max 10.0 ms in all four | 15.1 (p99 23.2); 25-29, 133,405 |
| `mode=serial spin_us=200` | 27.9 / 27.2 / 27.2 (min 19.5-20.1) | 57.6 / 36.0 / 35.7 | 30-33, 77,912, max 9.8 ms in all four | 15.5 (p99 23.1); 31-32, 117,443 |
| `mode=pool-direct` (no lock) | 32.9 / 32.8 / 32.5 | 66.2 / 42.2 / 43.2 | STALLED (see above) | |
| `mode=pool-direct ret_lock=1` | 33.5 / 32.4 / 32.5 | 71.0 / 41.5 / 44.2 | 52, 74,321 and 74,794 | |
| `mode=pool-direct ret_lock=2` | 27.3 / 33.0 / 32.5 | 62.4 / 45.5 / 43.2 | 52, 73,836 and 74,566 | |
| `mode=pool-hop` (serve on pool, complete on device queue) | 34.9 / 34.5 / 33.7 | 80.3 / 44.7 / 46.0 | 56, 70,898 and 70,609 | |
| `mode=auto` (inline when nothing else in flight) | 36.2 / 35.3 / 35.1 | 74.4 / 42.9 / 42.2 | 50-51, 78,529 and 78,767 | |

Share-kit's own probe (`bench.sh --only latency`, `stat_uncached_median`, 3 runs): Apple's 16.6 / 17.4 / 17.2 us;
ours serial 36.1 / 36.5 / 36.5 us (37.1 / 36.2 / 36.2 in a second set); ours `spin_us=50` 28.0 / 30.0 / 29.4 and
29.2 / 29.5 / 29.4 us.

Host-side stages of ours in `mode=serial` (35,009 requests): GETATTR work 1.48 us, `returnToQueue` 1.45 us, whole
callback 3.02 us per request. So of 36.5 us about 33 us are spent outside our code: the guest's kick travelling as
an XPC message from the VM service to our process, and our completion travelling back to raise the interrupt.

Reading:

- One request costs 2.1x Apple's (36.5 against 17 us); polling the ring for 50 us after each request (the next
  request is then picked up from shared memory without waiting for the kick) brings it to 28 us = 1.65x, at the
  price of a busy Mac core while requests flow, and it produced 10 ms stalls under four parallel callers.
- Serving in parallel does not help: four callers get 70-82 thousand requests/s from us in every mode against
  117-142 thousand from Apple's serial server. The serial part is not our handler (1.5 us) but the two XPC hops and
  the one request queue of the 6.8 guest.
- Therefore criterion 3 can only be met through fewer requests per file, not through a faster request.

### Walks and git status (`bench.sh --runs 3 --only statcold,statwarm,findcold,findwarm,gitwarm`, tree64k = 67,209 entries, repo40k)

Milliseconds, three runs each.

| test | Apple's | ours `mode=serial xattr=1` | ours + `no_statx=1` | ours + `no_statx=1 no_open=1 no_flush=1 spin_us=50` |
|---|---|---|---|---|
| stat walk cold (`find | xargs stat` after drop_caches) | 3628 2524 2554 | 3022 2994 3015 | 647 569 564 | 573 570 563 |
| stat walk warm | 1475 1552 1433 | 511 513 508 | 541 534 535 | 550 551 560 |
| find cold | 1338 1232 1336 | 502 518 513 | 484 471 548 | 427 419 388 |
| find warm | 1438 1440 1465 | 478 482 476 | 536 521 518 | 388 418 383 |
| git status warm | 246 291 298 | 312 260 314 | 262 317 262 | 186 222 224 |

- Why the cold stat walk is the one place the plain configuration loses: coreutils `stat` asks for the birth time,
  which only FUSE_STATX can deliver; the kernel sends one STATX per file the first time (67,209 STATX in the trace,
  36 us each = 2.4 s). Apple's server answers STATX too (`stat -c %w` shows a birth time on its share). With
  `no_statx=1` (ENOSYS: the 6.8 guest then serves `statx()` from the attributes READDIRPLUS brought, and `stat -c %w`
  prints `-`) the cold walk needs no per-file request at all: 0.57 s against 2.5 s. Price: no birth time in the guest.
- `readdirplus=2` (grant READDIRPLUS_AUTO as Apple's does; the default 1 grants only DO_READDIRPLUS, so every
  directory read is a READDIRPLUS) changed little: 2925 2950 2932 cold, 602 626 605 warm.
- `no_opendir=1` is harmful and stays off: the guest then caches listings (FOPEN_CACHE_DIR), no READDIRPLUS
  refreshes the attributes, and the warm stat walk goes to 2793 2788 2783 ms (one revalidation per file). The 16-20 ms
  "git status" seen in that configuration is the guest answering from its own cache within the 1 s timeout.

### Eight parallel walkers (`bench.sh --only walkers --walk-secs 20`, three runs)

| | Apple's | ours `mode=serial xattr=1 no_statx=1` |
|---|---|---|
| passes completed in 20 s (8 walkers) | 28, 28, 22 | 518, 525, 515 |
| error lines (all EMFILE "Too many open files") | 1427, 915, 15 | 0, 0, 0 |
| longest single probe call | 4513.7, 4490.8, 4745.4 ms (5-6 calls over 500 ms per run) | 3.9, 3.3, 2.9 ms (none over 500 ms) |
| probe median | 0.77, 0.71, 0.70 ms | 0.11 ms |
| Mac-wide open files right after | 52,743 | 10,735 (5 descriptors in our process) |

### Untar / find / rm of 151,516 entries (150,000 files), first run each (`bench.sh --runs 1 --only macro`)

| | Apple's | ours `mode=serial xattr=1 no_statx=1` |
|---|---|---|
| untar | 41,919 ms | 69,748 ms |
| find | 767 ms | 583 ms |
| rm -rf | 13,973 ms | 16,839 ms |

Ours is 1.66x slower on the untar. Requests of ours for the whole macro run (2,415,565; host work 7.5 us each):
LOOKUP 151,870 (151,519 ENOENT), CREATE 150,000 (27.5 us host), GETXATTR 300,000 (all without data), WRITE 150,000,
FLUSH 150,000, RELEASE 150,000, SETATTR 454,548, GETATTR 450,105, UNLINK 150,000 (26 us host), FORGET 281,750,
MKDIR/RMDIR 1,517 each, READDIRPLUS 18,188. That is about 13 requests per extracted file, each paying the round trip:
13 x 36 us = 0.47 ms per file = 70 s. To be tried next: fewer requests per file.

### Where the untar time goes, and what can be removed (08:00-08:05, no lock: single traces, nothing timed in the VM)

[V] Trace of `sudo tar -x` of three files (`--set trace=1`), requests per extracted file on a 6.8 guest, plain
configuration: GETATTR of the parent (each create invalidates the directory's attributes and `default_permissions`,
which virtiofs forces, needs them for the next path walk), LOOKUP (ENOENT), CREATE, GETXATTR `security.capability`
(before the write), WRITE, SETATTR (times), GETXATTR `security.capability` (before chown), GETATTR (chown of a regular
file: the guest refreshes the mode to drop set-id bits itself), SETATTR (owner), SETATTR (mode), FLUSH, RELEASE (not
waited for). 11 waited requests + 1. Apple's server gets the same list from the same kernel [G: not traced there; its
INIT flags (T2) include neither HANDLE_KILLPRIV nor anything that would shorten it].

[V] What a server can remove without losing a feature (all three implemented, conform still 40 PASS):
- `killpriv=1` (grant FUSE_HANDLE_KILLPRIV; we drop set-user-id/set-group-id on write, truncate and owner change
  ourselves): the GETATTR before chown goes.
- `no_flush=1` (ENOSYS once): FLUSH goes; we hold no remote locks that a FLUSH would have to release.
- remembered "this node has no `security.capability`" (set when we create the file with O_EXCL or when the Mac
  once said so, cleared when the guest sets the attribute; `setcap`/`getcap` verified on the share): the two
  GETXATTR stay as round trips but cost 0.1 us instead of the Mac's 9-10 us `getxattr`.
  Trace after: GETATTR(parent), LOOKUP, CREATE, GETXATTR, WRITE, SETATTR, GETXATTR, SETATTR, SETATTR, RELEASE = 9 + 1.
- Only `xattr=0` (ENOSYS to GETXATTR: the guest stops asking, and has no extended attributes on the share) removes
  the two GETXATTR: 7 + 1. The LOOKUP, the parent GETATTR and tar's three SETATTR cannot be removed by any server.

[V] Mac-side cost of the calls themselves (`micro/m.c`, 20,000 files in the shared folder, APFS, two rounds):
create 21.9-23.9 us through `/.vol/<dev>/<ino>/name` and 21.0-21.8 us through `openat(dirfd)`; lstat 1.2-1.5 against
0.68 us; `getxattr` of a missing attribute 9.3-10.5 us; chmod 8.8-9.0 us; unlink 13.2-13.6 against 13.1-13.5 us.
So addressing by inode number instead of by an open directory costs under 1 us per call, and nothing on create or
unlink: the descriptor-free design is not what makes the untar slow. The round trips are.

[V] macOS as the owner (not root): a write to a 6755 file leaves 0755; ftruncate leaves 4755 (hence our own drop).

## P3: design notes for a complete server (written 08:07; [V] where the prototype shows it)

### Operations

- Done in the prototype [V, conform 40 PASS = Apple's set of passes plus none missing]: INIT, DESTROY, LOOKUP, FORGET,
  BATCH_FORGET, GETATTR, STATX, SETATTR, READLINK, SYMLINK, MKNOD (regular, fifo), MKDIR, UNLINK, RMDIR, RENAME,
  RENAME2 (NOREPLACE, EXCHANGE), LINK, OPEN, CREATE, READ, WRITE, RELEASE, FLUSH, FSYNC, FSYNCDIR, OPENDIR, READDIR,
  READDIRPLUS (one `getattrlistbulk` per chunk), RELEASEDIR, STATFS, GET/SET/LIST/REMOVEXATTR, FALLOCATE, LSEEK,
  SETUPMAPPING, REMOVEMAPPING.
- Answered ENOSYS on purpose: ACCESS (never sent under `default_permissions`), GETLK/SETLK/SETLKW and flock (the
  guest then keeps locks itself: they work between processes of one guest, conform `flock-lock-conflict` PASS, but
  are invisible to the Mac and to other VMs; Apple's grants FLOCK_LOCKS when offered [S, T2], so a lock taken in
  the guest is presumably a Mac `flock` there: the one behaviour we do not reproduce), COPY_FILE_RANGE (kernel falls
  back to a copy; `clonefile` would be an upgrade), IOCTL, POLL, BMAP, SYNCFS, TMPFILE.
- To add for a product: flock passed to the Mac (one descriptor per locked file, bounded by locks held, not by cache
  size); a fallback for volumes without `/.vol/<dev>/<ino>` addressing (network and non-APFS volumes: [not tested];
  there the choice is a path table or a bounded descriptor cache); a policy for mount points inside the share
  (today the node key is device + inode, so they work, but inode numbers of two volumes can collide in the guest).

### How no descriptor per inode works [V]

A node is 40 bytes: device, inode number, lookup count, generation. The guest's node id is index + generation.
Every Mac call addresses the object as `/.vol/<dev>/<ino>` (or `/.vol/<dev>/<parent ino>/<name>`), always with
NOFOLLOW; descriptors exist only (a) for files the guest has open right now (one per FUSE handle; none with
`no_open=1`, where a 256-slot cache serves I/O), (b) in a 256-slot cache for I/O by node id (`fstat`-less reads,
DAX set-up), (c) for a file deleted while the guest still knows it (`no_open=1` only, capped at 4,096), (d) 64
directory snapshots in flight. None of these grows with what the guest has merely seen. Cost of the addressing:
under 1 us per call against an open directory descriptor, nothing on create and unlink (measured above).

### Cache timeouts

Same as Apple's by default: entry 1 s, attributes 1 s, no negative entries, no notifications (the 6.8 virtiofs
driver has no notification queue; Apple's server never notifies either [S, T2]). Measured promptness: see holds 2
and 3. Two rules added after hold 3 that make the guest see Mac-side changes sooner than through Apple's share
without a shorter timeout (section "After hold 3" below): `adapt_ttl=1` (a regular file's attributes are valid
for no longer than the file has been unchanged) and `stale_gone=1` (a node that is gone on the Mac answers ESTALE,
which makes Linux look the name up again at once).
[G, not built] The same idea for names: an entry valid for no longer than its directory has been unchanged would
shorten "old name after a rename" too, at the price of one more `fstat` per LOOKUP and extra LOOKUPs while a
directory is being filled.

### DAX window

Possible on the stock guest [V] (section above), three API rules. Not worth it for the criteria: it speeds up
neither metadata nor creates; each 2 MiB piece costs a `mapMemory` (44-48 us plus the request) and must go through
the device queue; files the Mac user may only read need a private copy-on-write view. Opt-in for large files.

### Owner, group, mode

Apple's rule reproduced [V] (`owner=1`): every object appears owned by the uid and gid of whoever asks, chown
returns 0 and changes nothing, mode bits are the Mac's. The guest enforces access itself (`default_permissions`,
forced by the virtiofs driver). With `killpriv=1` we drop set-id bits on write, truncate and chown.

### Confinement

Node ids are handed out only for objects found by name under the root; a request carries ids, never paths; names
are refused when empty, `.`, `..`, longer than 255 bytes or containing `/` or NUL; no Mac call ever follows a
symbolic link or walks more than one component; forged ids fail the generation check. 142 of 142 hostile requests
refused [V]. As with Apple's share: a hard link inside the root to a file outside it is readable, and a directory
a Mac process moves out of the root stays reachable until the guest forgets it. Because the device is our own
process, it can additionally be sandboxed to the share root (Apple's server, inside the VM service, cannot be) [G].

### Threading

Notifications arrive on the serial dispatch queue we give the device, one XPC message per kick. Requests may be
taken and completed from any thread, but only one `returnToQueue` at a time [V]. On a 6.8 guest parallel serving
buys no throughput (the transport is the serial part) but keeps one slow request (large read, fsync, `mapMemory`)
from blocking the rest: `mode=auto` plus a completion lock is the shape. `mapMemory` only on the device queue,
answer from its completion handler, never block that queue.

### Private plugin classes

[S, T2] Apple's plugin devices (`com.apple.Virtualization.PluginLoader.xpc`) also run outside the VM's process, need
private entitlements and a folder on the sealed system volume: closed to us, and they would pay an XPC hop too.
It matters a great deal for latency: the two process hops per request (kick in, completion out) are about 19 of our
36 us; a device inside the VM service would answer in about Apple's 17 us and, with our request counts, beat it on
every load. The public API offers no such place.

### Shipping

- Entitlement `com.apple.security.virtualization` with an ad-hoc signature is enough [V: `build.sh`]. macOS 27 is the
  minimum (classes looked up at run time; below 27 fall back to Apple's share). Until the build uses the 27 SDK the
  protocols are declared by hand (`vz27.h`).
- The device is part of the `VZVirtualMachineConfiguration`, so it must be created by the process that owns the VM.
  It cannot be attached to colima's VM from outside. Routes [S, T4]: (1) a lima external driver
  (`lima-driver-<name>`, lima 2.x) = lima's vz driver plus this device, keeping `mountType: virtiofs` and the same
  mount tag so the guest side does not change (lima validates the mount type against a fixed list; colima's `vmType`
  list is fixed too, so pinata would call `limactl` itself instead of colima); the Go bindings (Code-Hex/vz) do not
  expose the custom device yet, so the driver needs a small Objective-C shim; (2) pinata's own VM runner, as this
  prototype (about 1,250 lines for VM, device and transport, 2,800 for the server), which then also owns disk,
  network, seed and port forwarding.

## Changes to the prototype after hold 1 (07:59-08:05), none timed yet

- [V] New settings: `no_statx=1` (ENOSYS to STATX), `killpriv=1` (FUSE_HANDLE_KILLPRIV; set-id bits dropped by us on
  write, truncate, chown), and the per-node memory "no `security.capability` here" (always on with `xattr=1`).
- [V] Fixes: with `no_open=1` a file deleted while open is now kept through a read-write descriptor (conform's
  unlink-open-file failed with EBADF); a configuration reload starts from the command-line values (a setting left
  out of the file used to keep its previous value); `conf.sh` splits its words.
- [V] After these: `vzfs confine` "ALL PASS: 0 failed" (142 hostile requests); conform on our share 40 PASS in
  `mode=serial xattr=1` and in `mode=serial xattr=1 no_statx=1 no_flush=1 killpriv=1`; the five lines that are not
  PASS are the five that are not PASS on Apple's share either (chown ignored, write by "other" on 0755 allowed for
  the mapped owner, invalid UTF-8 name refused, NFD/NFC names folded, case-insensitive volume). DAX default mode
  re-read a 64 MiB file with the Mac's md5 (`eca1f3895bb6f3b60c731079a34b6792`).
- [V] `setcap cap_net_raw+ep` on a file of the share is stored and shown by `getcap`; a later write removes it.
- [V] Coherence harness, dry run on our share (1 repetition, not under the lock, so not a result): every case seen
  by the other side before the harness's first poll, except Mac->guest "rename: old name gone" 1.001 s and
  "replace by rename: new data" 0.792 s (the 1 s entry timeout, the same value Apple's server gives).
- Scripts for hold 2 (scratch): `vm/hold.sh` (runs steps under the lock, guard at 19 minutes), `vm/crit1.sh`.

## Hold 2 of the exclusive lock (08:25:06-08:38:09): one configuration against Apple's, same boot, interleaved

Command: `vm/hold.sh hold2 macro3 statfull walkers-full crit1 coh setid conform-ours conform lower nospin2` (scratch;
each line below is the shared `share-kit/bench.sh` on `/mnt/vzfs` or `/mnt/apple` of the same VM, 4 vCPUs, 4 GiB).
Before it: the "no security.capability" memory now expires with `attr_ttl` (1 s), so nothing we remember outlives
what the guest itself may cache; confine again "ALL PASS: 0 failed".

FULL = `mode=serial xattr=1 no_flush=1 killpriv=1 spin_us=50`, everything else default: STATX answered (birth time
kept), extended attributes on, timeouts 1 s / 1 s, no negative entries, READDIRPLUS always, no DAX. NOSPIN = FULL
without `spin_us`.

### Create-heavy load (untar 151,516 entries / 150,000 files, find, rm -rf), ms, 3 runs [V]

| | untar | find | rm -rf |
|---|---|---|---|
| Apple's | 41,410 40,887 41,949 | 796 801 797 | 13,845 14,018 13,999 |
| ours FULL | 42,115 40,242 39,976 | 454 451 446 | 13,589 13,435 13,373 |
| ours NOSPIN | 55,899 55,955 55,852 | 582 519 588 | 17,259 17,595 17,095 |
| ours FULL + `xattr=0` (1 run) | 34,234 | 479 | 13,727 |
| earlier, hold 1: ours plain (1 run) | 69,748 | 583 | 16,839 |
| earlier, hold 1: Apple's (1 run) | 41,919 | 767 | 13,973 |

Order of the runs: Apple 1, FULL 1, NOSPIN 1, Apple 2, FULL 2, Apple 3, FULL 3, ..., `xattr=0`, NOSPIN 2, NOSPIN 3.
Untar: FULL median 40,242 against 41,410 (0.97x), mean 40,778 against 41,415; the ranges overlap (our first run is
slower than all three of Apple's, the other two faster than all three). Honest reading: equal within run-to-run
noise, not slower. rm -rf: 0.96x. find: 0.56x. Without spinning the untar is 1.35x Apple's and rm 1.24x: the
polling after each request is what closes the gap, the three request savings (69.7 s -> 55.9 s) are not enough alone.

### Walks and git status, ms, 3 runs [V]

| | stat cold | stat warm | find cold | find warm | git status warm |
|---|---|---|---|---|---|
| Apple's | 2811 2699 2749 | 1590 1569 1591 | 1402 1314 1300 | 1532 1485 1505 | 280 272 273 |
| ours FULL | 2836 2314 2344 | 560 556 546 | 370 371 379 | 347 344 354 | 225 224 226 |

With birth time kept (67k STATX requests in the cold walk) the cold stat walk is 0.85x Apple's by the median, one
run of three 1 % above Apple's slowest. (`no_statx=1` makes it 0.57 s, hold 1, at the price of the birth time.)

### Eight parallel `ls -R` walkers + git loop + stat probe, 20 s, 3 runs, FULL [V]

passes 362 381 496 (Apple's, hold 1: 28 28 22); EMFILE or other error lines 0 0 0 (Apple's 1427 915 15); longest probe
51.8 10.1 6.0 ms, probe median 0.12 ms, calls over 500 ms 0 0 0 (Apple's longest 4514 4491 4745 ms, 5-6 calls over
500 ms). Without spinning (hold 1, `no_statx=1`): 518 525 515 passes, longest probe 3.9 3.3 2.9 ms. No stall and no
error, but fewer passes and one 52 ms probe in 60 s. CORRECTION (hold 3, below): I first blamed the polling for
this; a clean interleaved A/B in hold 3 shows no cost of polling under parallel load (FULL 531 542 527 passes,
longest probe 2.9 ms). These three runs came right after Apple's stat walks in the same boot, when the VM service
still held about 48,000 descriptors of Apple's share; the lower numbers here are [G] that, not verified.

### Criterion 1: descriptors against files cached, one boot [V] (`vm/crit1.sh`)

| moment | guest fuse inodes | our nodes | descriptors in our process | descriptors in the VM service | Mac-wide open files |
|---|---|---|---|---|---|
| after boot | 127 | 1 | 5 | 63 | 6,572 |
| after `stat` of all 130k files through ours | 130,284 | 130,257 | 5 | 63 | 6,573 |
| after the same through Apple's share | 260,550 | 130,257 | 5 | 50,958 | 57,470 |
| after `drop_caches` in the guest | 164 | 1 | 5 | 78 | 6,589 |

Ours: +0 descriptors for 130,257 cached files (the five are stdin/out/err, the log, the configuration file).
Apple's: +50,895 for the same files. At the end of the hold, after 21,047,683 requests: 5 descriptors.
Two of our VMs at once (08:46-08:50, `vm/two.sh`; 2 vCPUs and 2 GiB each, the second from an APFS clone of the
disk with its own machine id and MAC address, Apple's share not attached, both serving the same folder) [V]:

| moment | VM 1: guest fuse inodes / our nodes / descriptors | VM 2: the same | Mac-wide open files |
|---|---|---|---|
| after boot | 18 / 1 / 5 | 18 / 1 / 5 | 6,763 |
| after `stat` of all 130k files in both at once | 130,266 / 130,257 / 5 | 130,266 / 130,257 / 5 | 6,638 |
| after 4 parallel `ls -R` in each (0 error lines in each) | 130,266 / 130,257 / 5 | 130,266 / 130,257 / 5 | 6,635 |

260,514 files cached by two guests, 10 descriptors in the two device processes, the Mac-wide count unchanged; each
VM service process held 19 descriptors throughout. (Apple's share in one VM: +50,895 for half as many.)
Slip on the way: a clone of the disk keeps `/etc/machine-id`, so both guests asked DHCP with the same client id
and got the same address; fixed in the clone with `systemd-machine-id-setup`.

### Criterion 4: `share-kit/coherence.py`, 3 repetitions, 32 observations per repetition, both shares [V]

Delay after the change until the other side sees it (s); every observation not listed was 0.000 on both shares:

| direction, case, what | ours FULL | Apple's |
|---|---|---|
| Mac->guest, deleted name still exists | 1.001 1.000 0.000 | 1.000 1.000 1.000 |
| Mac->guest, rename: old name still exists | 1.000 1.000 1.000 | 1.000 1.000 1.001 |
| Mac->guest, replace by rename: new data | 0.795 0.796 0.797 | 0.796 0.790 0.799 |
| Mac->guest, missing then created: data | 0.000 0.000 1.000 | 0.000 0.000 0.000 |
| guest->Mac, all 16 | 0.000 | 0.000 |

Same 1 s entry timeout on both, so the same delays; 9 late observations of 96 on each. The one case where ours was
later than Apple's (1 of 3 repetitions of "missing then created") is measured with 10 repetitions in hold 3 below.

### Conformance, same kit, same boot [V]

ours FULL: PASS 41, FAIL 5 (chown ignored; write by "other" on 0755 allowed; invalid UTF-8 name; NFD = NFC; case
folding: all five properties of the Mac volume and of Apple's owner rule). Apple's: PASS 39, FAIL 7: the same five
plus `create-mode-0` and `chmod-setuid` (set-user-id bit not kept: got 755, want 4755). Ours keeps it.
CORRECTION (09:25): keeping it is a hole when owners are faked; since then ours refuses it too (PASS 40, FAIL 6).
See "Set-id bits and the faked owner" below.

### Set-id bits with `killpriv=1` [V]

Guest: `chmod 4755 f; echo y >> f`: the guest shows 4755 right after the write and 755 after the attribute timeout;
the Mac shows 0755 at once. Apple's share shows 755 at once (it never stored the bit). So for up to 1 s the guest
believes a set-user-id bit that is already gone on the Mac: the bit is gone where the file lives, but the guest
kernel would still honour it for that second unless the share is mounted `nosuid` (how pinata mounts it: not
checked here). A difference from Apple's. Birth time on ours: shown (`stat -c %w`).
CORRECTION (09:25): pinata's colima profile sets no mount options (`launcher/backend/colima/profile.ts:25`, only
`--vm-type vz --mount-type virtiofs` [S]); the window is closed in the prototype since `setid=0` (below).

## Hold 3 of the exclusive lock (08:48:41-08:59:34): polling only for a lone caller, parallel A/B, coherence x10

Command: `vm/hold.sh hold3 walkers3way macro-solo stat-solo coh10` (scratch), same VM (4 vCPUs, 4 GiB), same kit.

New setting `spin_solo=N` (`main.m`: `note_caller()` reads the `pid` field of each FUSE request header and counts how
many requests in a row came from the same guest thread; `drain_requests()` keeps polling the empty queue for
`spin_us` only while that count is at least N). SOLO = FULL + `spin_solo=8`: the Mac burns a core only while one
guest thread is issuing requests back to back (untar, rm, a build step), not under parallel load.

### Eight parallel walkers, 20 s, three rounds interleaved NOSPIN, FULL, SOLO [V]

| | passes | error lines | longest probe (ms) |
|---|---|---|---|
| ours NOSPIN | 516 510 530 | 0 0 0 | 1.3 4.7 2.5 |
| ours FULL | 531 542 527 | 0 0 0 | 2.9 2.3 2.3 |
| ours SOLO | 522 535 520 | 0 0 0 | 2.3 2.5 2.7 |
| Apple's (hold 1) | 28 28 22 | 1427 915 15 | 4514 4491 4745 |

Polling does not cost the parallel case anything measurable. The lower FULL numbers of hold 2 (362 381 496, one
probe of 51.8 ms) are not reproduced here; worst probe over all 12 of our walker runs in holds 2 and 3: 51.8 ms.

### Create-heavy load, SOLO, ms, 3 runs, one run of Apple's in between [V]

| | untar | find | rm -rf |
|---|---|---|---|
| ours SOLO | 42,586 40,066 42,086 | 457 448 419 | 13,671 13,561 13,631 |
| Apple's (this hold, 1 run) | 41,957 | 808 | 13,311 |
| Apple's (hold 2, 3 runs) | 41,410 40,887 41,949 | 796 801 797 | 13,845 14,018 13,999 |

Untar: ours SOLO median 42,086, FULL (hold 2) median 40,242; Apple's four runs 40,887-41,957 (median 41,680). Six
runs of ours span 39,976-42,586, four of Apple's 40,887-41,957: the same within run-to-run noise (about +-3 %);
I cannot claim faster, and two of our six runs are slower than Apple's slowest by 0.4 % and 1.5 %.

### Walks and git status, SOLO, ms, 3 runs [V]

| | stat cold | stat warm | find cold | find warm | git status warm |
|---|---|---|---|---|---|
| ours SOLO | 2528 2472 2428 | 512 505 510 | 326 379 388 | 360 303 365 | 230 226 226 |
| Apple's (hold 2) | 2811 2699 2749 | 1590 1569 1591 | 1402 1314 1300 | 1532 1485 1505 | 280 272 273 |

### Criterion 4 again: `coherence.py --reps 10`, 320 observations per share, ours = SOLO [V]

Delay (s) until the guest sees a change made on the Mac, ten repetitions; everything not listed is 0.000 on both,
and all 160 guest->Mac observations are 0.000 on both.

| case, what | ours | Apple's |
|---|---|---|
| deleted name still exists | 0.000 1.001 0.000 0.000 0.000 0.000 1.000 0.000 0.000 1.001 | 1.000 x10 |
| rename: old name still exists | 1.000-1.001 x10 | 1.000-1.001 x10 |
| replace by rename: new data | 0.795-0.799 x10 | 0.794-0.799 x10 |
| missing then created: data | 0.000 1.000 1.000 1.000 1.000 1.000 1.000 0.000 1.001 1.000 | 1.001 1.001 0.000 x8 |
| late observations | 31 of 320 | 32 of 320 |

Same bound on both (1 s, the entry and attribute timeouts both servers hand out); the frequencies differ in both
directions: ours is late less often on "deleted name" (3 of 10 against 10 of 10) and more often on "missing then
created: data" (8 of 10 against 2 of 10).

Mechanism of "missing then created: data" [S, kernel 6.8 `fs/fuse/file.c` and `dir.c`, and the harness]: the guest
watcher polls the missing name without pause while the Mac does `open(..., "wb")` and then `write`. A guest LOOKUP
that lands between the two gets size 0 with a 1 s attribute timeout; the next `read()` in the guest is answered
from the cached size without a READ request, until the timeout runs out. The race exists on both servers (Apple's
2 of 10). Why ours loses it more often is [G] (our LOOKUP is one `fstatat`; Apple's opens the file, which takes
longer and so lands after the write more often): not verified.

End of the hold: 28,852,494 requests served by this device process, 5 descriptors, Mac-wide 6,947 open files.

## After hold 3 (09:04-09:11): two rules for Mac-side changes, functional check without the lock (nothing timed)

Both in `fsserver.c`, both off by default, both on in PROD = SOLO + `adapt_ttl=1 stale_gone=1`:

- `adapt_ttl=1` (`split_attr_ttl()`): in answers to LOOKUP, READDIRPLUS, GETATTR and STATX a regular file's
  attribute timeout is min(`attr_ttl`, now - ctime). A file changed 3 ms ago is valid for 3 ms, one unchanged for a
  second or longer for the usual 1 s. Answers to the guest's own CREATE, SETATTR, MKNOD, LINK keep the full timeout.
  Cost: a handful of extra GETATTRs for a file read within a second of its last change (the validity doubles
  each time), none for older files. Guest kernel: `CONFIG_HZ=1000`, so the shortest validity is 1-2 ms.
- `stale_gone=1` (in `fs_handle()` after the dispatch): when GETATTR, STATX, SETATTR, READLINK, OPEN or OPENDIR finds
  that the node no longer exists on the Mac, the answer is ESTALE instead of ENOENT. These requests carry no name,
  so ENOENT can only mean the node. Linux retries the path walk once with a forced LOOKUP on ESTALE [S: `retry_estale`
  in `vfs_statx`, `do_filp_open` and the other path syscalls], so the guest gets the new file (replace by rename)
  or a plain "No such file" (deleted) at once instead of an error from a cached name.
- After both: `vzfs confine` "ALL PASS: 0 failed" (142 requests).

Functional check [V] (`vm/fresh.sh`, `vm/fresh2.sh`, scratch; one boot, both shares mounted; delays here are the
cache timeouts themselves, not a benchmark):

| what the Mac does, what the guest does right after | ours before | ours PROD | Apple's |
|---|---|---|---|
| replaces `f` by `mv f.tmp f`; guest `cat f` | `No such file or directory` | the new content | `No such file or directory` |
| creates `m`, 2 ms later writes it; guest reads in a loop, time until data (5 runs) | 1.000 1.001 1.000 1.000 1.001 s | 0.005 0.004 0.005 0.004 0.006 s | 1.001 1.001 1.000 1.001 1.000 s |
| the same with 100 ms between create and write | not run | 0.190 x4, 0.191 s | 1.001 x5 s |
| deletes `f` that was unchanged for 1.3 s; guest `stat f` | exists | exists | exists |
| renames `r` (unchanged for 1.3 s) to `r2`; guest `stat r` | exists | exists | exists |

So: a guest program that opens a file the Mac has just replaced through a rename (how editors and `git` save) gets
ENOENT for up to a second on Apple's share and on ours without `stale_gone`; with it, the new file. The last two
rows are the cases neither rule touches: a name cached while the file was quiet stays for the 1 s entry timeout
on both shares.

## Hold 4 of the exclusive lock (09:11:56-09:19:45): the final configuration (PROD) against Apple's

Command: `vm/hold.sh hold4 prod-coh prod-macro prod-walk prod-walkers prod-conform` (scratch). PROD =
`mode=serial xattr=1 no_flush=1 killpriv=1 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1`. All [V].

### Criterion 4, `coherence.py --reps 10`, both shares in the same boot, one after the other

Delay (s) until the guest sees the Mac's change; everything not listed is 0.000; guest->Mac all 0.000 on both.

| case, what | ours PROD | Apple's |
|---|---|---|
| deleted name still exists | 0.000 x10 | 1.000-1.001 x10 |
| replace by rename: new data | 0.000 x10 | 0.793-0.799 x10 |
| missing then created: data | 0.001 0.002 0.002 0.002 0.001 0.000 0.000 0.000 0.001 0.000 | 0.000 1.000 0.000 x8 |
| rename: old name still exists | 1.000-1.001 x10 | 1.000-1.001 x10 |
| observations later than 0.5 s | 10 of 320 | 31 of 320 |

Ours is never later than Apple's in any case by more than 2 ms, and at once in two cases where Apple's takes 0.8
and 1.0 s. The one case left at 1 s on both: the old name after a rename on the Mac (the file still exists, so no
request about it fails; only the 1 s entry timeout ends it).

### Create-heavy load, ms, interleaved PROD 1, Apple 1, PROD 2, Apple 2, PROD 3

| | untar | find | rm -rf |
|---|---|---|---|
| ours PROD | 42,728 43,080 42,618 | 472 419 482 | 13,701 14,108 13,936 |
| Apple's | 42,283 43,674 | 849 833 | 13,457 13,632 |

All runs of the day, untar: ours with polling (FULL, SOLO, PROD; 9 runs) 39,976 40,066 40,242 42,086 42,115 42,586
42,618 42,728 43,080, median 42,115, mean 41,722; Apple's (7 runs) 40,887 41,410 41,919 41,949 41,957 42,283 43,674,
median 41,949, mean 42,011. rm -rf: ours (9) 13,373-14,108, median 13,631; Apple's (7) 13,311-14,018, median 13,845.
Reading: untar and rm are the same within run-to-run noise (about +-4 %); neither side is faster in a way these
runs can show. Without polling ours is 1.35x slower (hold 2). Neither new rule touches this load: its requests
contain no LOOKUP, GETATTR or STATX answer for a regular file (see the trace in hold 5).

### Walks and git status, PROD, ms, 3 runs (Apple's not re-run in this hold; see hold 5 for the same-hold A/B)

stat cold 2928 2463 2511; stat warm 508 510 509; find cold 407 324 401; find warm 392 397 394; git status 248 249 247.

### Eight walkers, PROD, 20 s x 3

passes 496 494 519; error lines 0 0 0; longest probe 13.2 2.8 3.5 ms.

### Conformance, PROD

PASS 41, FAIL 5 (the same five as before: chown ignored, write by "other" on 0755, invalid UTF-8 name, NFD = NFC,
case folding; Apple's fails these five and two more). End of the hold: 14,539,683 requests, 5 descriptors.

## Hold 5 of the exclusive lock (09:20:35-09:22:36): walks, same hold, interleaved; request trace of the untar

Command: `vm/hold.sh hold5 walk3 trace-untar` (scratch). Two rounds of Apple's, ours PROD, ours SOLO (= PROD
without `adapt_ttl` and `stale_gone`), three runs each, ms. All [V].

| | stat cold | stat warm | find cold | find warm | git status warm |
|---|---|---|---|---|---|
| Apple's, round 1 | 2655 2677 2676 | 1541 1386 1476 | 1380 1375 1283 | 1480 1453 1356 | 286 286 243 |
| Apple's, round 2 | 2723 2665 2698 | 1548 1510 1479 | 1286 1281 1380 | 1501 1468 1467 | 287 287 287 |
| ours PROD, round 1 | 2423 2437 2413 | 509 508 472 | 405 323 324 | 396 392 394 | 249 248 244 |
| ours PROD, round 2 | 2437 2469 2426 | 509 509 501 | 323 408 405 | 407 397 392 | 248 249 244 |
| ours SOLO, round 1 | 2408 2470 2428 | 505 509 510 | 406 412 409 | 390 396 394 | 246 247 249 |
| ours SOLO, round 2 | 2479 2460 2445 | 474 507 508 | 320 404 413 | 388 384 398 | 248 249 248 |
| median PROD / median Apple's | 2431 / 2676 = 0.91 | 508 / 1494 = 0.34 | 364 / 1330 = 0.27 | 395 / 1467 = 0.27 | 248 / 286 = 0.87 |

Every run of ours is below every run of Apple's except one `git status` of Apple's (243). The two new rules cost
nothing here (PROD = SOLO). Mac-wide open files after Apple's rounds: 48,835 and 48,852; after ours: 6,856-6,868.
End of the hold: 3,547,220 requests, host 2.53 us/request, 5 descriptors in the device process.

Trace under PROD (`trace=1`, four files in one folder, `tar -x` then `rm -rf`; opcodes as logged):
`3 1 35 22 16 4 22 4 4 25 18` for the first file and `3 1 35 22 16 4 22 4 4 18` for each of the others = GETATTR
(parent), LOOKUP (not found), CREATE, GETXATTR, WRITE, SETATTR, GETXATTR, SETATTR, SETATTR, RELEASE: 9 + 1 per file
as before; FLUSH (25) is sent once, answered ENOSYS and never again. `rm -rf`: `10 2 3` per file (UNLINK, FORGET,
GETATTR of the folder). No answer in the load carries a regular file's attributes through LOOKUP, GETATTR or STATX,
so `adapt_ttl` cannot add a request to it, and nothing answers ENOENT for a node, so `stale_gone` cannot either.

## Set-id bits and the faked owner (09:23-09:26, functional, no lock): a hole found, on both shares, closed in ours

`owner=1` (ours) and Apple's share both answer "this file belongs to whoever asks". The guest keeps one owner per
inode for the attribute timeout. So [V] (`vm/suid.sh`, scratch; a copy of `/usr/bin/id` with mode 4755 on the share):

| | ours before | Apple's | ours now (`setid=0`) |
|---|---|---|---|
| guest user `chmod 4755 f`: guest sees, Mac sees | 4755, 4755 | 755, 0755 | 755, 0755 |
| the Mac sets 4755: guest sees | 4755 | 4755 | 755 |
| user runs `f -u` | 1000 | 1000 | 1000 |
| root does `stat f`, then the user runs `f -u` within the timeout | **0** | **0** (bit set on the Mac) | 1000 |
| 1.2 s later the user runs it again | 1000 | 1000 | 1000 |

A guest user became root through the share whenever root looked at a set-user-id file within the last second. On
Apple's share this needs the bit to be set from the Mac side (Apple's drops it from guest `chmod`); on ours before
the fix the guest user could set it himself. Fix in `fsserver.c` (`shown_mode()`, `taken_mode()`), setting `setid`
(default 0): with `owner=1` the set-user-id and set-group-id bits are neither shown to the guest (LOOKUP, GETATTR,
STATX, READDIRPLUS) nor taken from it (SETATTR, CREATE, MKDIR, MKNOD). `setid=1` restores the old behaviour.
After the fix: `vzfs confine` "ALL PASS: 0 failed"; conformance PASS 40, FAIL 6 (the five above and `chmod-setuid`:
got 755, want 4755, the same answer as Apple's, which stands at PASS 39, FAIL 7). The fix is a mask on the mode; the
timings of holds 1-5 were taken with the binary before it, hold 6 with the binary after it.

## Holds 6 and 7 (09:28:03-09:32:16, 09:34:09-09:37:45): parallel walkers where Apple's share is NOT in trouble

Why: the kit's walkers load is the one that drives Apple's server into EMFILE, so it shows criterion 2 but says
nothing about parallel speed when Apple's is healthy. `vm/pw-guest.sh` (scratch): drop caches, eight walkers over
`tree20k` only (20,000 files; Apple's holds about 21,000 descriptors, Mac-wide 27,861-27,934), 20 s, count passes.
Commands: `vm/hold.sh hold6 pw`, `vm/hold.sh hold7 pwmodes`. Ours = PROD (with `setid=0`). All [V].

| eight walkers, 20 s, passes | Apple's | ours PROD (serial) | ours `mode=pool-direct ret_lock=1` | ours `mode=pool-hop` |
|---|---|---|---|---|
| `ls -R` (names only) | 305 299 302 | 571 576 576 | 585 | 550 |
| `ls -lR` (hold 6) | 64 64 64 | 56 56 56 | | |
| `ls -lR` (hold 7) | 64 64 | 56 52 | 48 48 | 48 48 |

No error lines anywhere. `ls -R`: ours 1.9x Apple's. `ls -lR`: OURS IS SLOWER: 7 passes per walker against 8
(the count is coarse: a walker finishes the pass it is in, so 8 means a pass takes 2.5-2.9 s and 7 means 2.9-3.3 s).
Serving on several threads makes it worse, not better (6 passes per walker), so the limit is not the Mac's
system calls running one at a time.

What `ls -l` sends [V, `trace=1` on a folder of three files, coreutils 9.4]: per entry GETXATTR (answer ENODATA; by
the answers it is `security.selinux`) and LISTXATTR (empty), on top of READDIRPLUS; both shares give the same
answers to these calls (ENODATA, empty list), so both servers get two requests per file per pass: about
8 x 40,000 requests in 2.5-3.3 s = 100,000-128,000 requests/s. That is the parallel request rate where hold 1
already showed ours behind (four callers: ours 70,000-82,000 requests/s, Apple's 117,000-142,000).
Host cost of these two requests on ours: `getxattr` and `listxattr` through `/.vol` paths, 5.34 us/request averaged
over hold 6 (against 2.5-3.0 us for attribute requests).

## Hold 8 (09:39:37-09:46:40): the fix for parallel `ls -lR`, fixed number of passes; create-heavy load again

New setting `xattr_memo=1` (`fsserver.c`: `xattr_none()`, `xa_none_set()`, `guest_names_size()`): a node with no
attribute the guest can see (`user.`, `security.`, `trusted.`) is remembered by its change time; GETXATTR and
LISTXATTR for it then cost one `lstat` instead of `getxattr`/`listxattr`. Exact, not a timeout: setting or removing
an attribute on the Mac moves the change time [V on this APFS volume: 076112922 -> 136509522 -> 201656749 ns].
Functional [V, no lock]: guest sees an attribute the Mac sets and removes at once; guest's own set/remove seen on
both sides at once; a `com.apple.` name stays hidden; `vzfs confine` ALL PASS; conformance PASS 40, FAIL 6.

FINAL = PROD + `xattr_memo=1` (and `setid=0`, the default) =
`mode=serial xattr=1 no_flush=1 killpriv=1 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1`.

`vm/pw2-guest.sh` (scratch): drop caches, eight walkers over `tree20k`, each a fixed number of passes, wall time.
Command `vm/hold.sh hold8 pw2 macro-memo`. Three rounds, interleaved, ms, no error lines [V]:

| eight walkers | Apple's | ours PROD | ours FINAL | FINAL / Apple's (medians) |
|---|---|---|---|---|
| `ls -lR`, 5 passes each | 13,421 13,207 13,245 | 15,813 15,828 15,697 | 12,857 12,774 12,795 | 0.97 (without the memory 1.19) |
| `ls -R`, 40 passes each | 20,811 20,505 20,659 | | 11,169 11,044 11,183 | 0.54 |

Create-heavy load, FINAL, ms: ours 1, Apple's, ours 2: untar 42,831 / 41,833 / 41,908; find 416 / 847 / 420;
rm -rf 13,687 / 13,894 / 13,926.

All untar runs of the day: ours with polling (11) 39,976 40,066 40,242 41,908 42,086 42,115 42,586 42,618 42,728
42,831 43,080: median 42,115, mean 41,840. Apple's (8) 40,887 41,410 41,833 41,919 41,949 41,957 42,283 43,674: median
41,934, mean 41,989. Ratio of medians per hold: 0.97 (hold 2), 1.00 (3), 0.99 (4), 1.01 (8). rm -rf: ours (11)
median 13,671, Apple's (8) median 13,870. Parity; these runs cannot show either side faster.

## Hold 9 (09:47-09:50:19): the final binary and FINAL configuration once more on the kit's tests

Command `PRODX="xattr_memo=1" vm/hold.sh hold9 prod-walkers prod-walk prod-coh`. All [V].

- Kit walkers, 20 s x 3: passes 491 503 504; error lines 0 0 0; longest probe 12.0 2.7 2.1 ms.
- Walks, ms x 3: stat cold 2419 2485 2472; stat warm 505 510 505; find cold 396 400 394; find warm 378 376 379;
  git status 245 181 253.
- Coherence x10 (320 observations per share, same boot): ours late only "rename: old name still exists"
  1.000-1.001 x10 (10 of 320 over 0.5 s; "missing then created" 0.000-0.002). Apple's 31 of 320 over 0.5 s
  (deleted name 0.999-1.001 x10, replace by rename 0.793-0.799 x10, rename 1.000-1.001 x10, missing then created
  1.001 once). Guest->Mac 0.000 on both.
- End: 8,458,484 requests, 5 descriptors in the device process.

## Result against the eight criteria

Ours = FINAL above, serial serving on the device queue. Apple's = the built-in share in the same VM (4 vCPUs,
4 GiB, Ubuntu 24.04.4, kernel 6.8.0-117-generic). Medians; ours from holds 8 and 9, Apple's from holds 5 and 8
unless said.

| # | criterion | result | numbers (ours / Apple's) |
|---|---|---|---|
| 1 | descriptors do not grow with cached files, any number of VMs | met | 5 descriptors in the device process with 130,257 files cached by the guest / +50,895; two VMs at once: 5 + 5, Mac-wide count flat (hold 2 and the two-VM table) |
| 2 | no errors or stalls under eight `ls -R` walkers | met | error lines 0 in every run of the day (3 of them with the final binary) / 15-1,427 EMFILE lines per run; longest uncached `stat` 12.0 ms in hold 9, 51.8 ms worst of the day, never over 500 ms / 4,491-4,745 ms |
| 3a | stat walk, 64k files | met | cold 2,472 / 2,676 ms (0.92); warm 505 / 1,494 (0.34) |
| 3b | `git status`, 40k files | met | 245 / 286 ms (0.86) |
| 3c | untar of 151,516 entries | met only as parity, and only with polling | 42,115 (11 runs) / 41,934 (8 runs); per hold 0.97-1.01; rm -rf 13,671 / 13,870. Without polling 55,852-55,955 (1.35x slower) |
| 3d | parallel walkers | met | kit load: 503 / 28 passes; eight `ls -R` on 20k files 11,169 / 20,659 ms; eight `ls -lR` 12,795 / 13,245 ms (0.97; 1.19 without `xattr_memo`) |
| 4 | changes cross at least as promptly | met | Mac->guest later than 0.5 s: 10 / 31 of 320; never later than Apple's; both keep a renamed-away name for 1 s; guest->Mac 0.000 s on both |
| 5 | same files, in place | met | the device serves the Mac folder itself; guest writes are on the Mac at once (160 of 160 observations at 0.000 s) |
| 6 | no change to macOS limits | met | no sysctl, no sudo, an ordinary user process with the virtualization entitlement, ad-hoc signed |
| 7 | only the shared root reachable | met for what was tested | `vzfs confine`: 142 of 142 hostile requests refused or contained (names with `/`, `..`, symlinks out, node ids, handles); not fuzzed |
| 8 | operable with a stock guest | met for the guest; conditions on the host | stock in-tree `virtiofs` driver, `mount -t virtiofs`, nothing installed in the guest. Host: macOS 27 or later, and the device must be in the configuration of the process that creates the VM: colima and lima cannot load it as they are (own runner or a lima external driver) |

Per-request round trip (hold 1, one caller, median): ours 36.5-36.7 us, with polling 27.6-29.4 us / Apple's
15.1-17.8 us. Four callers: ours 70,000-82,000 requests/s / 117,000-142,000. Host work is 2.5-6.6 us of it; the
rest is two XPC hops per request that the API does not let us avoid. Every result in row 3 is therefore won by
sending fewer requests (READDIRPLUS, no FLUSH, kill-priv on the server) or doing less work per request, not by a
faster transport.

## Open points

- Transport ceiling. A load that is bound by the request rate and where we save no requests will be slower than
  Apple's: up to 1.7x by the four-caller figures. None of the criterion-3 loads is, after `xattr_memo`; a real
  parallel compile was not run.
- Polling. Untar parity needs `spin_us=50`: one Mac core busy while a single guest thread issues requests back to
  back. Power and thermal cost not measured.
- `returnToQueue` from two threads at once stalled the queue for good, once, after 15,000 requests (hold 1). The
  final configuration never does it (everything on the device queue). Cause unknown; not reported to Apple.
- The API is new in macOS 27 and used here through `NSClassFromString` with hand-written declarations (`vz27.h`).
  Nothing was tested on another macOS build or on Intel.
- DAX window (`VZVirtioSharedMemoryRegion`): mapping works [V] under three rules found by crashes (`mapMemory:`
  only on the device queue, completion delivered there too, mappings read-write). Off in every measurement; no
  eviction policy, not benchmarked.
- Set-id bits. A guest user could become root through a set-user-id file on the share while root's answer was
  cached; found late, closed by never showing or taking the bits (`setid=0`). Apple's share has the same hole for
  bits set on the Mac. Other consequences of "every file belongs to whoever asks" were not searched for.
- Names: a renamed-away or deleted name that the guest looked at within the last second stays for up to 1 s (same
  as Apple's). An entry timeout tied to the folder's change time was not built.
- `adapt_ttl`, `stale_gone`, `xattr_memo` rest on APFS change times; other volume types (exFAT, SMB, external
  disks without `/.vol` addressing) not tested. `xattr_memo` was verified only on this volume.
- Not passed through: `flock`/POSIX locks to the Mac, ownership (`chown` ignored as on Apple's), NFD/NFC and case
  folding are the volume's.
- Production gaps: no fuzzing of the request parser; guest-controlled sizes are bounded by fixed buffers but not
  audited; no soak run (longest continuous run about 15 minutes, 28.8 million requests); the device lives in the
  VM's own process, so a crash of the server is a crash of the VM (three crashes during development, all from the
  DAX experiments); no reconnect, no live reconfiguration beyond the settings file; one share per device.
- The one slow walkers run in hold 2 (51.8 ms probe, 362 passes) was never reproduced or explained.
- lima or colima integration was not built: the runner here is a 1,270-line program of its own.

## What was created and what was removed (cleanup at 13:21)

No lima or colima instance was ever created: the lab VM ran in the prototype's own runner (`vzfs run`), so nothing
was written under `~/.lima` (absent) or `~/.colima/_lima` (holds only `_config _disks _networks colima
colima-pinata`, none of them mine, never touched). The colima profiles were never started, stopped or loaded.
docker was never called except `docker context show` at the end: `colima`.

| created | where | state |
|---|---|---|
| notes | `notes-custom-device.md` (this file) | kept |
| prototype source: `build.sh entitlements.plist fsserver.c fsserver.h fuse_abi.h main.m vz27.h` | `prototype/vzfs/` | kept, source only, no build products |
| everything else: builds, lab VM disks (`base.raw`, `disk.raw`, second VM), seed image, EFI store, ssh key, scripts, share with the kit's trees, results, confinement folders, introspection dumps (10 GB) | scratch `t1/` | removed; the empty folder is left |
| crash reports of 07:32, 07:36, 07:37 (DAX experiments): `com.apple.Virtualization.VirtualMachine-2026-11-25-073256.ips`, `-073737.ips`, `vzfs-2026-11-25-073600.ips` | `~/Library/Logs/DiagnosticReports/Retired/` | removed |
| crash reporter entries `vzfs_<host id>.plist` and `com.apple.Virtualization.VirtualMachine_<host id>.plist` (born 07:32:56) | `~/Library/Application Support/CrashReporter/` | removed |
| exclusive lock, nine holds | scratchpad `exclusive.lock/` | released each time, last at 09:50:19 |

Processes at the end: no `vzfs`, no ssh control master, no watchdog (it was a thread inside `vzfs`), no sampler.
Not removed because not mine (no trace of creating them in this track's transcript): `dump.py`, `dump2.py`, `rt.py`
in the scratchpad root (06:49-06:50).
