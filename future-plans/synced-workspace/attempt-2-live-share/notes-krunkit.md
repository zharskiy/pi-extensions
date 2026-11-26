# krunkit / libkrun virtio-fs deep dive (notes, 2026-11-25)

[V] = verified in source/primary doc, [I] = inferred, [U] = unverified.

## Versions
- libkrun latest release v1.19.8 (2026-11-06, tag on stable-1.19.x). main HEAD 715c1c98 (2026-11-24). [V gh api]
- krunkit v1.3.2 (2026-07-03); main has one later commit (virtio-blk sync option, 2026-10-14). [V]
- Homebrew core: krunkit 1.3.2 depends on libkrun 1.19.8 (`brew info`, homebrew-core). [V local]
- PR #988 (share one host fd across read-only handles) merged to main 2026-11-18 (commit 75cbc4e3/eb854670). NOT in v1.19.8; stable-1.19.x after v1.19.8 has only a gpu test commit -> unreleased. [V compare v1.19.8...stable-1.19.x]

## Descriptor model (main passthrough.rs, same in v1.19.8 minus #988)
- Inode map: MultikeyBTreeMap<Inode,(dev,ino),Arc<InodeData>>; InodeData = ino, dev, refcount, unlinked_fd (-1), read_only_file (Weak, main only). No fd per inode. [V L53-62]
- lookup: name_to_path -> "/.vol/{dev}/{parent_ino}/{name}" -> lstat(); in Complete mode also listxattr+getxattr(user.containers.override_stat). No open. [V L1456-1525, L492-529]
- getattr: lstat("/.vol/dev/ino") (+xattr in Complete). [V L957]
- open/opendir: open("/.vol/dev/ino") per handle, closed on RELEASE (Arc drop). Main: read-only non-dir handles of an inode share one fd. Dirs: one fd per open dir handle; readdir does dup+fdopendir, reads the whole dir into memory (Vec of names) then closedir. [V L98-154, 858-940]
- unlink/rmdir and rename-over-target: BEFORE unlink, openat(parent, name, O_NONBLOCK) and store fd in unlinked_fd of the tracked inode; closed when guest FORGETs the inode (refcount 0). => one host fd per guest-deleted (or guest-overwritten) inode that the guest still has cached, until FORGET. [V L1008-1074, L2039+, forget_one L1311]
- Only guest-initiated deletes; host-side deletes leave the guest's inode with a dangling /.vol path -> ENOENT. [V/I]
- Single "fs worker" thread per virtio-fs device, one request queue + one hiprio queue, QUEUE_SIZE 1024. [V worker.rs, mod.rs]

## Cache policy
- Config default entry_timeout=5s, attr_timeout=5s, cache_policy Auto (close-to-open), writeback false. [V L624-640]
- v1.19.8 device.rs: attr_timeout = 0 when semantics == LinuxSimplified (krunkit default since 1.3.0), else 5s. entry_timeout stays 5s. [V dev-1198 L79-85]
- krunkit calls krun_add_virtiofs4(tag, path, shm_size=0, read_only=false, semantics); no cache/timeouts knobs; permissionSemantics=complete|simplified, default simplified. shm 0 => no DAX. [V krunkit src/virtio.rs]
- main adds set_cache_policy / set_cache_timeouts (commit 6cc876d9, 2026-10-29) - unreleased, not exposed by krunkit. [V]
- Server advertises AUTO_INVAL_DATA, PARALLEL_DIROPS, READDIRPLUS(_AUTO); not POSIX_LOCKS/FLOCK_LOCKS; getlk/setlk stubs. [V server.rs L898]
- lookup error -> reply_error (no zero-ino negative entry) => guest negative dentries not cached by timeout. [V server.rs L201-211; kernel behaviour I]

## Permissions
- Complete: host file created 0600 / dirs 0700, real uid:gid:mode in xattr user.containers.override_stat; host-created files show host uid/mode. [V L1697-1735, 1571]
- Simplified (krunkit default): stat reports requester's uid/gid (ctx.uid), chown is a silent no-op, chmod goes to host mode. [V L384-404, 470-476]
- xattr: v1.19.8 xattrs on in every mode (Config default xattr:true; com.apple.* hidden); main turns xattr off unless Complete. [V]

