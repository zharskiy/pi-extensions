# Open files and the sandbox VM: findings and proposal

2026-11-25. Measured on the research Mac: macOS 27.2, Apple silicon, 16 GB, `kern.maxfiles` 122,880, `kern.maxfilesperproc` 61,440, colima 0.10.3, guest Ubuntu 24.04 with kernel 6.8. Raw results are in the notes files of this folder; `track.md` is the log.

## The answer in short

1. The Mac-wide "Too many open files" is arithmetic, not a leak. One Apple VM may hold up to one per-process allowance (`kern.maxfilesperproc`) of Mac descriptors, and each of them pins a vnode. macOS sizes its open-file table (`kern.maxfiles`) at exactly two allowances on every Mac. Above 16 GB of RAM the allowance keeps growing and the vnode table does not.
2. So two VMs fill the file table on any Mac, and on a Mac with 64 GB or more one VM may be enough to use up the vnodes. Measured on the research Mac (16 GB): two VMs filled the table, with "Too many open files in system" in both guests. The highest reading was 121,549 of 122,880, the safety loop's; the sampler's highest were 116,205 and 117,163. One VM alone never did (68,141 at most). But one VM reaches its own limit of 61,440 under parallel `ls -R` walks: the samplers saw 59,553 to 61,440, and the guest's errors show that the limit was touched. The sandbox then gets "Too many open files", in 7 of 8 runs without a governor (Labs F and G), and in the eight-walker runs it also stood still for seconds. So there are two failures, one across the Mac and one inside the sandbox, and the solution has two parts. Neither replaces the other. The vnode side could not be measured on 16 GB.
3. **The Mac (layer 1).** Two lines must hold: the file table has room for every VM at its limit plus one allowance for the rest, and the VMs together cannot pin more than half of the vnodes. pinata checks both at launch and in `pinata doctor`. When one fails, a small LaunchDaemon sets two values at boot. A 16 GB Mac raises `kern.maxfiles` to four allowances (245,760), and that is recommended always. A 32 GB Mac with one VM changes nothing. A 32 GB Mac with two VMs, or a Mac with 64 GB or more, lowers `kern.maxfilesperproc` to 61,440, and every other program and VM there then gets the 16 GB limit. Measured: the allowance of 61,440, in every lab. Derived from the invariant and not run: the table of 245,760. The README's current advice raises both limits and keeps the 2:1 ratio, which moves the file-table failure to a larger size and brings the vnode failure closer. Replace it.
4. **The sandbox (layer 2).** A governor in the guest, always on. It counts the share's cached entries. Above a budget it pauses the containers for about 0.27 s, releases the share's cache and resumes them. The budget is `min(50,000, 0.8 × kern.maxfilesperproc)`, read on the Mac at launch. Measured at 50,000 under eight walkers: peak 54,998 to 55,614 and no guest error in 3 of 3 runs, and, for the five walkers over quarters of the 67k tree, 13 passes each against 8 to 9 without it. A build-like run (unpack, list and delete 151,516 files) took the same time within 2%.
5. **In pinata:** remove the host watcher and `vm.releaseFileCache`. Add the launch check, the `open files` row of `pinata doctor` and the guest unit, with one key for the budget, `vm.cachedFiles` (`0` turns the governor off).
6. **The price.** A set of files larger than the budget, walked again and again, is walked cold every time: 2.3 to 2.8 times slower than a warm walk (67k and 124k files at a budget of 50,000). `git status` on a repository above the budget will take seconds instead of a fraction of one. That was measured only at a budget of 30,000 with a 42k repository (4.8 to 5.4 s against 0.24 to 0.28 s in Lab F; 4.1 to 7.9 s in Labs D and E, without the freeze), not at 50,000 with a larger one. The monorepo is likely above 50,000 files, so expect this every day. The budget and the off switch are the user's levers.
7. Before changing the failing Mac, run the small logger from "The failing machine" during one build. Its log says which case that Mac is in.
8. Not run here: the `sysctl` change itself (no sudo was used), anything on a Mac with more than 16 GB, a real Maven or npm build under the governor, and two VMs with the freeze. The first two follow from the kernel source, the measurements and outside reports.

## What the research found

### The mechanism, corrected

The cause in the problem statement is half right.

