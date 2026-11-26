# Hardening the vzfs file server (track T9)

Marks: [V] verified by a test run here, [S] read in source, headers or disassembly, [G] guessed.
Machine: macOS 27.2 (26B123), APFS, arm64. Code: `prototype/vzfs-hardened/` (a copy; `prototype/vzfs` untouched).
Scratch builds and trees: `$TMPDIR/.../scratchpad/t9` (emptied at the end).

## 1. What the kernel offers

Header values (SDK 26.1) [S]: `O_RESOLVE_BENEATH 0x1000`, `O_UNIQUE 0x2000`, `O_NOFOLLOW_ANY 0x20000000`,
`AT_SYMLINK_NOFOLLOW_ANY 0x0800`, `AT_RESOLVE_BENEATH 0x2000`, `AT_UNIQUE 0x8000`, `FSOPT_NOFOLLOW_ANY 0x800`,
`FSOPT_RESOLVE_BENEATH 0x1000`, `RENAME_NOFOLLOW_ANY 0x10`, `RENAME_RESOLVE_BENEATH 0x20`,
`XATTR_NOFOLLOW_ANY 0x40`, `XATTR_RESOLVE_BENEATH 0x80`.

Probe (`probe.c`, a root folder with `lnk -> ../outside`, `lnkin -> a`, `abs -> /etc`, last-component links) [V]:

| call | RESOLVE_BENEATH | NOFOLLOW_ANY |
|---|---|---|
| openat (O_*) | yes: `..` out, link out, absolute path or link give `ENOTCAPABLE` (107) | yes: any link in the path gives `ELOOP` (62), last component included, also with O_CREAT through a link |
| fstatat (AT_*) | yes, same | yes; a last-component link is **not** refused by fstatat (it stats the link) |
| getattrlistat / setattrlistat (FSOPT_*) | yes | yes |
| fchmodat, fchownat, utimensat (AT_*) | yes | yes |
| unlinkat (AT_*, with AT_REMOVEDIR too) | yes | yes |
| linkat (AT_*), both names checked | yes (source and target) | yes |
| renameatx_np (RENAME_*), both names, RENAME_SWAP too | yes | yes |
| getxattr/setxattr/listxattr (XATTR_*), relative to cwd | yes, beneath the cwd (per-thread `pthread_fchdir_np(root_fd)` works) | yes |
| mkdirat, symlinkat, readlinkat, mkfifoat, mknodat, bind | no flag: `mkdirat(root, "lnk/made")` created `outside/made` | - |

Other facts [V]:
- `O_NOFOLLOW | O_NOFOLLOW_ANY` together is `EINVAL`; `O_SYMLINK | O_NOFOLLOW_ANY` opens a last-component link itself.
- `a/../a/b/f` with BENEATH is allowed (the `..` stays inside); `..` from the root is refused.
- `""` gives ENOENT (no AT_EMPTY_PATH); use `"."` for the root.
- A held directory fd follows its directory when the Mac moves it out of the share; `fstatat(dfd, "../x", RESOLVE_BENEATH)` is refused, beneath that fd only.
- So any fd the server holds on a directory is a capability that escapes with the directory; the fix is to resolve every request from `root_fd`, never from a cached directory fd or `/.vol`.
- Calls without flags (mkdirat, symlinkat, mknodat, mkfifoat, bind, readlinkat) are made safe by first opening the parent with `O_SEARCH|O_DIRECTORY|O_RESOLVE_BENEATH|O_NOFOLLOW_ANY` from `root_fd`, then calling with one validated name (no `/`, not `.`/`..`). One name can't go anywhere but that directory. bind uses `pthread_fchdir_np(parentfd)` plus a relative name.

## 2. Cost at depths 3, 10, 20 (`bench.c`, 1 thread, ns per call) [V]

| call | d3 | d10 | d20 |
|---|---|---|---|
| lstat `/.vol/dev/ino` (current GETATTR) | 1254 | 1194 | 1578 |
| lstat `/.vol/dev/pino/name` (current LOOKUP) | 1283 | 1422 | 1769 |
| fstatat(root, path, BENEATH\|NOFOLLOW_ANY) | 601 | 646 | 909 |
| fstatat(root, path, plain) | 600 | 707 | 970 |
| getattrlistat(root, path, BENEATH) dev,ino,parent | 750 | 700 | 965 |
| open+close `/.vol/dev/ino` (current OPEN) | 9911 | 9900 | 11945 |
| openat+close (root, path, BENEATH) | 9033 | 9545 | 11730 |
| open parent O_SEARCH + fstatat + close | 2323 | 2461 | 2492 |
| getxattr `/.vol` (absent) | 7722 | 8789 | 10686 |
| getxattr relative, cwd=root, BENEATH | 6591 | 8085 | 9720 |

