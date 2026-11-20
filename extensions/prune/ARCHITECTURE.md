# Prune architecture

Prune removes old sessions and what the other extensions wrote for them. One scan of the disk feeds a pure plan, and the apply step removes the plan chain by chain. `/prune` and the sweep at session start share these three steps. They differ only in what they plan and in whether empty handoff folders are cleared.

## Flow

1. `scan` reads the disk once and returns either an abort reason or a `Scan`.
2. `plan(scan, cutoff)` picks what is old at `cutoff`. It reads nothing, so one scan serves every interval.
3. `apply(plan, live)` removes what the plan names and counts what it removed.

The sweep runs these once at the configured days and then clears empty handoff folders. `Prune now` plans every interval from one scan; after the confirm it scans again and applies only what both plans remove.

## Modules

### api

- `extension.ts` builds the extension with `createManagedExtension`, one plugin and the user-only `pi-prune.json` setting. The default export passes the real handoff root, `pidAlive` and a once-per-process record from `globalRecord`. That record survives pi building a new extension for each session in the same process, so the sweep runs once per process. Tests pass their own.
- `plugin.ts` writes the liveness marker on every session start and removes it on `quit` only. On the first start of the process it runs the sweep in the background, unless `days` is 0, the settings have errors or the marker could not be written. It reports in one notice what it removed or why it removed nothing, and stays silent when nothing was old. It registers `/prune`.
- `prune-command.ts` runs `/prune`. It needs the interactive terminal and allows one open copy. It shows a progress line above the editor while it scans or removes and clears it in a `finally`. The menu leads to two interval lists. `Prune now` confirms and then removes; in a list or the confirm, Escape or no goes back one step. `Auto-prune` saves the picked days through `saveDays`, reads them back with `loadDays` and removes nothing.

### core

- `prune.ts` wires the steps. `planIntervals` scans at the shortest interval and plans every interval of `INTERVALS`. `pruneConfirmed` scans at the picked interval and applies `within(fresh, confirmed)`. `sweep` applies the plan at the configured days and then runs `clearEmpties`.
- `sweep-scan.ts` holds `scan`. It aborts when the live folder exists but is not a readable real folder, or when a session header cannot be read; a file that vanished is skipped. It lists the real subfolders of `<agent dir>/sessions` only, never `info.file`, reads every `*.jsonl` header and groups the sessions into chains. It passes the files of chains old at the scan's cutoff, the stem folders it listed, the live files and the kept ids to `scanRuns`. It scans the handoff root only when `rootState` says it is safe, and names the root in `skipped` when it is unsafe.
- `sweep-plan.ts` holds the pure rules. A chain is removable when no member is live and its newest member is older than the cutoff. Every member of a removable chain is a candidate with its stale runs and its handoff folder. `keptIds` holds the live ids and the ids of kept chains. With it, a duplicate id's old copy never takes the handoff folder of a kept session, and fallback runs of a kept id stay. A cutoff later than the scan's throws, since the scan dropped what was fresh at its own cutoff. `within(fresh, confirmed)` keeps only the chains whose members all have the same file and mtime as when confirmed, and only the runs and handoff folders the confirmed plan named. `totals` counts a plan, a shared handoff folder once.
- `sweep-apply.ts` holds `apply` and `clearEmpties`. Before each chain, `apply` reads the live markers again and `lstat`s every member. When any member is now live or has another mtime, or the live folder cannot be read, or the check throws, the whole chain stays. The check runs once per chain, right before its first removal, not per member, so a member that another pi opens while the chain is being removed is not seen. Then it unlinks the members one at a time. A member's runs and handoff folder go only after its own unlink succeeded, and the first failed unlink stops the rest of the chain. Then it removes orphan runs, orphan handoff folders and dead markers. Every removal catches its own error and counts only what it removed. `clearEmpties` runs a plain `rmdir` on each empty-folder candidate, so a folder that gained a file stays.
- `live-markers.ts` owns the markers. `claimMarker` creates the live folder, writes nothing when it is not a real folder, writes to a temporary name and renames it into place, then removes the process's previous marker. `releaseMarker` removes it. `readLive` gives the live ids and files: every marker whose process is alive, its `parentSession` too, plus the current session. Every other marker is listed as dead.
- `session-chains.ts` holds `chainsOf`. It links each session to the scanned session its `parentSession` names and groups the links both ways with a union-find. Cycles and self-links add nothing, and depth is not capped. A member without a readable header counts as live, so its chain stays.
- `agent-runs.ts` holds `scanRuns`, which knows the run folder layout. It reads the runs of the given sessions that have a stem folder, of stem folders whose session file is neither listed nor live, and of the fallback folders of ids that are not kept. A run without a manifest, or with one that cannot be read, is kept; one whose manifest cannot be parsed is not. Each manifest goes through `runRules` from `platform/shared`, which keeps a run whose worktree was not removed and gives its links. `staleRuns` returns the runs whose whole chain, walked both ways, is older than the cutoff and not kept. `removeRun` removes a run and then its empty parent folders.
- `handoff-scan.ts` holds `rootState` and `scanHandoffs`. The root is safe when it is a real folder the user owns that group and others cannot write to. `scanHandoffs` streams the root once through the pool. Each real folder can be the handoff folder of a candidate, an old orphan that no session or live id claims, or an empty-folder candidate: own mtime over a day old and not named after a live id. An unclaimed folder whose own mtime is newer than the scan's cutoff is not read further.
- `real-dirs.ts` lists real folders only and measures a folder one level deep: its newest mtime and the bytes of the files directly in it. A symbolic link is never followed.
- `pool.ts` holds `pooled`, a bounded pool over a list or an async iterable. Results keep source order, and the first error is rethrown once running steps settle. Each stage uses its own pool, and only `apply` runs pools inside its pool over chains, each with a limit of one for the markers, members and runs of a chain, so open files stay bounded.
- `path-key.ts` holds `pathKey`, the form in which session paths are compared: resolved, and lower-cased where the file system folds case.
- `settings.ts` holds `NAMESPACE`, `INTERVALS`, the `days` schema and `loadDays` and `saveDays` of the user file.

### ui

- `prune-picker.ts` builds the menu and the two interval lists with their counts, bytes, preselected row and the mark on the configured days.
- `prune-report.ts` holds every text: progress, confirm, outcome, abort and failure warnings, and the sweep's one-line report with its byte sizes.

## Safety

- Only the real subfolders of `<agent dir>/sessions` are swept, so `--session <path>` and custom session dirs are never touched.
- Every folder is checked with `lstat`, and entries come from `withFileTypes`, so no symbolic link is followed or removed.
- Nothing is removed at the configured days while the settings have errors. A project `pi-prune.json` is one, since the setting is read from the user file only.
- Extensions are not loaded in agent sessions, so only main pi processes sweep.
