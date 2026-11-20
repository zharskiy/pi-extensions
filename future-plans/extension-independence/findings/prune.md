# Findings: prune

> Checked 2026-11-20 on the `feat/retention` worktree at `c7e3f023`. Read from code only; no pi was started and no test was run against real data. Line numbers are from that commit.

Verdict: prune imports no other extension, but it hard-codes the subagents run layout and manifest meaning, so it is coupled to subagents on disk. The rest is pi's own format, shared formats it already imports, or generic platform additions.

## Imports

`grep -rn 'from "' extensions/prune --include='*.ts' | grep -v /tests/` shows imports from `platform/pi-adapter/index.ts`, `platform/shared/index.ts`, `platform/ui-kit/index.ts`, `platform/extension-manager/index.ts` (`api/extension.ts:2`) and its own files. No import from `extensions/*`.

## Findings

| # | What prune knows | Where | Owner | Rating | Proposed decoupling | Size |
|---|---|---|---|---|---|---|
| 1 | Agent runs live in `<session stem>/agents/<agent id>/`, each with `manifest.json`. | `core/agent-runs.ts:7` (`AGENTS_DIR = "agents"`), `:9` (`MANIFEST_FILE`), `:49`, `:88`; `core/sweep-apply.ts:35` removes `agents/` and then the stem folder itself | subagents: `core/model/paths.ts:8` (`MANIFEST_FILE`), `:10-11` (`agentsDirFor`) | REAL COUPLING | Move the run layout (`agentsDirFor`, `MANIFEST_FILE`, the fallback root) into `platform/shared/agent-runs/`, next to how the handoff layout already lives in `platform/shared/handoff/`. Both extensions import it from there. | about 30 lines moved |
| 2 | Sessions without a file keep their runs under `<agentDir>/pi-subagents/<session id>/agents/`. | `core/sweep-plan.ts:198` (literal `"pi-subagents"`), `:199`, `:240` (folder name taken as a session id) | subagents: `core/model/paths.ts:6` (`NAMESPACE = "pi-subagents"`), `:11` | REAL COUPLING | Same shared module as #1: `fallbackRunsRoot(agentDir)`. Today a rename of subagents' namespace would leave these folders unswept, silently. | in #1 |
| 3 | Manifest meaning: `predecessorId` and `successorId` form a chain; a `worktree` whose `cleanup` is not `"removed"` means the run still points at a worktree or branch and must be spared. | `core/agent-runs.ts:11` (own `Manifest` type), `:30-34` (`keepsWorktree`), `:62` (links), `:69-85` (chain walk) | subagents: `core/model/agent-record.ts:48` (`WorktreeCleanup`), `:50` (`Worktree`), `:84-85` (links); written at `core/agent-registry/registry.ts:21-47` | REAL COUPLING, the one that can lose data | Put one pure function beside #1 in `platform/shared`: `runRetention(manifestJson) => { links: string[]; keep: boolean }`, written and tested by subagents' authors. Prune only calls it. If subagents renames `worktree` or adds a cleanup value today, prune would delete the manifest that is the only pointer to a kept worktree. | about 30 lines plus tests |
| 4 | A per-session folder is the session file path without `.jsonl`. | `core/sweep-plan.ts:15` (`SESSION_EXT`), `:103`, `:139` (`stemOf`) | pi's session layout; subagents derives the same stem at `core/model/paths.ts:11` | ACCEPTABLE: it is pi's format, not another extension's. But two extensions now spell the same rule twice. | One `sessionStem(file)` in `platform/pi-adapter` (it owns pi knowledge), used by both. | about 10 lines |
| 5 | Sessions sit in `<agentDir>/sessions/<slug>/*.jsonl`. | `core/sweep-plan.ts:154` | pi | ACCEPTABLE: pi's layout. | Optional: `sessionsRoot(agentDir)` in the adapter, next to #4. | under 10 lines |
| 6 | `parentSession` in a session header links sessions into chains (handoffs, `/fork`, `/clone`, agent child sessions). | `core/sweep-plan.ts:112`; header read with `readSessionHeader` from the adapter (`core/sweep-plan.ts:3`, `:82`) | pi writes the header. session-limits only asks pi for it (`extensions/session-limits/core/limits.ts:381-382`); subagents passes `parentSessionFile` to the child runtime (`extensions/subagents/core/run-agent/runner.ts:764`) | NOT COUPLING: pi's format, read through the adapter. Prune does not know who created the link. | None. | none |
| 7 | Handoff folders are `<handoffRoot>/<session id>/`. | root from `handoffRoot()` (`api/extension.ts:4`, `:18`); entry names treated as session ids in `core/handoff-scan.ts:26-34` and `core/sweep-plan.ts:203-213` | `platform/shared/handoff/handoff-document.ts:58` (`handoffRoot`), `:60-61` (`handoffPath`); used by session-limits (`core/handoff.ts:64`) and subagents (`core/model/paths.ts:13`) | ACCEPTABLE: the layout is owned by `platform/shared`, not by an extension, and prune imports the root. Only "a folder name is a session id" is restated. | Export `handoffDir(sessionId)` from the same shared file and have `handoffPath` use it, so the folder rule is spelled once. | about 5 lines |
| 8 | Liveness: an open session is known by prune's own marker `<agentDir>/pi-prune/live/<id>.<pid>.json`. A pi process that does not load prune writes none. | `core/live-markers.ts`; written in `api/plugin.ts` on every session start | prune | RISK, not coupling to another extension. It assumes prune is enabled in every pi process. A session open in a process without prune is protected only by its mtime against the cutoff (default 180 days, 7 at the shortest `/prune` choice). | "Which sessions are open" is a fact every extension could use. Move the marker writer into `platform/extension-manager` (once per process through the adapter's `globalRecord`), so it holds while any extension of this package is loaded, and keep the reader in prune. Owner question: is any extension loaded enough? | about 100 lines moved |
| 9 | Prune docs say what subagents and session-limits leave on disk. | `extensions/prune/README.md:22`, `:31-32`; `extensions/prune/ARCHITECTURE.md` (rules 4 to 6) | subagents, `platform/shared` | ACCEPTABLE while #1 to #3 stand; docs follow the code. | Moves with #1 to #3. | none |