With 4 threads, all rows are 2-4x slower in both forms, and the ratio is unchanged (the machine was shared with a benchmark run).
- Resolving from the root fd with the flags costs **less** than `/.vol` (0.6-0.9 µs against 1.2-1.6 µs). The flags themselves cost nothing measurable.
- A `/.vol` lookup pays for a by-id lookup that the path walk avoids while the name cache is warm [G for the cause].
- The added user-space cost is building the path from the node table: a walk of at most `depth` rows, under 0.1 µs at depth 20 [G, not timed in isolation].
- The 2.5-6.6 µs of host work per request does not grow; GETATTR and LOOKUP get about 0.5 µs cheaper.
- The parent-open form (only for mkdir, symlink, mknod and bind) costs about 2.4 µs, on ops that cost 10 µs or more already.

## 3. Apple's server: fsync

[S, disassembly of `com.apple.Virtualization.VirtualMachine`, arm64e]: the two FUSE FSYNC handlers call plain `fsync(fd)`, retried on EINTR.
- `F_FULLFSYNC` (0x33) and `F_BARRIERFSYNC` (0x55) appear only in helpers called from block-device and disk-image code, never from the FUSE handler region.
- The FUSE region's fcntls are F_GETFL, F_PREALLOCATE and F_PUNCHHOLE.

## 4. Design: every request resolves from the share's root descriptor (implemented)

`prototype/vzfs-hardened/fsserver.c` [S, own code; tests in section 8 are V]:
- **Identity and place.** A node is identified by (dev, ino, type) only. Its place is (parent node, name), and after a recovery it is (ROOT, a multi-component rest). The path is built under the table lock by walking parents, with root as `.`. The limit is MAXPATHLEN; beyond it the request gets ENAMETOOLONG. A cycle, or a chain deeper than 512, puts the node at (ROOT, full path).
- **Resolution.** Every path call is `*at(root_fd, path, …)` with `AT_RESOLVE_BENEATH|AT_SYMLINK_NOFOLLOW_ANY` (or the O_, RENAME_ and XATTR_ forms). Xattr calls run with the thread's cwd set to `root_fd` (`pthread_fchdir_np`). `/.vol` is gone. `fs_new` refuses to start unless `fstatat(root_fd, "..", AT_RESOLVE_BENEATH)` gives ENOTCAPABLE.
- **Check and recovery.**
  - Each node op checks the object it reached: open+fstat, or lstat, against (dev, ino).
  - On a mismatch, ENOENT, ENOTDIR, ELOOP or ENOTCAPABLE, it recovers once. Recovery is `fsgetpath(root_fsid, ino)`; the result must start with `F_GETPATH(root_fd)/`, and `fstatat` beneath must give the same identity. The new place is then (ROOT, rest). Anything else gives ENOENT, which becomes ESTALE with stale_gone.
  - Name ops (LOOKUP, CREATE, UNLINK, RENAME, LINK) retry once after the parent's place is recovered (`path_stale` errors).
- **Calls with no flag** (mkdirat, mkfifoat, symlinkat, bind, and now CREATE too): they run on `dir_open`, an `O_SEARCH|O_DIRECTORY` open of the parent beneath root whose identity is checked, with one validated name. bind is relative to the cwd set to that fd. CREATE moved to this form after the race test (section 8) showed that `openat(root, "dir/name", O_CREAT)` puts files into a different directory that the Mac renamed to the old name between the check and the open.
- **OPEN and TRUNC.** OPEN drops O_TRUNC until the descriptor's identity has been checked, then calls `ftruncate`. READLINK uses `O_SYMLINK` beneath, then `freadlink`.
- **RENAME.** `renameatx_np(root, from, root, to, flags|RENAME_RESOLVE_BENEATH|RENAME_NOFOLLOW_ANY)`. The moved object is found by the (dev, ino) taken before the call, and only its row gets a new place (with SWAP, both rows). **O(1)**, whatever its subtree: descendants are placed relative to it.
- **Why it is sound (one sentence).** The kernel refuses any path from `root_fd` that leaves the root or crosses a symlink, the server never holds a directory descriptor across requests (only per-request `dir_open`, and open handles), and a stale place costs one by-inode lookup that is accepted only inside the root, so every name the server touches is inside the share at the moment of the call.

