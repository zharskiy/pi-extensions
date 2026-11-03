# Retention structure

- `index.ts`: pi entry; re-exports the default from `api/extension.ts`.
- `api/extension.ts`: `retentionExtension(deps)`, `createManagedExtension` with namespace `pi-retention`, `retentionPlugin` and the user-only `pi-retention.json` settings; the default export with the real handoff root, `pidAlive` and the once-per-process record.
- `api/plugin.ts`: `retentionPlugin`, `RetentionDeps`; liveness marker on session start and quit, the first-start sweep over `<agentDir>/sessions`, the settings-error guard and `/retention [apply]`.
- `core/settings.ts`: `RetentionSettings`, `defaults`, `schema`, `SETTINGS_FILE`.
- `core/live-markers.ts`: `liveDir`, `markerPath`, `writeMarker`, `removeMarker`, `pidAlive` and `readLive`, the live ids and files and the dead markers.
- `core/real-dirs.ts`: `entriesIn` and `subdirsIn` of a real folder only, `lastTouched`.
- `core/serial.ts`: `serial`, one step at a time over a list.
- `core/path-key.ts`: `pathKey`, the comparable form of a session path.
- `core/handoff-root.ts`: `rootState`, whether the handoff root is safe to sweep.
- `core/agent-runs.ts`: `staleRuns`, the run and chain rules of one session folder; `AGENTS_DIR`.
- `core/sweep-plan.ts`: `plan`, `Plan`, `PlanInput`, `Candidate`, `Stem`, `KeepReason`; the live, session, kept, orphan and handoff rules.
- `core/sweep-apply.ts`: `apply`, `Removed`; the per-candidate removal and the counts.
- `ui/retention-report.ts`: the notify line, the `/retention` report, the settings-error, usage and off texts.
- `tests/support/session-layout.ts`: `fabricate`, a temp agent dir, sessions folder and private handoff root with sessions, runs, handoffs and markers, and `planned`/`applied`/`prune` over them.
- `tests/sweep.test.ts`: the plan and apply rules on real temp folders through the adapter's real header reader.
- `tests/retention.test.ts`: the plugin on a fake host and the extension booted with real settings files: the sweep on start, markers, notify line, `/retention`, settings errors.
