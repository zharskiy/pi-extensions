# Prune structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `pruneExtension(deps)`, `createManagedExtension` with namespace `NAMESPACE`, `prunePlugin` and the user-only `pi-prune.json` settings; the default export with the real handoff root, `pidAlive` and the once-per-process record.
- `api/plugin.ts`: `prunePlugin`, `PruneDeps`; liveness marker on session start and quit, the first-start sweep over `<agentDir>/sessions`, the settings-error guard, the picker flow and the routing of `/prune [<days>] [apply]`.
- `core/settings.ts`: `NAMESPACE` (`pi-prune`), `PruneSettings`, `defaults`, `schema`, `SETTINGS_FILE`, `MAX_DAYS`.
- `core/live-markers.ts`: `liveDir`, `markerPath`, `writeMarker`, `removeMarker`, `pidAlive` and `readLive`, the live ids and files and the dead markers.
- `core/real-dirs.ts`: `entriesIn` and `subdirsIn` of a real folder only, `lastTouched`.
- `core/serial.ts`: `serial`, one step at a time over a list.
- `core/path-key.ts`: `pathKey`, the comparable form of a session path.
- `core/handoff-root.ts`: `rootState`, whether the handoff root is safe to sweep.
- `core/agent-runs.ts`: `readRuns`, the runs of one session folder, and `staleRuns`, the run and chain rules over them; `Run`, `AGENTS_DIR`.
- `core/sweep-plan.ts`: `scan`, `plan`, `planAt`, `within`, `cutoffAt`, `Scan`, `ScanInput`, `Plan`, `PlanInput`, `Candidate`, `Stem`, `KeepReason`; the live, session, kept (parents up to five levels), orphan and handoff rules.
- `core/command-args.ts`: `parseArgs`, `completeArgs`, `INTERVALS`, the `/prune` grammar.
- `core/sweep-apply.ts`: `apply`, `Removed`; the per-candidate removal and the counts.
- `ui/prune-report.ts`: the notify line, the `/prune` report, the abort warning (`abortedText`), the confirm title and message, the counts of a picker row, the settings-error, usage, off and nothing-to-remove texts.
- `ui/interval-pick.ts`: `pickInterval`, the interval picker with each interval's counts and the configured mark.
- `tests/support/session-layout.ts`: `fabricate`, a temp agent dir, sessions folder and private handoff root with sessions, runs, handoffs and markers, and `input`/`planned`/`applied`/`prune` over them.
- `tests/sweep.test.ts`: the plan and apply rules on real temp folders through the adapter's real header reader.
- `tests/prune.test.ts`: the plugin on a fake host and the extension booted with real settings files: the sweep on start, markers, notify line, the `/prune` picker and arguments, settings errors.