### Cases
| case | behaviour | mark |
|---|---|---|
| Mac renames a file or directory | the next op on that node misses (ENOENT/mismatch), recovers via fsgetpath once, and the place becomes (ROOT, new rest); children keep (dir, name) and follow | V (confine "moved back under another name", fuzz recovered counter) |
| Directory moved out of the share, then back | while out: every op on it and its children is refused (prefix check fails) and the outside copy is unchanged; after the move back: recovered | V (18 confine cases) |
| Guest renames a directory with many known children | one row changes. Guest RENAME with 2000 known children took 45.6 µs (best of 10) against 46.7 µs for an empty directory; APFS's own rename is 46 µs | V |
| Hard links | one node per (dev, ino), placed at the name of the latest reply. If that name goes away, recovery picks the link fsgetpath returns; if that link is outside the share, ESTALE, and the guest's re-lookup of another inside name finds the same node again | V (confine "file linked back": fsgetpath gave the outside link, so ESTALE) / S |
| Open file renamed by the guest | the handle's fd is unaffected; the node is moved by node_moved | S |
| Open file renamed or moved out by the Mac | READ and WRITE through the handle keep working: the fd follows the file, out of the share too. That is a window (see below) | S, probe V for directories |
| Open file unlinked by the guest | READ, WRITE and GETATTR with fh use the handle (the handle fallback comes before ESTALE); with no_open, keep_orphan holds up to 1024 | S |
| Inode reuse | APFS file ids come from a per-volume counter and are not handed out again [G]. If one were, recovery would accept the new file. Designed, not built: keep `st_birthtimespec` in the row as a generation | G |
| Case and normalisation (APFS insensitive) | `Sub` and `sub`, NFC and NFD é: the same (dev, ino) gives the same node, with the place at the spelling last replied, which resolves to the same object. The fuzzer sends such names | S, fuzz V (no crash or escape) |

### Windows left
1. **Mac-only race inside one request.** The Mac moves a directory out after `dir_open` checked it and before the `*at` call on that fd (mkdir, mknod, symlink, create). One new entry then lands in the moved-out directory. The window is microseconds and needs the Mac user to move that directory at that instant; nothing is read from outside. Not seen in 20,000 raced requests (section 8).
2. **Root-relative calls after a check** (chmod, chown, utimes, xattr, unlink, rename, link): they are always confined by the kernel, but between the check and the call the Mac can put a different object at the path, so the wrong inside object may be hit. This is a coherence issue only, the same as any path-based server.
3. **Open handles** (files and directories) keep their object after the Mac moves it out. Reads, writes and listings go on through the fd. Designed only: a strict mode that checks `F_GETPATH` of the handle fd against the root at each READ/WRITE/READDIR (about 1 µs [G]).
4. **LOOKUP success does not check the parent's identity.** A Mac swap of the parent for another inside directory answers from the new one. Coherence only.

## 5. Descriptor bound (B, implemented)
- `main.m`: `setrlimit(RLIMIT_NOFILE, 8192)` at start [S, compiled]. That is far below the system's 122,880 and the per-process 61,440.
- `max_handles` (fs_config, `--set max_handles=N`, 0 = 4096): handle_new refuses beyond it, and OPEN, CREATE and OPENDIR answer ENFILE (Linux 23) [V: confine, 64 open and 16 ENFILE; fuzz, handles stayed at ≤ 512].
- Descriptors at most: 4096 handles + 1024 kept orphans + 256 fd-cache slots + root, VM and a few others, about 5.4k < 8192 [S]. With `bulk=0`, each directory handle holds one more dup for its DIR (up to 4096 more); beyond the rlimit, opens then get EMFILE as an error [S, not tested].
- Listings are streamed: getattrlistbulk in batches with a buffer of about half the reply room (4K-128K); readdir mode keeps a DIR [V: 2000 names in 73 requests, each name once].
- Memory: forgotten nodes free their name and are freed up the parent chain; released handles free their snapshot [V: node count fell by exactly 2000 after the forgets, handle count back to its start]. The chunks of the tables are high-water and are not returned [S].
- Not built: an LRU of read-only descriptors (optional).