## Reverse direction: prune in other folders

`git diff origin/main...HEAD --stat -- . ':!extensions/prune'` lists 46 files. What they add:

| # | Change | Where | Rating | Note |
|---|---|---|---|---|
| R1 | `writeHandoffFile` writes once more when the folder vanished between `mkdir` and write, because prune may clear an empty handoff folder at that moment (commit `e45e20b0`). Both handoff writers use it. | `platform/shared/handoff/handoff-file.ts:9-19`; `platform/shared/handoff/handoff-tool.ts`; `extensions/subagents/core/run-agent/runner.ts:399` | ACCEPTABLE: generic, names no extension, harmless when prune is off. It is behaviour that exists because of prune. | Keep. Reword the shared docs to say "a cleaner may remove an empty folder" without naming prune. |
| R2 | Subagents no longer creates an empty handoff folder for every agent (commit `5807964b`). | `extensions/subagents/core/agent-registry/registry.ts:18-19` | NOT COUPLING: a fix that stands on its own. | None. |
| R3 | Restored agent records build the handoff path from the owning session's id (`host.sessionId`, new on `Host`). | `extensions/subagents/api/plugins/agent-registry.ts:33-46`; `platform/pi-adapter/runtime/host.ts:668`; `platform/pi-adapter/types/host-capabilities.ts:65` | NOT COUPLING: a subagents fix. | None. |
| R4 | New generic platform surface used by prune: `readSessionHeader` and `SessionHeader`, `globalRecord` exported, `settingsErrors()` on the plugin context, `scope: "user"` settings, `integer` number rule, `setWidget(…, { above })`. | `platform/pi-adapter/index.ts:3-4`, `:57`; `platform/shared/plugin/plugin-contract.ts:25`; `platform/shared/plugin/settings-files.ts:140-185`; `platform/extension-manager/managed-extension.ts:50-110`; `platform/pi-adapter/ui/create-ui.ts:125-153` | NOT COUPLING in code: none names prune. | Platform docs name prune as the reason ("exported for prune's sweep", "prune refuses to delete while any exist", "which prune sweeps"): `platform/pi-adapter/ARCHITECTURE.md:17`, `platform/pi-adapter/STRUCTURE.md:21`, `platform/shared/ARCHITECTURE.md:21`, `:23`, `:28`, `platform/extension-manager/ARCHITECTURE.md:23`. Reword to describe the feature, not its first user. |
| R5 | Subagents docs say old runs are removed by prune and that prune keeps worktree runs. | `extensions/subagents/README.md:13`, `extensions/subagents/ARCHITECTURE.md:72`, `:75` | ACCEPTABLE as a pointer, but it reads as if prune were always on. | Say "if the prune extension is enabled". |

## Fixed in this PR

- #1: fixed. The run layout (`runsDir`, `RUN_MANIFEST`, `sessionRunsDir`) lives in `platform/shared/agent-runs/`, and prune and subagents import it from there.
- #2: fixed. `fallbackStemsRoot(agentDir)` in `platform/shared/agent-runs/` names the fallback root; prune calls it and subagents reaches it through `sessionRunsDir`, so neither spells `pi-subagents`.
- #3: fixed. `runRules(manifest)` in `platform/shared/agent-runs/` gives the links and the keep rule, and the manifest subagents writes `satisfies` its `RunManifest`.
- #4: fixed. One `sessionStem(file)`, in `platform/shared/agent-runs/` rather than the adapter; prune calls it and subagents reaches it through `sessionRunsDir`.
- #7: not done. Prune never joins the handoff root with a session id: it lists the root's entries, and the root is injected for tests. So `handoffDir` would be used only by `handoffPath`, and knip flagged it as unused.
- R4: fixed. The platform docs no longer name prune as the reason for a feature.
- R5: fixed. The subagents README and architecture say "when the prune extension is enabled".

## With another extension disabled

- Subagents disabled: no new runs appear. Prune still sweeps runs left from before, by the layout it hard-codes. Nothing breaks.
- Session-limits disabled: no `main-handoff.md` and no handoff `parentSession` links. `/fork` and `/clone` still make links through pi. Prune works the same.
- Prune disabled: sessions, runs and handoff folders pile up, as before this branch. Subagents and session-limits do not rely on prune; the only trace is the extra write in `writeHandoffFile` (R1), which then never fires.
- Subagents changes its layout or manifest while prune stays the same: runs are not found and stay (#1, #2), or a run that points at a kept worktree loses its manifest (#3). This is the case the coupling makes dangerous. Worktrees and branches themselves are never removed by prune.

## Not checked

- Whether pi itself can tell which sessions are open, which would make #8 unnecessary.
- Agent child session files inside run folders: prune never scans them as sessions (it reads only `<agentDir>/sessions/<slug>/*.jsonl`, `core/sweep-plan.ts:99`), and removes them with their run. Not traced further.