- **True:** Apple's virtiofs server holds one Mac descriptor for every file or folder the guest has cached. Listing a folder is enough. An open file costs a second one. A lookup of a missing name costs none. The numbers in the problem statement (3,000 files, about 3,360 descriptors; 76 after dropping the guest's cache) fit this.
- **Missing:** the server also frees descriptors by itself. At about 0.9 of its per-process allowance (55,296 here) it closes some, either about 5,000 at a time under read load or all at once (54,153 to 11,419 in 50 ms). The guest keeps its cache and sees no error. A later visit to a closed entry reopens it. Apple's engineer says the same: "When the number gets close to the process limits, they are being recycled."
- **So one VM is bounded by `kern.maxfilesperproc`:** softly at about 55,300 and hard at 61,440. No lab saw one VM above 61,440. The soft ceiling does not hold under parallel `ls -R` walks. The guest got "Too many open files" in 4 of 4 runs with four walkers (2 to 96 lines) and in 3 of 4 with eight (22 to 238 lines; Labs F and G). The samplers' highest readings in those eight runs were 59,553 to 61,440; the errors show that the hard limit was touched between samples. In the eight-walker runs the Mac's count then fell to between 12 and 23 for seconds and the guest's requests stood still: one uncached `stat` took up to 4,405 ms (Lab G). That harms the work in the sandbox, not the Mac. The VM's process is started by launchd, so a `ulimit` in the shell that starts colima changes nothing (55,276 under `ulimit -n 4096`).
- **The table is two allowances.** The kernel sets `kern.maxfiles = 30,720 × min(16, RAM / 4 GB)` and `kern.maxfilesperproc` to half of it, on every Mac. The rest of this Mac uses about 6,600 to 6,800. One VM at its hard limit: 61,440 + 6,800 = 68,240 of 122,880. Two VMs at their hard limit: 2 × 61,440 + 6,800 = 129,680, more than the table.
- **The vnode table does not scale the same way.** Every open file pins a vnode. `kern.maxvnodes` is 249,863 on this 16 GB Mac and by the kernel source stops growing near 263,168, while the allowance doubles at 32 GB (122,880) and again at 64 GB (245,760). A VM's ceiling follows the allowance (Apple's maintainer: the device "holds open FDs right around until kern.maxfilesperproc, then tries to purge a portion"). So on a 64 GB Mac one VM may hold about 221,000 descriptors at its soft ceiling, 84 to 89% of the vnode table, and 245,760 at its hard limit, 93 to 98%, while the file table looks half empty. Outside reports point the same way and prove less: 230,000 descriptors in one VM, with no failure stated (docker/desktop-feedback #218); kernel panics with "vnode: table is full" at about 409,600 descriptors in one report (claude-code #92510), which is above every boot default, so the limits had been raised there, to values that are not known; and one user's host kernel panic, without figures (apple/container #1097). Not measured here.
- **The 43,852 after tests** in the problem statement is below the ceiling and is normal for one VM.

For the failing Mac this means one of four things. A second VM runs (colima's `default` profile next to `pinata` is enough). Or the Mac has 64 GB or more, or 32 GB and two VMs, and the VMs pin most of its vnodes. Or the limits were raised as the README says, which gives a 16 GB Mac the same exposure. Or something else holds a large share. The logger in "The failing machine" tells them apart.

### Evidence

| Lab | What was measured | Number |
| --- | --- | --- |
| A | `ls -R` of 20,000 files and 1,001 folders | +21,002 descriptors, 1.00 per entry |
| A | 2,000 files held open; 5,000 lookups of missing names | +2,000 more; +0 |
| A | One VM, 67,212 inodes cached in the guest, read load | max 55,302 (0.9 × 61,440 + 6), then 49,800 ↔ 55,000 |
| A | Fast `ls -R` at the ceiling | 54,153 → 11,419 in 50 ms, guest still holds 67k |
| A | Errors and read rate, two passes, both mostly at the ceiling | none; 8,083/s then 8,262/s |
| A | `stat` walk of entries Apple had closed, against a cold walk below the ceiling | about 29,000/s against 40,000/s |
| A | VM started under `ulimit -n 4096` | ceiling unchanged, 55,276 |
| E | One VM, two shares, six parallel walkers | max 55,298, guest 109,224 inodes, no errors |
| F, G | One VM, eight parallel `ls -R` walkers, no governor, 4 runs | max 59,553 to 61,440; 33, 238, 0 and 22 "Too many open files" in the guest; Mac table at most 68,141 |
| G | The same load, an uncached `stat` every 50 ms, 2 runs | longest 4,405 and 3,644 ms; 18.5 and 13.7 s of the 30 s in calls over 0.1 s |
| F | One VM, eight parallel `stat` and eight `grep` readers over 124k files | max 58,073, no errors |
| F | One remount under load; the same with the containers paused | Mac count 45,800 → 53,700 over 0.65 s, not lowered; paused 29,850 → 79 in 50 ms |
| E | Two VMs loaded at once, no governor | each VM up to 61,440; table 121,549 of 122,880 by the safety loop, 116,205 and 117,163 by the sampler |
| E | The same run, errors in the guests | 239 and 241 lines "in system" (ENFILE), 3,317 and 4,463 lines per-process (EMFILE) |
| E | Cost of one revisit: entry valid, expired, pruned | 0.6–7.5 µs, 26 µs, 55 µs |
| A | Today's watcher, rebuilt: peak in three runs | 49,096 (it fired once, at 46,224), 54,245, 54,940 |
| A | Side effect of its `drop_caches=2` | the guest's own ext4 inode cache 4,901 → 2,736 |

### Why today's watcher does not help

`launcher/backend/colima/file-cache.ts` counts the VM's descriptors with `lsof` every 10 seconds and, above 30,720, runs `sysctl vm.drop_caches=2` in the VM, at most once per 30 seconds. A VM fills at 34,000 to 68,000 entries per second, so it goes from empty to the ceiling in about a second. In Lab A the rebuilt watcher peaked at 49,096 to 54,940 in three runs. It fired during one of them, at 46,224, and the count still rose to 49,096; in the other two Apple's own purge acted first. When the watcher does act, it empties every cache in the guest, not only the share's. It watches pinata's VM only, so it cannot help with a second VM. It does not bound one VM either: the VM reaches its limit between two samples, and a release sent while the load runs does not lower the Mac's count until the load pauses (Lab F, measured with a remount).

## The solution

### Layer 1, the Mac: hold the bound in the kernel

What the VMs may hold must fit in both tables:

    files:   kern.maxfiles ≥ (number of VZ VMs + 1) × kern.maxfilesperproc
    vnodes:  number of VZ VMs × kern.maxfilesperproc ≤ kern.maxvnodes / 2

The kernel caps every process at `kern.maxfilesperproc` on each allocation, the VM included. If the file table has room for every VM at its cap plus one more allowance for everything else, the VMs cannot fill it, whatever the guest does. If the VMs together cannot pin more than half of the vnodes, the Mac keeps the other half. Nothing samples and nothing races. The "half" is a margin chosen here, not a measured threshold.

pinata checks both lines at every launch and in `pinata doctor`. While they hold, nothing has to change. When one fails, the fix is the LaunchDaemon below. By Mac, at its boot defaults:

- **16 GB** (table 122,880, allowance 61,440): raise `kern.maxfiles` to 245,760, four allowances. The lines hold for one VM as it is, and the file line fails for two. Raising the table is recommended always: the VM's own ceiling does not move, so nothing is known to be lost, and a second VM that appears later is covered. The table then has room for three VMs at their hard limit and a full allowance for the rest, and two VMs pin at most 122,880 vnodes, just under half.
- **32 GB with one VM** (245,760 and 122,880): change nothing. Both lines hold: 245,760 ≥ 2 × 122,880, and 122,880 ≤ 131,584, half of the vnode table by the source's formula.
- **32 GB with two VMs:** both lines fail. Lower `kern.maxfilesperproc` to 61,440.
- **64 GB or more** (491,520 and 245,760): the vnode line fails for one VM already. Lower `kern.maxfilesperproc` to 61,440.

The allowance of 61,440 is the measured part: every lab ran at it, with the default table of 122,880. The table of 245,760 is derived from the invariant and was not run.

Lowering the allowance has a price. `kern.maxfilesperproc` is one limit for every process, so every other program on that Mac gets the 16 GB limit, other VMs included: Docker Desktop, colima's `default`, pinata with the governor off. At that limit VMs without a governor got guest errors in 7 of 8 runs under parallel walks, and stalls of seconds; at their larger default they may never get there. The alternative on such a Mac is to keep the allowance and raise only the table: the file line then holds and the vnode exposure stays. Neither was measured; nothing was run above 16 GB.

| Setting | `kern.maxfiles` | `kern.maxfilesperproc` | Two VMs at their hard limit | One VM against the vnode table (249,863 here): soft ceiling; hard limit |
| --- | --- | --- | --- | --- |
| macOS default, 16 GB | 122,880 | 61,440 | 122,880, all of the table | 55,296, 22%; 61,440, 25% |
| macOS default, 32 GB | 245,760 | 122,880 | 245,760, all of the table | 110,592, 44%; 122,880, 49% |
| macOS default, 64 GB or more | 491,520 | 245,760 | 491,520, all of the table | 221,184, 89%; 245,760, 98% |
| README today | 524,288 | 262,144 | 524,288, all of the table | 235,930, 94%; 262,144, more than the table |
| Proposed, 16 GB | 245,760 | 61,440 | 122,880, half of the table | 55,296, 22%; 61,440, 25% |
| Proposed, 32 GB with two VMs, 64 GB or more | the default | 61,440 | 122,880, half or a quarter of the table | 55,296, 22%; 61,440, 25% |

Only the 16 GB default row was measured; the others are arithmetic from the kernel's formula and the measured 0.9 ceiling.

Why this is not "raise the limits" again: raising both keeps the ratio at two, so two VMs still add up to the whole table, only later. It also raises each VM's own ceiling toward the vnode table, which is where the one report of "vnode: table is full" panics points. The proposal changes the ratio and, where it moves the allowance at all, puts each VM's ceiling where Apple's purge was measured. On a 16 GB Mac that is one raised number; on a larger Mac that fails the check it is one lowered number.

Runtime cost. On a 16 GB Mac layer 1 changes only the table's size, and the VM behaves as it does today. On a Mac where it lowers the allowance, the VM gets the ceiling measured here: Apple's purge acts at 55,296 instead of 110,592 or 221,184, so more often. What that ceiling costs:

- **A single sequential walk: nothing measured.** The purge frees Mac descriptors and keeps the guest's cache, so a revisit costs 26 µs instead of 55 µs after a guest-side prune. Lab A's two read passes ran at the same rate, but both ran mostly at the ceiling, so they do not compare it with the rate below. A `stat` walk of entries whose descriptors Apple had closed ran at about 29,000/s against 40,000/s for a cold walk below the ceiling.
- **Parallel walks: tail latency and stalls.** With four walkers and no governor the longest `stat` took 62.5 ms and the longest read 131 ms, against 3.2 and 4.2 ms with Lab D's governor at a budget of 8,000. Under eight walkers requests stood still for seconds (Lab G). That is layer 2's part.

Any program that needs more than 61,440 descriptors would be limited too; that is the limit every 16 GB Mac already has.

Apply once per Mac. Save this as `local.pinata.maxfiles.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.pinata.maxfiles</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>a=$(/usr/sbin/sysctl -n kern.maxfilesperproc) || exit 1; t=$(/usr/sbin/sysctl -n kern.maxfiles) || exit 1; case "$a" in ''|*[!0-9]*) exit 1;; esac; case "$t" in ''|*[!0-9]*) exit 1;; esac; [ "$a" -le 61440 ] || a=61440; [ "$t" -ge $((a * 4)) ] || t=$((a * 4)); exec /usr/sbin/sysctl -w kern.maxfilesperproc=$a kern.maxfiles=$t</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

```sh
sudo install -o root -g wheel -m 644 local.pinata.maxfiles.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/local.pinata.maxfiles.plist
```

The second command runs it at once and at every boot. The line lowers the allowance to 61,440 if it is larger and raises the table to four allowances if it is smaller; on a 16 GB Mac that is `kern.maxfilesperproc=61440 kern.maxfiles=245760`. One line serves every case above. Install it on a 16 GB Mac always, and on a larger Mac only when pinata's check warns: on a 32 GB Mac with one VM it would lower the allowance for nothing. When `sysctl` fails or prints something that is not a number, the line exits and writes nothing.

- **After the first run** restart the VMs if it lowered the allowance: whether Apple's server follows a lowered allowance while it runs is not known.
- **To install a changed plist** run the `bootout` below first: `bootstrap` fails for a job that is already loaded.
- **To undo:** `sudo launchctl bootout system/local.pinata.maxfiles`, delete the file, reboot.
- **The job keeps no log.** `launchctl print system/local.pinata.maxfiles` shows its last exit code.
- **Not `/etc/sysctl.conf`:** it does not exist on this Mac and was not checked to be honoured on macOS 27.

The plist passes `plutil -lint`, and its line was dry-run with a stubbed `sysctl`: the boot defaults of 8, 16, 32 and 64 GB, the README's values, a failing `sysctl` and one that prints no number. It was not loaded here.

What pinata does:

- **At every launch:** reads the three limits (`kern.maxfiles`, `kern.maxfilesperproc`, `kern.maxvnodes`) and counts the running `com.apple.Virtualization.VirtualMachine` processes. When either line of the invariant does not hold it prints one warning in the form of `cli/launch.ts:695` and goes on, for example: `pinata: warning: 2 virtual machines are running and each may hold 61440 of your Mac's 122880 open files; see "Open files" in CONFIGURATION.md`, or on a 64 GB Mac: `pinata: warning: a virtual machine may hold 245760 open files, most of what your Mac can keep open (263168); see "Open files" in CONFIGURATION.md`. That section has the LaunchDaemon. A bare `sudo sysctl -w` sets the same values, but only until the next reboot.
- **In `pinata doctor`:** a new `open files` row (the `file cache` row stays and shows layer 2's governor): the table's use and limit, the pinata VM's count, other VMs with their counts, the verdict and where to read on. A sketch in the form the report prints today (`tests/cli/doctor-report.test.ts:155`); the figures are made up and the wording is the author's call:

```
  ok open files        6700 of 245760 in use; pinata VM 12000; 1 other VM (30); room for 2 VMs
  !  open files        2 VMs may hold 122880 of 122880 open files; see "Open files" in CONFIGURATION.md
```

"Room for 2 VMs" is the largest number for which both lines hold: with this table the file line would take three, the vnode line takes two.

- **Docs:** the README row for "Too many open files in system" and the CONFIGURATION section get the corrected explanation, the cases and the plist.
- **Removal:** the watcher and the `vm.releaseFileCache` key go; layer 2's `vm.cachedFiles` takes the key's place. A config that still sets the old key is then rejected (step 5 of the outline). pinata never runs `sudo` on the Mac and never writes the plist; the user does. Inside the VM it does run `sudo`, over `colima ssh`, to install layer 2, as the trust store's install does today (`backend/colima/vm-trust.ts:38`).

### Layer 2, the sandbox: a governor in the guest, always on

Layer 1 protects the Mac. It does not protect the sandbox from its own VM's limit. Without a governor the guest got "Too many open files" in 7 of 8 runs under parallel `ls -R` walks, and in the eight-walker runs it also stood still for seconds. With the governor no run had an error, and under eight walkers the work went faster, not slower (first table). So it runs always.

Settings:

- **Budget:** `min(50,000, 0.8 × kern.maxfilesperproc)` cached entries. pinata reads the allowance on the Mac at launch and hands the result to the unit. At an allowance of 61,440 the second term binds: 49,152 (the runs here used 50,000). On a Mac that keeps a larger allowance, 32 GB with one VM, the cap of 50,000 binds, because nothing above 50,000 was measured.
- **Read interval** 0.1 s near the trigger, 1 s at most. **Wait** 4 µs per released entry.
- **No idle release.** With layer 1 the Mac's table has room for a full VM, so emptying a quiet VM buys nothing, and it made the first command after a pause 4 to 10 times slower (Lab E). The script keeps the switch.
- **One key,** `vm.cachedFiles`, sets the budget; `0` turns the governor off. It replaces `vm.releaseFileCache`.

The prototype is `prototype/share-governor-backpressure.sh`, a POSIX `sh` script, with its systemd unit `prototype/pinata-share-governor.service`. The two files are not in the repository; this document describes what they do. It reads the guest's count of FUSE inodes (one file read, 4 µs), which in pinata's VM are the shares' entries as long as nothing else mounts FUSE there. Above the budget it does four things:

1. **Freezes the containers** with one write to `/sys/fs/cgroup/docker/cgroup.freeze`. Docker's daemon, its shims and the governor keep running. A container started meanwhile is frozen too. A user's own `docker pause` should not be disturbed, because it freezes the container's own cgroup and the governor writes only to the parent; that is reasoned, not tested.
2. **Remounts each share in place** (`mount --options-source=mtab -o remount`). The kernel drops that share's unused entries and tells the Mac.
3. **Waits** 4 µs per dropped entry, 1.5 s at most, while Apple's process closes the descriptors.
4. **Thaws.**

A freeze lasted 250 to 290 ms at a budget of 50,000 and 160 to 200 ms at 30,000 (Lab G). Only the share's cache is touched. Open files, working directories, memory maps and watched folders survive a prune (89 prunes with no failure in Lab D, without the freeze). The trigger is `max(budget, floor + budget / 2)`, where the floor is what the last prune could not release.

Why the freeze is needed (Lab F): under lookup load Apple's process takes releases at a small fraction of its idle rate. After one remount under load the Mac's count rose from 45,800 to 53,700 over 0.65 s. With the containers paused it fell from 29,850 to 79 in 50 ms. A governor without the freeze was worse than none in Lab F, one run per case ("Alternatives considered").

Parallel walks: one VM, 30 s, cold, `ls -R` walkers and a `git status` loop in one container, three runs per row (Lab G).

| Load | Governor | Mac peak | Guest errors per run | Passes per walker | Freezes per run |
| --- | --- | --- | --- | --- | --- |
| Eight walkers | none | 59,553 to 61,440 | 238, 0, 22 | 8–9 | |
| Eight walkers | budget 50,000 | 54,998 to 55,614 | 0, 0, 0 | 13–14 | 25–26 of 260–290 ms |
| Four walkers | none | 59,888 to 61,218 | 26, 80, 96 | 21–24 | |
| Four walkers | budget 30,000 | 33,918 to 35,648 | 0, 0, 0 | 19–20 | 43–44 of 160–200 ms |

- Passes in the eight-walker rows are those of the five walkers over quarters of the 67k tree. The others show the same ratio: 10 to 11 against 6 to 7, and 5 to 6 against 3 to 4. Under four walkers the governor costs passes and removes the errors.
- Lab F's single runs agree: eight walkers with none, 61,439 and 33 errors; four walkers, 60,740 and 2 errors with none, 34,433 and no error at 30,000.
- The peak is the budget plus what the guest adds before the next read, about 5,000 per 0.1 s. At 50,000 that is Apple's own purge point (55,296), 6,144 below the limit; the highest peak, 55,614, was 5,826 below.
- The stall: without the governor a probe that ran one uncached `stat` every 50 ms spent 18.5 and 13.7 s of the 30 s in calls longer than 0.1 s, the longest 4,405 ms. With it: 0.0 and 0.6 s, the longest 289 ms, which is one freeze.

Ordinary work at a budget of 50,000: in a container, cache dropped, then four runs back to back; the last row two runs (Lab G).

| Workload | No governor | Budget 50,000 | Freezes |
| --- | --- | --- | --- |
| `git status`, 42k repo | 4.1 s, then 0.23–0.28 s | 4.2 s, then 0.28 s | none |
| `stat` walk of 67k | 2.6 s, then 1.4 s | 3.2–4.0 s every run | 6 over the four runs, 260–270 ms |
| `stat` walk of 124k | 5.2 s, then 2.8 s | 7.2–7.9 s every run | 13 over the four runs, 250–290 ms |
| Unpack, list, delete 151,516 files | 41.3–41.4 s, 0.77–0.78 s, 14.3 s | 41.5–42.1 s, 0.76–0.77 s, 13.7–13.8 s | 3 per run, 260–280 ms |

At a budget of 30,000 the last row took 42.0 s, 0.95 s and 14.0 to 14.1 s with 6 freezes per run. There `git status` on the 42k repo, now above the budget, took 4.8 to 5.4 s every run against 0.24 to 0.28 s (Lab F), and 4.1 to 7.9 s without the freeze (Labs D and E). The price is summed up in "Costs and limits".

What it cannot do:

- **Bound another VM.** On a Mac whose limits cannot be changed (no admin rights) the default budget does not make room for a second VM either: about 55,000 + 61,440 for the other VM at its limit + about 6,700 for the rest = about 123,100, more than the table of 122,880. Set `vm.cachedFiles` to 30,000 there: about 35,600 + 61,440 + 6,700 = about 103,700. This is arithmetic; no two-VM run was made with the freeze.
- **Release part of a cache.** A remount drops every unused entry of the share, and the kernel's per-filesystem shrinker control is absent (`CONFIG_SHRINKER_DEBUG` is off in the stock Ubuntu 6.8 kernel).
- **Go below what is pinned.** An inotify watch pins its folder: with 12,000 watched folders the count stays at 12,078, and the governor prunes once and then leaves them alone (Lab E).

For building it, these hold:

- **A persistent systemd unit.** It survived `colima stop` and `start` without a reinstall (Lab D).
- **`mount --options-source=mtab -o remount`.** A plain remount re-applies `/etc/fstab`, and `--options-source=disable` turned a read-only share writable in the guest (Lab E).
- **A killed governor must not leave the containers frozen.** The script thaws on exit and at start, but no trap catches `kill -9`: without more, the containers were still frozen 3 s after one. With `ExecStopPost=… --thaw` and `Restart=always` in the unit they thawed 118 to 127 ms after the kill, 3 of 3 (Lab G). That alone does not bound a freeze: see the first item of the list below.
- **Docker during a freeze.** `docker ps` answered in 0.01 s. `docker exec` and `docker run`, issued during a 4 s freeze, waited and returned without error just after the thaw (4.03 and 4.11 s).
- **The freeze path depends on docker's cgroup driver.** colima's VM uses cgroupfs: one folder, `/sys/fs/cgroup/docker`, holds only containers, and one write freezes all of them, new ones too. For the systemd driver the script freezes each `system.slice/docker-*.scope`. There a container started during a freeze escapes it, and by the script's text the thaw would also resume a container the user paused. That path was not run.
- **The wait is a time,** not a `stat` on the share as a sync point. `stat` returned with about 6,700 descriptors still open and the peak was 40,777 at a budget of 30,000.

Before the prototype ships, fix these in the script and its unit. The two prototype files stay as they were measured.

1. **The remount runs while the containers are frozen, with no time limit** (script line 144; the unit has no watchdog). A share that stalls keeps every container frozen. Start the remount in the background and thaw at a deadline, whether or not it has returned. Until then the honest bound on a freeze is the remount (76 ms under load in Lab F, unbounded by the script), the 20 ms settle, the wait (1.5 s at most) and, after a kill, about 0.12 s.
2. **The trigger can pass the limit.** After a prune it is `floor + budget / 2` (line 214), with no cap. With more than about 31,000 entries pinned, the trigger plus the 5,000 of one read interval is above 61,440. Cap it. A floor that leaves no room under the cap cannot be governed and should be reported, not pruned at every read.
3. **The script's own defaults are not the proposal's:** budget 30,000 and idle release after 10 s (lines 41 and 44); only the unit sets 50,000 and 0. A budget of `0` means 30,000 to the script (line 56), so `vm.cachedFiles: 0` must stop the unit, not hand it a zero.
4. **One journal line per release** (line 217), 25 in 30 s under a burst. Count the releases and print a total now and then.
5. **`PINATA_SHARE_FREEZE` is word-split and globbed** (line 115).
6. **The count is every FUSE inode in the guest** (line 74). That equals the shares' entries only while nothing else mounts FUSE in the VM.

## Costs and limits

- **Layer 1 costs** one privileged install of a LaunchDaemon on a Mac that needs it. On a 16 GB Mac it costs nothing at runtime: only the table grows.
- **At an allowance of 61,440 and a table of 245,760 it covers two VMs on both lines and three on the file line.** A third VM may pin 184,320 of this Mac's 249,863 vnodes, more than half; the launch check says so. What the Mac does at that point was not measured.
- **Only Apple VMs are counted at launch.** Any process may take one allowance; the doctor row shows the table's use, which covers the others.
- **Where it lowers the allowance** (32 GB with two VMs, 64 GB or more) every process gets 61,440 instead of 122,880 or 245,760. A program that needs more descriptors than that would fail to open files; none is known on a developer Mac. Other VMs get the limit too: Docker Desktop, colima's `default`, pinata with the governor off. At that limit VMs without a governor got guest errors in 7 of 8 runs under parallel walks, and stalls. Keeping the allowance and raising only the table avoids that and keeps the vnode exposure. Neither was measured.
- **Layer 1 alone leaves the sandbox exposed** to its own VM's limit: errors in 7 of 8 runs under parallel `ls -R` walks and requests blocked for up to 4.4 s. Not every parallel load does it: six walkers in Lab E stayed at 55,298 and eight `stat` with eight `grep` readers at 58,073, both without an error. This exists today.
- **Layer 2's price is the cold walk.** A prune empties the whole share cache, so a set larger than the budget that is walked again and again is looked up again every time: 2.3 to 2.8 times slower than a warm walk (`stat` walks of 67k and 124k at a budget of 50,000). The freezes are the smaller part: 13 of about 0.27 s over the four 124k runs, about 0.9 s per run. The first, cold run lost 2.0 s and each warm run 4.5 to 5.1 s, which is 2.6 to 2.8 times a warm walk.
- **`git status` on a repository above the budget** will take seconds instead of a fraction of one. Measured only at a budget of 30,000 with the 42k repository: 4.8 to 5.4 s against 0.24 to 0.28 s with the freeze (Lab F), 4.1 to 7.9 s without it (Labs D and E). Not measured at 50,000 with a larger one. The monorepo is likely above 50,000 files, so this is the everyday cost to expect. The lever is `vm.cachedFiles`: `0` for no governor, or another budget. A budget much above 50,000 needs a larger allowance first (see "Later"): the peak is the budget plus about 5,000 and the limit is 61,440.
- **Under a burst every container stands still** at each prune: 25 to 26 freezes of 260 to 290 ms in 30 s under eight walkers, 22 to 25% of the time. The walkers still made more passes than without it. Work in a container that depends on timing (health checks, test timeouts) may notice; that was not measured.
- **Below the budget it costs nothing measured.** `git status` on the 42k repo was not pruned once at 50,000. `npm ci` of 21,403 entries took 4.94 to 5.03 s with and without a governor (Lab D, without the freeze). The build-like run was within 1% in total, its unpack step at most 2% longer.
- **CPU:** 0.4 to 0.5% of one CPU idle and 2.2% under four walkers (Labs D and E, without the freeze).
- **Editing on the Mac is unchanged.** The share stays virtiofs. The guest trusts a cached entry for 1.0 s (Lab E), so an edit made in the IDE reaches the guest within about a second, as today.

## The failing machine

Nothing can be started once the table is full, so start the logger before the build. Plain `sh`, no sudo. Save as `fdlog.sh`, run `sh fdlog.sh > ~/fdlog.txt 2>&1 &`, reproduce the failure, then `kill %1` in the same terminal (from another one: `pkill -f fdlog.sh`).

```sh
#!/bin/sh
vms() { ps -axo pid=,comm= | awk '/com\.apple\.Virtualization\.VirtualMachine/ {print $1}'; }
echo "ram=$(sysctl -n hw.memsize) macos=$(sw_vers -productVersion)"
colima list 2>&1
ps -axo pid=,comm= | grep -E 'Docker|OrbStack|VMware|Parallels|UTM\.app|qemu|krunkit|vfkit'
while :; do
  set -- $(sysctl -n kern.num_files kern.maxfiles kern.maxfilesperproc kern.num_vnodes kern.maxvnodes)
  printf '%s files=%s/%s perproc=%s vnodes=%s/%s' "$(date +%T)" "$1" "$2" "$3" "$4" "$5"
  for pid in $(vms); do printf ' vm%s=%s' "$pid" "$(lsof -p "$pid" 2>/dev/null | wc -l | tr -d ' ')"; done
  echo
  [ "${1:-0}" -gt $(( ${2:-1} * 3 / 4 )) ] && lsof -n -P 2>/dev/null | awk 'NR>1 {c[$1" "$2]++} END {for (k in c) print c[k], k}' | sort -rn | head -5
  sleep 2
done
```

A `vm` column counts `lsof` lines, a few more than the descriptors (23 lines for 12 descriptors on an idle VM, Lab A). Above three quarters of the table it also lists the five largest holders among the user's own processes. A sample taken at the very moment the table is full may fail; the lines before it are what matter. After the failure also run `log show --last 15m --predicate 'process == "kernel" && eventMessage CONTAINS "table is full"'`. The script and the query were tried on the research Mac; the top-five line only by hand, since the table never passed three quarters then.

| The log shows | Meaning | Action |
| --- | --- | --- |
| Two or more `vm` columns, sum near `files` | The file table is full: the arithmetic above | Layer 1 (it raises the table, or lowers the allowance on a large Mac) |
| `files` far below its limit, the `vm` columns together above about 200,000 (`perproc` is 122,880 or more), and the kernel log says "vnode: table is full" | The vnode table is used up: by one VM on a Mac with 64 GB or more, or by several VMs at 32 GB | Layer 1 (it lowers the allowance to 61,440); not verified |
| `perproc` is not the boot default for that RAM (15,360 per 4 GB, at most 245,760) | Limits were raised as the README says; either of the two rows above, at a larger size | Layer 1 (it sets the allowance to 61,440) |
| One VM below 61,440, table still full | Something else holds the rest; the top-five lines name it | Depends on the holder |
| `files` far below its limit, the Mac's other programs fine, the build in the sandbox fails with "Too many open files" (without "in system") | The VM reached its own limit. The peak lasts well under a second, so a 2 s sample may miss it; the build's error text is the sign | Layer 2 |

`vnodes` equal to its limit proves nothing by itself: it reads 249,863 of 249,863 on the idle research Mac in every sample, so the kernel log line and the VM's own count are the signs to read.

Relief today, before any code change: install the LaunchDaemon above when that Mac's case calls for it (16 GB; 32 GB with two VMs; 64 GB or more), and restart the VMs if it lowered the allowance. Until the next reboot the values can also be set by hand, on a 16 GB Mac with `sudo sysctl -w kern.maxfiles=245760`. Do not raise `kern.maxfilesperproc`. To empty one VM's share cache by hand: `colima ssh --profile <profile> -- sudo mount --options-source=mtab -o remount "<share path>"` (Lab E: 42,120 cached entries to 111; the guest's other caches stay). Do it while the build is stopped: with the VM idle the Mac's count followed in 68 ms (42,033 to 49), under load it did not follow at all (Lab F).

## Alternatives considered

| Alternative | Verdict | Measured reason |
| --- | --- | --- |
| Raise both limits (README today) | No | Keeps the ratio at two; one VM may then pin 94% of the vnode table at its soft ceiling and more than all of it at its hard limit |
| Host sampler with `drop_caches` (today's code) | Delete | Peaked at 49,096–54,940 in three runs and fired during one (at 46,224); also drops the guest's own ext4 cache, 4,901 → 2,736 inodes (A) |
| Container memory limit or `vfs_cache_pressure` | No | 200 MB: not bounded (52,413). 24 MB: bounded with a 20,762 peak, but starves the build. Pressure 10,000: 21,030 → 21,031 (A) |
| Guest governor without the freeze | Dropped | One VM, one run per case: 60,554 and 83 guest errors, against 60,740 and 2 with none (F). Two VMs: table 120,821, errors in both guests (E) |
| Governor triggered by the Mac's count, not the guest's | No | Needs a sampler on the Mac and a channel into the guest that together answer within one read interval (0.1 s lets about 5,000 in): today's watcher made harder. The guest's own count needs neither |
| Governor triggered by the rate of new entries | No | Not a bound. A revisit of an entry whose descriptor Apple already closed opens one again on the Mac, and the guest cannot see that |
| A `stat` on the share as the sync point before the thaw | No | Returns with about 6,700 descriptors still open; peak 40,777 at a budget of 30,000 (F). `sync -f` was not tried |
| Releasing part of a share's cache | Not possible | The kernel's per-filesystem shrinker control needs `CONFIG_SHRINKER_DEBUG`; off in the stock Ubuntu 6.8 kernel (F) |
| Kernel `fuse.inval_wq` | Later | Needs kernel 6.19; colima's image has 6.8. Time based (5 s at least), not a count |
| Reverse sshfs | No | 2.6–3.2 times slower; hard links lose their identity; `chown`, `mkfifo`, xattr and `fallocate` fail (B) |
| Guest-local volumes for build output | Useful, not a bound | Untar 0.51 s against 5.6 s and 2 descriptors against 21,438, but the Mac sees an empty folder and the sources still fill the cache (B) |
| krunkit (libkrun) | Not yet | Descriptors flat at 122–125 with 64,288 inodes cached. But 2.1–2.8 times slower on reads, commit and `npm ci`; a rename on the Mac gives "no such file" in the guest for 4.77 s, 5 of 5; colima cannot start it with virtiofs; no Rosetta; `chown` does nothing; stopping the VM is a power cut until the next lima release (C) |
| Two-way sync with Unison | No | Earlier plan (then on branch `docs/synced-workspace-plan`, now [attempt-1-architecture.md](../attempt-1-architecture.md)): 253 s first sync for 300,000 files, 180–200 MB per end, and a drill deleted 3,041 files on the Mac |
| Mutagen | No | Same plan: does not carry modification times. Last release February 2025, partly SSPL |
| NFS from the Mac | No | Not measured. Needs sudo, `/etc/exports` and Full Disk Access for `nfsd`, and exposes the Mac's kernel NFS server to the sandboxed guest |
| `launchctl limit maxfiles` | No | Same invariant, but it sets launchd's own limits for everything it starts. Not tried here |
| Raising only `kern.maxfiles` on every Mac | Part of layer 1 | Right for 16 GB. On a 64 GB Mac it leaves one VM's ceiling at 221,184, next to the vnode table. It is the alternative where lowering the allowance would hurt other VMs; not measured |
| A custom virtio-fs device (new in macOS 27) | Later | Large engineering |
| Docker synchronized file shares; OrbStack | No | Paid, tied to Docker Desktop and built on Mutagen; closed, paid and not colima |

## Implementation outline

Both layers, in order. Paths are under `launcher/`; lines are at commit `ce7c680e`.

1. **`backend/colima/file-cache.ts`** (298 lines).
   - Rewrite `fileLimitsOf` (80). Today it takes two values by position and returns the watcher's threshold, `min(perProcess / 2, total / 4)`; the check needs the three limits and `kern.num_files`.
   - Keep the rest of the reading half: `LSOF`, `SYSCTL`, `countOf` (108), `holdersOf` (118), `knownHolder` (128, the fallback of `discover`), `discover` (140), `readLimits` (168), `read` (252).
   - Delete the releasing half: `RELEASE_COMMAND` (8), `SAMPLE_INTERVAL_MS` (10), `REDISCOVER_INTERVAL_MS` (12), `RELEASE_INTERVAL_MS` (14), `RELEASE_TIMEOUT_MS` (18), `FileCacheTick` (22), `FileCacheGuard` (41–44, which has only `tick` and `settled`), `Ticker` and `realTicker` (51–68), `sample` (156), `release` (180), `locked` (204), `tick` (218), `settled` (248), `watchFileCache` (270–298), and with them the `shell`, `lockIfFree` and `now` dependencies.
   - Add `kern.num_files` and `kern.maxvnodes` to the `sysctl` read, and a probe that lists the VZ VM processes with `/bin/ps -axo pid=,comm=` (the tool `shared/process-start.ts:12` already uses) and counts each through `countOf`. `discover` already finds pinata's VM as the process that holds the VM's disk; the rest of the list are the other VMs.
2. **`backend/colima/vm.ts`.** Shrink the import at 37; drop `withDirectoryLockIfFree` (10, 218), the `now` and `ticker` options (68–69) and `watchFileCache` (490). The guard at 214–221 keeps `runner`, `diskPaths` and `alive`.
3. **`backend/types.ts`.** Delete `VmWatch` (174–176) and `watchFileCache?` (187). Extend `VmFileCache` (180) with the table's use and limit, the per-process limit and the other VMs as `{ pid, count }[]`. Update the exports in `backend/index.ts` (28, 36).
4. **`cli/launch.ts`.** Remove the `VmWatch` import (2), the `watch` field (624), its start (673–674) and stop (681). Add the check beside `trustVm` (573–576), with the helper in `cli/vm.ts` next to `trustVm` (214) and the warning in the style of `launch.ts:695`. It never blocks; a probe that fails is silent.
5. **Config key.** `vm.cachedFiles` (a whole number, `0` or more; unset means the formula) replaces `vm.releaseFileCache` in `config/types.ts:55`, `config/defaults.ts:27`, `config/validate.ts:810` and `schema/sandbox-config.schema.json:811–814`. Unknown keys are an error (`config/shape.ts:109–116`), so a config that still sets `vm.releaseFileCache` is rejected: "is not a known key". No shim, because the problem statement says no backwards compatibility is required. Whether the commit carries the breaking marker is the owner's call under `AGENTS.md`.
6. **The governor in the guest.**
   - Assets: the two prototype files under `backend/colima/`, with the fixes of "Before the prototype ships", read through `launcherRoot()` like `image/entrypoint.sh`.
   - `backend/colima/share-governor.ts`, modelled on `vm-trust.ts` (157 lines). The budget is `vm.cachedFiles`, or `min(50,000, 0.8 × kern.maxfilesperproc)` from step 1's `sysctl` read. Hash the script, the unit and the budget. Early in `ensureRunning` (`vm.ts:279–283`) read the installed hash through `colima ssh`. When it differs: take the VM lock, check again, write `/usr/local/libexec/pinata/share-governor-backpressure.sh`, `/etc/systemd/system/pinata-share-governor.service` (the budget in its `Environment=` line) and the marker `/etc/pinata/share-governor.sha256`, then `systemctl daemon-reload` and `enable` and `restart` the unit. Budget `0`: `disable --now` and remove the three files. Warn, never block. In Lab D an install took 0.31 to 0.41 s and a check 0.15 to 0.17 s.
   - `ensureGovernor?` and `readGovernor?` in `backend/types.ts`, called from `cli/vm.ts` beside `trustVm`.
   - Known complications: the unit runs whenever the VM boots, also without pinata, and pauses every container in that VM at each prune, not only pinata's; two installs with different budgets would replace each other in turn; doctor must read and never install.
7. **Doctor.** In `cli/commands/doctor.ts` rewrite `fileCacheCheck` and its texts (215–308): the `file cache` row (678–682) now shows the governor (running or not, its budget, the guest's count, or `off`), and a new `open files` row shows layer 1. Add the row to `LAYOUT` (`doctor-checks.ts:30`; its `file cache` entry is line 39) and `HIDDEN_WHEN_OK` (`doctor-view.ts:20`). Optionally add both to `status.ts:85–96`.
8. **Cleanup.** `withDirectoryLockIfFree` (`shared/file-lock.ts:367`, `shared/index.ts:8`) loses its only caller in shipped code (`backend/colima/vm.ts:218`). Its tests still import it (`tests/shared/file-lock.test.ts:15, 299, 307`), so knip will not name it: remove it together with those tests. The `LockOutcome` re-export (`shared/index.ts:5`) loses its only importer (`file-cache.ts:1, 36`); remove it too if nothing else uses it.
9. **Tests.**
   - `tests/backend/colima-file-cache.test.ts` (729 lines): drop the release (451–535), watch (537–594) and colima watch (596–729) cases. Add the invariant cases: one VM at defaults holds, two VMs at defaults warn with the command, a raised table holds, a failed probe reads as unreadable.
   - `tests/cli/doctor.test.ts` 1112–1359 and the `file cache` case in `tests/cli/doctor-report.test.ts`: rewrite for the two rows.
   - `tests/cli/launch-flow.test.ts:411–433` and `tests/cli/launch-wiring.test.ts:396–439`: the watcher cases become the warning cases.
   - `tests/config/vm.test.ts:6–15`, `tests/config/merge.test.ts:46`, `tests/support/sandbox-config.ts:15`: the old key becomes the new one.
   - The governor: install cases like `tests/backend/colima-trust.test.ts`, and the script run under `sh` like `tests/image/entrypoint.test.ts:149–170`.
   - Seams: `createFakeRunner` (`tests/support/fake-runner.ts:34`) and `createFakeBackend` (`tests/support/fake-backend.ts:441–451`).
10. **Docs**, which `test/docs-sync.test.ts` requires together with the code: `README.md` 194 and 277; `CONFIGURATION.md` 26, 80 and 378–384 (the "File cache" section describes the governor and its price, and an "Open files" section the limits); `ARCHITECTURE.md` 62, 65, 221 and "Files written" (below); `STRUCTURE.md` 35, 83, 164, 390, 455, 503; `THREAT-MODEL.md` 48 and 90 (the watcher's rows go; the governor's come: a root unit in the VM that pauses its containers); the root `ARCHITECTURE.md:65` and `STRUCTURE.md:32`.

Rules from `AGENTS.md` that apply: `launcher/` may not import `platform/shared`; no hand-built `.pi` path is needed; the commit subject is a Conventional Commit (the breaking marker for the removed key is the owner's call) and `CHANGELOG.md` is not edited by hand; `npm run check` before finishing. And "Files written" (`launcher/ARCHITECTURE.md:246`) is the one list of what the launcher writes. Layer 1 adds no file, since the user installs the plist. Layer 2 writes three files inside the VM, so the list gets an "Inside the VM" entry next to "Inside the container". The trust store's files in the VM are described at `ARCHITECTURE.md:59` but are not in that list today; the new entry can name both.

## Later

- **krunkit.** Look again when all of these are true: a libkrun release with the cache timeout setting (#974) and krunkit exposing it; the rename window (#888) fixed; shared read-only descriptors (#988) released; a lima release with the clean stop (#5814); colima passing virtiofs to krunkit.
- **`fuse.inval_wq`.** When colima's image moves to kernel 6.19 or newer, the guest can expire unused entries by itself. It works by time, not by count, so it could stand in for the idle release (off here), not for the budget.
- **A larger allowance for a larger budget.** For one VM an allowance of 122,880 still satisfies the vnode line on this Mac (122,880 ≤ 249,863 / 2) and would let the budget be about 100,000, twice the working set that stays warm. Nothing was measured there: Apple's purge at about 110,000, the freeze at 100,000 entries (the wait alone is 0.4 s), the Mac with 110,000 vnodes pinned. And it breaks the vnode line for two VMs. A 32 GB Mac with one VM keeps that allowance under layer 1; the budget's cap of 50,000 holds there until this is measured.
- **A custom virtio-fs device** on macOS 27 would put the policy in pinata's hands. Large work; only worth it if Apple's server changes for the worse.

## Not verified

- **Setting the two limits apart was not run.** That `kern.maxfiles` can be raised alone and `kern.maxfilesperproc` lowered alone follows from XNU source of a tag older than macOS 27 (xnu-12377.121.6): the table check in `falloc_withinit`, the per-process check at each allocation read live, two plain integer sysctls with no coupling. A table of 245,760 was not run either: every lab ran with 122,880. The LaunchDaemon was linted and its line dry-run with a stubbed `sysctl`, not loaded.
- **Large Macs.** Nothing was measured above 16 GB. That the boot defaults scale with RAM and the vnode table stops near 263,168 is from that source; that a VM's ceiling follows the allowance is from Apple's maintainer and the 0.9 ratio measured here; that used-up vnodes are what fails there rests on one outside report (kernel panics with "vnode: table is full" at about 409,600 descriptors, on a Mac whose limits had been raised to values that are not known). Whether Apple's server follows a lowered allowance while it runs is not known, hence the restart of the VMs. What the lowered allowance does to other VMs on such a Mac (Docker Desktop, colima's `default`, pinata with the governor off) was not measured, nor was the alternative of raising only the table there. The share of vnodes a Mac needs for itself is not known either; "half" is a margin.
- **Layer 2.** The parallel-walk cases ran three times and the build-like case twice; the rest are single runs. Not run: the formula's own 49,152 (the runs used 50,000), a budget of 45,000 and the 0.05 s read interval at 50,000; the parallel-walk cases with the idle release off (they ran with it on at 10 s, the ordinary-work cases with it off); `git status` on a repository above a budget of 50,000; a real Maven or npm build under the freeze (`npm ci` ran only in Lab D, without it); two VMs with the freeze (on purpose, after the incident), so every two-VM figure for layer 2 is arithmetic; what a container sees when the governor is killed during a freeze (that measurement broke; the freeze file's timing is the evidence); the freeze path for docker's systemd driver; `sync -f` as a sync point. Reasoned, not tested: that a user's own `docker pause` survives the governor's freeze and thaw. Not measured: what work that depends on timing sees in a container that is frozen 22 to 25% of the time under a burst.
- **The overshoot on pinata's VM size.** About 5,000 entries per 0.1 s read interval was measured in lab VMs with 2 CPUs (Lab D) and 4 CPUs (Labs F and G). pinata's VM has 8 and may add entries faster, so the read interval or the budget must be measured again on that size before shipping. Lab F's one run at 0.05 s gave about 2,900 at a budget of 30,000.
- **A Mac with an allowance below 61,440** (8 GB: 30,720). The budget rule leaves 0.2 × 30,720 = 6,144 entries under the limit there, about one read interval at the measured 34,000 to 68,000 entries per second.
- **The stall after a VM hits its own limit** is measured (requests blocked for up to 4.4 s while the Mac's count sits at 12 to 23), not explained: what Apple's process does then is not known. How often a real build reaches the limit is not known either; the loads here were synthetic walks.
- **The failing Mac.** Everything here was measured on the research Mac. Counts at the moment of failure and whether a second VM runs there are still open; the logger answers both.
- **Other virtualisers.** The launch check counts Apple's VM processes only. Docker Desktop's processes were running on the research Mac and none of them is one; that was seen in the process list during the research and is not recorded in a notes file. How many descriptors its file sharing holds was not measured (an outside report says 230,000).
- **Figures in the Unison and Mutagen rows** come from the earlier plan's branch, not from this folder's notes.

## Incident

During the two-VM lab the Mac's file table was full for moments, twice. First both lab VMs ran without a governor by mistake: the safety loop read `kern.num_files` at 121,549 of 122,880 (the sampler's highest: 116,205 and 117,163) and both guests logged errors. Then, with both governed, it reached 120,821 for an instant, 1.9 s into the load. Other programs on the Mac may have seen "Too many open files in system" in those moments. Checked afterwards: no "table is full" line in the kernel log of the last three hours, no crash report, the `default` VM answering, and the table back at about 6,600. Both VMs of that lab were deleted afterwards. The two labs after it ran one VM under a watchdog; the table peaked at 68,141.