## 6. Item 4: READDIRPLUS with stale attributes (fixed)
- **Cause [S, Linux fs/fuse/readdir.c and inode.c].** `fuse_readdir_uncached` takes `attr_version` when it sends the request. `fuse_change_attributes` drops a direntplus attribute only if the inode's attr_version is newer than that. A snapshot read at offset 0 and served in a later request therefore carries attributes older than the request, and the kernel accepts them, overwriting newer ones (for example the size after a write).
- **Fix.** Only entries read during this request carry their bulk attributes. Entries left over from an earlier request are re-read with `fstatat(dirfd, name)` before going out. In snapcache mode they go out with nodeid 0 (the kernel then does not touch attributes).
- **Test [V].** Confine: a first READDIRPLUS leaves entries, the Mac truncates all 2000 files to 7 bytes, and a second READDIRPLUS reports size 7 for every entry with attributes (7 entries checked).

## 7. Item 5: fsync and stale_gone
- **fsync.** Apple uses plain `fsync` in its FUSE handlers (section 3, S). F_FULLFSYNC would make every guest fsync a full device flush, several ms on Apple SSDs [G]. Kept as plain fsync, matching Apple. No change.
- **When stale_gone's ENOENT to ESTALE mapping is right or wrong [S, own reading of fs_handle].**
  - Right for ops that name only a node (GETATTR, STATX, SETATTR, READLINK, OPEN, OPENDIR) when the node's object is gone or outside the share. The guest's VFS then re-looks the name up once.
  - Wrong, and not done:
    - For an open file the guest unlinked: the handle fallback answers first.
    - For name ops (LOOKUP, UNLINK, RMDIR, RENAME, CREATE): ENOENT there means the name is absent, and ESTALE would make Linux retry for nothing, or fail a lookup that should create a negative dentry.
  - **Caveat.** Linux retries an ESTALE only once (`LOOKUP_REVAL`). If the Mac moves the object again between the two attempts, the guest sees ESTALE. That is rare and harmless.

## 8. Tests (all on the final source, 2026-11-25)
- **confine** with the FINAL settings applied (`xattr=1 no_flush=1 killpriv=1 adapt_ttl=1 stale_gone=1 xattr_memo=1`): ALL PASS, 0 failed, 277 PASS lines [V].
  - Cases added:
    - forged and mismatched fh on READ, WRITE, READDIRPLUS, FSYNC, LSEEK and FALLOCATE;
    - forged nodeids on SETATTR, READLINK, LINK, RENAME2 and GETXATTR;
    - LINK of a directory or the root;
    - RENAME2 exchange variants;
    - truncated and oversized requests;
    - the moved-out directory (18 ops refused, the outside copy unchanged, recovery after moving back);
    - a file moved out and linked back (ESTALE, INFO);
    - an ancestor swapped for a symlink;
    - a rename with 2000 known children;
    - the streamed listing (2000 names exactly once, alternating READDIR and READDIRPLUS);
    - READDIRPLUS freshness;
    - nodes and handles freed;
    - max_handles=64 (64 OK, 16 ENFILE);
    - the rename race.
  - Race result [V]: 313 swaps; 1684 requests allowed, 18316 refused. 0 requests were allowed while the directory was outside for the whole request, the decoy is untouched, and 0 reads returned decoy content.
- **selftest** on the worktree: 1555 entries compared, 0 mismatches [V].
- **hostwalk** of `<repo>` (95,681 entries, 32,900 requests, FINAL settings, 1 thread):
  - Earlier on a quiet machine: hardened 0.203 s against orig 0.190-0.196 s.
  - Rerun on the final source while the machine was loaded (alternating runs): hardened 0.286-0.319 s, orig 0.279-0.323 s.
  - At most 3-7% slower, within noise under load [V].