## Issues / PRs (libkrun unless noted)
- #888 open 2026-09-30: host replace-by-rename -> guest ENOENT up to entry_timeout (5 s); measured 0.2-4.7 s vs 22 ms-1 s on vz; git HEAD/refs/index affected, can rewind branch. Asks ESTALE. No fix PR found. [V]
- #974 merged 2026-11-18 (main): krun_fs_device_set_cache_timeouts; default unchanged 5000 ms; not in 1.19.8, not in krunkit. [V]
- #939 open 2026-10-23: CachePolicy::Auto -> every guest open() drops the file's page cache (no FOPEN_KEEP_CACHE), incl. mmapped pages of other processes. Reported on Linux backend; macOS do_open same code (opts empty for Auto). Fix PR #972 open, Linux only (macOS treats KeepUnchanged as Auto). [V]
- #924 open: virtiofs small-file metadata 10-30x slower than tmpfs (Linux host, 1 queue/1 thread/writeback=false); slp: multi-threading barely helped; plans "doing the operations synchronously". [V]
- #910 open: all shares ECONNREFUSED on macOS (krunkit 1.3.2/libkrun 1.19.6), not reproduced by maintainer; reporter later could not reproduce. [V]
- #990 open 2026-11-08: vsock host->guest unix conns hold host fd 5 s after close; with soft limit 256 -> EMFILE, virtio-fs in same VMM fails too ("rm -rf ... Directory not empty"). Reported on macOS 27.2, 1.19.8. [V]
- #505 open: Linux PassthroughFs fd per inode (O_PATH) - Linux only. [V]
- #953 open: "confined macOS path resolution" backend pinning tracked inodes with owned fds (fd per inode!), direct I/O, zero timeouts; test-only. If ever default -> loses the fd bound. [V]
- #329 open 2025-05: share escape on Linux backend (guest-supplied names trusted). macOS backend: name_to_path formats "/.vol/dev/ino/{name}" with no check for "/" or ".." -> guest kernel can address outside the share [I from source; #953 motivation confirms "global /.vol paths"]. 
- #977 open RFC: host-enforced write policy (protect .git/hooks/config from guest). [V]
- PR #988 label cherry-pick-1.19.9 -> expected in a future v1.19.9. [V]
- lima #5798 open 2026-11-13: krunkit driver stops with SIGTERM (--restful-uri none://) = power cut; guest file written before stop lost, ext4 recovery; also guestagent delays shutdown 90 s. Fix lima PR #5814 merged 2026-11-24 (after lima 2.3.0 of 2026-11-06) -> unreleased. This is the "data loss on stop" basis (VM disk, not the share). [V]
- lima #5085 closed 2026-10-21: systemd>=259 guests failed to boot with ssh.overVsock. [V]

## Lima / colima / podman
- lima docs: krunkit experimental, Lima >=2.0, macOS 14+ (driver code checks 13+), arm64 only; external driver lima-driver-krunkit (present in local lima 2.3.0). [V]
- lima driver v2.3.0 cmdline: no permissionSemantics (=> simplified), no --timesync, --restful-uri none://, virtio-net via gvisor usernet (unixgram fd) or socket_vmnet for shared/bridged, vsock for guest agent (2222) and ssh over vsock; raw disk only; no blockDevices, no tpm; nested virt needs macOS 15; snapshots only stopped. Stop = SIGTERM, SIGKILL after 30 s. [V]
- colima: krunkit added v0.10.0 (2026-02-10, "with gpu support"); v0.10.2 (2026-06-03) nested virt + network address for krunkit; v0.10.3 latest (2026-06-04). Requires Apple Silicon, macOS 13+, krunkit installed (README points to krunkit install). colima uses vmnet daemon for krunkit only when --network-address. Rosetta flag is vz-only. colima has --mount-inotify (host->guest event propagation daemon). [V]
- Homebrew core: krunkit 1.3.2, Apache-2.0, deps libkrun -> libkrunfw, libepoxy, molten-vk. [V local]
- podman 6.0.0 (2026-06-24): libkrun default provider on macOS (PR #27546 merged 2025-11-20). [V]
- libkrun: Apache-2.0, top contributor slp (Red Hat), 1.19.1..1.19.8 between 2026-06-24 and 2026-11-06 (8 releases); main is 2.0.0-dev. [V]
- launchctl maxfiles here: 256 soft / unlimited; kern.maxfilesperproc 61440. lima hostagent raises its own NOFILE Cur to Max; whether krunkit inherits a high soft limit is [U] (Go darwin behaviour with Max=unlimited). krunkit and libkrun do not call setrlimit (code search). [V search, U effect]
- lima PR #5814 merged 2026-11-24 (REST Stop for krunkit) - unreleased in lima 2.3.0; colima 0.10.3 uses lima's driver. krunkit #112 (skip shutdown eventfd without REST) open. [V]
- No krunkit-vs-vz virtiofs benchmark found (web search 2026-11-25). [U]

## Verdict (opinion)
Not fit to replace vz today. fd bound holds by construction (no fd per cached inode), but: #888 rename ENOENT window (no knob in any release), VMM fd limit (256 soft unless raised) with no #988 in 1.19.8 and #990 vsock fd hold, Simplified chown no-op, stop data loss until lima > 2.3.0, experimental in lima, unconfined /.vol name resolution. Re-evaluate at libkrun 1.19.9/2.0 + krunkit exposing cache timeouts + lima release with #5814.
