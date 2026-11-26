# Notes: kernel side of virtiofs fd growth (research agent)

Sources: raw files from github.com/torvalds/linux at tags v6.8, v6.12, v6.15-v6.19, v7.0, master (= 7.4-rc4 on 2026-11-25).

## Q1 inode lifetime
- fuse_super_operations `.drop_inode = generic_delete_inode` in v6.8, v6.12, v6.16, v6.17 (fs/fuse/inode.c). v6.18+: renamed `inode_just_drop` (same semantics, returns 1). Master line 1235.
- iput_final (fs/inode.c v6.12 l.1837): drop=1 -> no LRU, evict immediately -> fuse_evict_inode -> if fi->nlookup: fuse_queue_forget (master: fuse_chan_queue_forget). Only if SB_ACTIVE (not on umount).
- virtiofs: send_forget = virtio_fs_send_forget -> single FUSE_FORGET per inode on hiprio vq, async, no reply; queued on fsvq->queued_reqs if vq full. No BATCH_FORGET in virtio_fs.c.
- => inode lives exactly as long as some dentry (or open file etc.) pins it. The dentry cache is the lever.

## Dentry delete behaviour (surprise)
- fuse_dentry_delete returns "expired"; but fuse_dentry_settime clears DCACHE_OP_DELETE whenever time!=0, so d_delete is consulted only for time==0 with delete_stale (virtiofs sets fc->delete_stale = true). So: if server returns entry_valid=0, dentries die at last dput -> FORGET immediately. If entry_valid>0, unused dentries stay on sb LRU indefinitely (until memory pressure / drop_caches / umount), even after expiry. Accumulation of 43k fds implies Apple returns entry_valid>0.

## Q2 remount
- reconfigure_super calls shrink_dcache_sb(sb) unconditionally (v6.8 l.1049; master l.1075), before fc->ops->reconfigure, which is optional (`if (fc->ops->reconfigure)`).
- virtio_fs_context_ops: .free, .parse_param, .get_tree only (v6.8 l.1485; master l.1815). No .reconfigure -> remount succeeds, options parsed then ignored (dax change silently not applied); unknown option -> EINVAL from fs_parse.
- do_remount (master fs/namespace.c l.3506): needs path to be mount root, ns_capable(sb->s_user_ns, CAP_SYS_ADMIN), calls reconfigure_super then set_mount_attributes(mnt, mnt_flags) (legacy remount resets per-mount flags to what is passed).
- remount,bind -> do_reconfigure_mnt: only mount flags, no reconfigure_super, no shrink.
- shrink_dcache_sb (fs/dcache.c v6.12 l.1200): list_lru_walk of sb->s_dentry_lru until empty: only unused (refcount 0) dentries.

## Q3 periodic expiry
- inval_wq: commit ab84ad597386 "fuse: new work queue to periodically invalidate expired dentries" (author date 2025-09-16), first in v6.19 (absent in v6.18 dir.c, present in v6.19). Module param `inval_wq` (uint, 0644, secs, 0=off default, min 5, max USHRT_MAX). Global (all fuse sb incl. virtiofs, code in dir.c shared). Only dentries whose entry time expired; tree only populated when inval_wq != 0 at settime time.
- epoch: FUSE_NOTIFY_INC_EPOCH in v6.16 (dev.c fuse_notify_inc_epoch: atomic_inc only, comment "XXX optimization: add call to shrink_dcache_sb()?"). 64becd224ff9 "fuse: new work queue to invalidate dentries from old epochs" (v6.19): epoch work calls shrink_dcache_sb. Server-initiated; Apple's server would have to send it -> not usable.

## Q4
- dentry_cache SLAB_ACCOUNT (dcache.c v6.12 l.3185); fuse_inode SLAB_ACCOUNT|SLAB_RECLAIM_ACCOUNT (inode.c l.2050). sb shrinker SHRINKER_NUMA_AWARE|SHRINKER_MEMCG_AWARE, list_lru_init_memcg for dentry & inode lru (super.c l.378-390).
- drop_caches 2: drop_slab() all shrinkers all memcgs (fs/drop_caches.c).
- vfs_cache_pressure_denom sysctl: absent v6.15, present v6.16 (v6.17 fetch returned 0, likely rate-limit), master.
- fuse tracepoints fs/fuse/fuse_trace.h: absent v6.11, present v6.12 (fuse_request_send/sent/end, opcode only, no payload).

## Q5 pins
- inotify: fsnotify_get_inode_ref -> ihold (fs/notify/mark.c v6.8 l.119). Pins inode -> fd kept even after dentry pruned.
- shrink_kill cascades to parents (dcache.c v6.12 l.1056).

## Q6 Apple
- Apple forum 741572 (Nov 2023-): Apple engineer Benjamin: "Unless the guest sends FUSE_FORGET, there is no harm in keeping them around for performance. When the number gets close to the process limits, they are being recycled." FB13640480; DTS Quinn Dec 2024: significant changes in macOS 15; May 2026: FB effectively closed; ~Nov 2026 gearsetdave FB25600630 macOS 26.7.3, workaround drop_caches.
- apple/container #1097 (Jan 2026, open): dcantah Apr 1 2026 "The device holds open FDs right around until the value of kern.maxfilesperproc" then purges. -> self-limit = maxfilesperproc, so 2 VMs x 61,440 = 122,880 = maxfiles here.
- sprout #81 (2026-11-19, macOS 27.0.1, vfkit): 137,808 -> 983 after drop_caches.
- safeyolo #416 (2026-08-28): 52,113 fds; drop cache 10,092 -> 47.
- docker/desktop-feedback #218 (2026-03-20): 30 -> 230,000 fds.
- claude-code #92510 (2026-09-06, macOS 26.4/26.6.2): ~409,600 fds, kernel panics "vnode: table is full". Note: exceeds maxfilesperproc? their maxfilesperproc unknown.
- docker/for-mac #7059: Docker DD 4.28 avoids caching entries for nlink>1 (hardlink bug), unrelated.

## Extra
- fspick()+fsconfig(FSCONFIG_CMD_RECONFIGURE) -> vfs_cmd_reconfigure -> reconfigure_super (fs/fsopen.c master l.254): same shrink, no set_mount_attributes.
- per-sb drop_caches (Ye Bin v1 Oct 2024, v2 Nov 2025) NOT in master (drop_caches.c 98 lines, no reclaim_dcache_sb).
- fusectl files: waiting, abort, max_background, congestion_threshold only.
- virtiofs non-ENOSPC virtqueue error drops FORGET silently.
- entry_valid observable via kprobe_events on fuse_change_entry_timeout, arg2 +16 (u64 entry_valid), +32 (u32 nsec). Symbol exists 6.8 dir.c l.112.
- fc->auto_submounts = true for virtiofs: host submounts become separate guest sbs (only if server sets FUSE_ATTR_SUBMOUNT) -> remount each.

## Q7
- colima-core dependencies.env: UBUNTU_VERSION=24.04 noble minimal cloud image -> linux-image-virtual 6.8.0-151 (manifest 2026-11-24). colima-core v0.10.4 2026-06-03. 6.8 => no inval_wq, no epoch, no fuse tracepoints, no vfs_cache_pressure_denom.
- lima v2.3.0 (2026-11-06): default.yaml base template:_images/ubuntu -> ubuntu-26.10 (kernel 7.3.0-9); ubuntu-lts -> 26.04 (7.0.0-43). Both have inval_wq.