- **fuzz** (`prototype/vzfs-hardened/fuzz.c`):
  - Build: UBSan with `-fno-sanitize-recover`, plus `MallocScribble/PreScribble/GuardEdges/ErrorAbort`. ASan hangs at start-up on this macOS, even for hello world [V].
  - The Mac side runs all the time: moves sub out and back, swaps d for a symlink into the sentinel, replaces f.
  - Each run checks, before and after:
    - the sentinel checksum;
    - base and outside entries;
    - the handle cap;
    - a 5 s watchdog per request.
  - Runs [V]:
    - seeds 7, 8, 9 and 10: 6,000,000 requests each with 3 threads, PASS, sentinel unchanged, handles at most 512 (the cap), descriptors 1044, about 70k ENFILE;
    - seed 11: 2,000,000 requests with 1 thread, INIT included, PASS;
    - in total 26M requests after the fixes, plus about 2.6M before them.
  - **Findings and fixes:**
    1. **Server: queue thread blocked on a FIFO.** node_open, CREATE and mknod-reg opened whatever was at the path in blocking mode. A FIFO put there by the guest or the Mac blocks the queue's thread until a writer comes. Now every path open is `O_NONBLOCK` until the identity check, and then the flag is cleared. CREATE also refuses non-regular files with ENXIO [V: the hang is gone]. The original vzfs has the same problem (it opens `/.vol` paths blocking).
    2. **Server: FALLOCATE ran for more than 5 s.** zero_range wrote zeros over a sparse range of any size (PUNCH_HOLE/ZERO_RANGE when F_PUNCHHOLE fails), and `offset + length` could overflow. zero_range now skips holes (SEEK_DATA/SEEK_HOLE), and the range is checked as in Linux's vfs_fallocate (EFBIG/EINVAL) [V: seeds 9 and 10 pass]. This was in the original too.
    3. **Harness, not server:** the fuzzer's Mac thread did `chmod(d)` after d had become the symlink, which changed the sentinel's ctime (a false CHANGED), and its own `open(f, O_CREAT)` blocked on a guest FIFO. Fixed with fchmodat NOFOLLOW and O_NONBLOCK.
    - No escape and no memory error was found.

## 9. Host cost per request at depths 3, 10, 20 (`bench2.c` through fs_handle, FINAL cfg, best of 3, ns) [V]
| op | orig (`/.vol`) d3 / d10 / d20 | hardened (root-relative, beneath) d3 / d10 / d20 |
|---|---|---|
| GETATTR | 1043 / 1128 / 1326 | 613 / 727 / 850 |
| LOOKUP+FORGET | 1159 / 1236 / 1559 | 665 / 784 / 899 |
| OPEN+RELEASE | 8200 / 9790 / 12904 | 8281 / 10198 / 11053 |
| GETXATTR (absent) | 1011 / 1105 / 1309 | 993 / 1088 / 1166 |

These are the second of two runs; the first run shows the same ranking.
- Hardened is about 0.4 µs *cheaper* for GETATTR and LOOKUP and the same for OPEN and xattr. A component walk beneath the root costs about 15 ns per level [V, section 2], while `/.vol` pays a by-id vnode lookup on every call.
- Against the 2.5-6.6 µs of host work per guest request: no added cost. On the hostwalk mix it is within noise, and at most +3-7% on the quiet run (OPENDIR goes through dir_open's extra fstat).

## 10. Implemented against designed
- **Implemented:**
  - root-fd resolution for every op, with (dev, ino) identity checks;
  - (parent, name) places with O(1) guest rename;
  - recovery via fsgetpath with a prefix check;
  - dir_open for the calls without a flag;
  - setrlimit, max_handles and ENFILE;
  - streamed listings;
  - the READDIRPLUS freshness fix;
  - the FIFO and fallocate fixes;
  - confine cases and the fuzzer.
- **Designed only:**
  - chunked resolution for paths over MAXPATHLEN (today ENAMETOOLONG) [S];
  - birthtime as a generation against inode reuse [G];
  - a strict mode that checks an open handle's F_GETPATH per I/O [G];
  - an LRU of read-only descriptors;
  - a parent identity check on LOOKUP success.
- **Not verified:** setrlimit taking effect at run time (compiled only) [S]; the `bulk=0` EMFILE behaviour beyond the rlimit [S].

## 11. Guest re-runs needed (build `prototype/vzfs-hardened/build.sh <out>`, settings `mode=serial xattr=1 no_flush=1 killpriv=1 spin_us=50 spin_solo=8 adapt_ttl=1 stale_gone=1 xattr_memo=1`) [G until run]
1. The GETATTR-, LOOKUP- and open-heavy guest benchmarks (stat walk, `find`, `git status`): expect equal or better.
2. The readdir walk with READDIRPLUS (dir_open adds an fstat per OPENDIR; streamed listings change the batch sizes).
3. The rename and git workloads (checkout, rebase): exercise node_moved and the ESTALE re-lookup.
4. Guest confinement with real Linux dentries:
   - Mac moves a directory out and back while the guest holds cwd in it;
   - READDIRPLUS attributes after a Mac write;
   - an ESTALE re-lookup after a Mac rename;
   - a FIFO created by the Mac at a name the guest opens.
5. The fd count under load (`lsof -p` or `kern.num_files`) with many open files: check the max_handles ENFILE path from the guest.
