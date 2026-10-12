# Review fixes

Status of every High and Medium finding in this folder after the fix pass. Owner's rules applied: no backward compatibility, delete rather than deprecate, no provider knowledge in the harness, live tests local only.

## High

| Finding | Status | Note |
|---|---|---|
| Shipped agents need one provider's credentials | fixed | The four agent files declare no `model`; they inherit the main session's model and thinking level. |
| Failed wake or follow-up after the first turn hangs the agent (`settled` never reset) | fixed | The child adapter has a `running` flag set per issued prompt and cleared on `settled`; a rejected prompt always emits an error message and `settled`. |
| Held or early message starts a second concurrent prompt | fixed differently | While `running`, `send` and `wake` use pi's steer/follow-up queue and never call `prompt` again, so no workaround is needed in the runner. |
| Project `disabledPlugins` accepted and ignored | fixed differently | Read from the user file only, at boot; a project file that sets it gets a warning and the key is ignored. Documented in the subagents README. |
| `files` ships tests, fixtures, snapshots, spike script | fixed | Explicit list in `package.json`; CI fails if `npm pack` shows tests, snapshots or fixtures. |
| MIT license without a LICENSE file | fixed | `LICENSE` added and listed in `files`. |
| Version 0.1.0 while docs say 0.3 | fixed | `package.json` is 0.3.0. No git tag was created. |

## Medium

| Finding | Status | Note |
|---|---|---|
| One throwing shutdown handler skips the rest | fixed | Every handler runs, `stale` is always set, the first error is rethrown. |
| Child tool-result usage counted nowhere | fixed | One `sumUsage` for the main session and for children. |
| Contract larger than extensions use | fixed | Unused `Host`, `SessionInfo`, `ChildEvent`, `ChildSession`, `ToolSpec` and `ToolRenderState` members deleted. |
| `manager.report()` and contribution recording test-only | fixed | Deleted; plugins get the real `Host`. A plugin skipped for a missing requirement now warns once. |
| Partially failed spawn leaks the child session | fixed | A failed `bindExtensions` shuts the child's extensions down and disposes the session. A failure inside `createAgentSession` leaves no handle to clean (pi creates the runner inside it). |
| Semaphore slot leak when a `wait: true` caller closes | fixed | The waiter re-checks its record after acquiring and releases if closed. |
| `checkBatch` skips resolve at shutdown | fixed | The batch resolves first; only the caller notification is skipped while shutting down. |
| Turns that run without a concurrency slot | fixed | A grace answer or wake re-acquires a slot before delivering (`message-agent.test.ts`). |
| `disabledPlugins` in project settings ignored | fixed differently | See High. |
| Settings merged onto one object | no change needed | Refuted: pi builds a new extension per session. Settings are now one `loadSettings` at session start plus the boot read of `disabledPlugins`. |
| `run_agent` description contradicts stopped-agent results | fixed | Description says `wait: true` blocks and that stopped agents carry their last output. |
| File write failures leave registry inconsistent | fixed | Manifest and result write failures are recorded in the record's `error`; an unwritten result is inlined. |
| Worktrees and branches never cleaned up | fixed differently | Removed when the agent is stopped, interrupted or fails before it spawns. After a run they are deliberately left for the user and reported. |
| Main prompt replaced when its tools are disabled | fixed | `run-agent` sets the main prompt; the `agent_status` paragraph is appended only with that plugin. |
| Handoff validator duplicated | fixed | `core/manager/handoff.ts`. |
| Spinners turn backwards | fixed | One frame per redraw or tick. |
| Agent view re-parses the session file every refresh | fixed | Skipped when file size and mtime are unchanged. |
| Three hand-rolled throttles | fixed | `components/refresh.ts` (`createThrottle`, `watchAgents`). |
| Linger and throttle settings unexplained | fixed | Meaning and defaults in the subagents README. |
| `isAhead` and channel names duplicated | fixed | Channel names and parsers in `core/manager/channels.ts`; `isAhead` only in the spending ledger; the subagents usage report no longer dedups. |
| Stale context after compaction or unknown usage | fixed | Unknown usage clears the footer; new `Host.onCompact` clears the cached context. |
| `switching` phase without exit | fixed | A switch whose command never runs ends in the failed phase at the next idle or turn end. |
| HANDOFF.md, PLAN.md, deviations.md, spike.md, design note stale | fixed | Deleted, not labelled, together with `scripts/spike.ts` and two research files. |
| Unused `pi-agent-core` / `pi-ai` dependencies | fixed | Removed from peer and dev dependencies. |
| `engines.node` looser than toolchain | fixed | `>=22.19.0`. |
| README says "Pinned to pi 1.1.0" with `*` peers | fixed | Reworded to "developed and tested against pi 1.1.0". |

## Low items fixed

- `kimi-coding` subscription special case removed; `subscription` comes only from pi's OAuth check.
- Duplicate context snapshot code merged into `contextOf`; in-file-only exports un-exported; dead code and test-only production code (`initRenderTheme`, `report()`) removed or moved to test helpers.
- Live test helper has no import-time side effects (`setupLive`, `teardownLive`, `liveAgentModel`); live suites fail instead of skipping.
- Unknown frontmatter keys warn; agent names follow the same pattern as list entries; ids that repeat across reloads get a new suffix.
- `/agents <id>` follows chains of past sessions and survives a corrupt manifest; failed stops show a message; the agent view header ticks while running.
- `agent_status` pluralisation and chain snapshots; batch notification names ids; widget and README list queued, grace and lingering agents.
- Redundant `onSessionStart` reset handlers removed in progress-widget, notifications, usage-report and session-limits.
- Session-limits: second `/session-handoff` ignored while one runs; waiting phase uses the warning colour; equal ratios, zero window and unknown usage documented.
- Spending: footer total equals the sum of the displayed parts.
- `.gitignore` deduplicated, `vitest.live.config.ts` type-checked, CI calls `npm run check`, CI knows nothing about credentials.

## Deliberately left

- Residual pi window: a message queued after pi's last queue check but before `agent_settled` waits in pi's queue until the child's next prompt.
- `session.abort()` waits for pending tool promises (confirmed); the 5 s abort bound stays.
- Discarded `Host.subscribe` handles: pi unsubscribes when the instance is invalidated, so no code was added.
- `createTranscriptPane.sync` assumes a longer list is an extension of the previous one; a same-length list from a different source is not detected.
- `applySettings` stays in `core/manager/settings.ts` because subagents uses it.

## Questions closed by research (`open-questions.md`)

- pi builds a new extension instance and event bus per session (`/new`, `/resume`, `/fork`, `/reload`); `session_start` fires once per instance, twice in RPC mode. Reset-only handlers and unsubscribe calls are unnecessary.
- pi clears extension widgets on a session switch in interactive mode.
- `session.abort()` waits for pending tool promises; `steer` and `followUp` do not reject in practice; `prompt()` can throw on a busy session because pi sets its busy flag late, which the adapter's `running` flag avoids.
- pi's MCP extension connects in its `session_start` handler (inside `bindExtensions`), not during `reload()`; `ChildSession.dispose` is not called twice through the runner.
- pi returns `tokens: null` after compaction until the next reply; `/session-handoff` through `sendUserMessage` leaves no user message; spending's shutdown persist still has a live context.
- Resumed runs do not double count usage; `peerDependencies: "*"` is documented pi convention; `engines >=22.19.0` matches pi.
