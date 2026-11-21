# Platform audit

> Status: research, phase 2 of the plan in [README.md](README.md). Date: 2026-11-21. Checked at commit `51f54c22`. Read from code only; nothing was run. Users were found with `grep -rlw <export>` over shipped files (`tests/` left out), so a count can be one too high where an extension has a local name that matches.

## The rule this audit applies

The owner's words: "platform/shared must be having something purely shareable, not something specific to an extensions".

How this audit reads it (interpretation, not the owner's words): code under `platform/` names no extension and encodes no format, layout, setting, channel or rule that one extension owns. A format that two or more extensions write, with no single owner, is a separate case. Its place is an open question for the owner (README section 8, question 1).

Ratings:

- **PURE**: generic. It names no extension and holds no extension's format. Stays.
- **SHARED FORMAT**: a format or protocol that two or more extensions write or answer, with no single owner. Stays only if the owner accepts this case (README section 8, question 1).
- **ONE EXTENSION'S**: a format, setting or name that one extension owns, and other extensions only read. Moves to its owner.
- **MIXED**: one file holding both. It is split.

## 1. `platform/shared`

Seventeen modules, `index.ts` left out: 9 PURE, 4 SHARED FORMAT, 2 ONE EXTENSION'S, 2 MIXED.

| Module | What it holds | Users (shipped) | Rating | Owner, destination |
|---|---|---|---|---|
| `agent-runs/agent-runs.ts` | the run manifest file name, the `RunManifest` and `RunCleanup` types, `sessionStem`, `runsDir` = `<stem>/agents` (`:16`), `fallbackStemsRoot` = `<agentDir>/pi-subagents` (`:18`), `sessionRunsDir`, `runRules` (`:26`) | subagents (`core/model/paths.ts:4`), prune (`core/agent-runs.ts`, `sweep-plan.ts`, `sweep-scan.ts`, `sweep-apply.ts`) | ONE EXTENSION'S: subagents writes it, prune only reads it. `:18` names subagents' namespace. Added by PR #43 as an interim step. | subagents: the layout back to `extensions/subagents/core/model/`, and a footprint declaration exported through `extensions/subagents/index.ts` ([footprint-declarations.md](footprint-declarations.md), section 4) |
| `cache-hit.ts` | cache hit percentage from pi's prompt token figures (`:5-14`) | context, footer | PURE: arithmetic over the adapter's `PromptTokens` | stays |
| `channels/host-channels.ts`, generic part | `pi:busy` (`:6`), `pi:background-work` (`:8`), `pi:awaiting-input` (`:12`), their parsers, `trackBusy` (`:56`) | busy: subagents publishes (`api/plugins/agent-registry.ts:19`), notifications and session-limits subscribe. Background work: subagents to transcript. Awaiting input: subagents and questionnaire publish, notifications subscribes | SHARED FORMAT: many publishers, `pi:` names, no owner | stays if the owner accepts shared formats; else to the one subscriber that defines it (notifications for awaiting input) |
| `channels/host-channels.ts`, `pi:handoff-pending` and `pi:held-results` (`:14`, `:16`) | the handoff hold protocol | session-limits publishes pending (`core/limits.ts:131`) and reads held results (`:554`); subagents does the reverse (`api/plugins/run-agent.ts:61`, `:93`) | SHARED FORMAT: a two-way protocol between two extensions | stays, or session-limits, which starts the handoff |
| `channels/host-channels.ts`, usage | `USAGE_CHANNEL = "spending:usage"` (`:10`), `UsageReport` (`:28`), `parseUsageReport` (`:126`) | subagents publishes (`api/plugins/usage-report.ts:9`), spending subscribes (`api/plugin.ts:27`) and parses in `core/spending.ts:3`, `core/ledger.ts:2` | ONE EXTENSION'S: spending's input, named in its namespace | spending |
| `channels/host-channels.ts`, totals | `TOTALS_CHANNEL = "spending:totals"` (`:134`), `SpendingTotals` (`:140`), `agentsSpend`, `sessionSpend` (`:147-149`), `parseTotals` (`:157`) | spending publishes (`api/plugin.ts:24`); footer reads (`api/plugin.ts:24`, `core/segments.ts:9`, `ui/render.ts:10-16`) | ONE EXTENSION'S: spending's output format | spending |
| `channels/host-channels.ts`, limits | `LIMITS_CHANNEL = "session-limits:limits"` (`:178`), `parseLimits` (`:180`) | session-limits publishes (`api/plugin.ts:53`); footer reads (`api/plugin.ts:25`) | ONE EXTENSION'S | session-limits |
| `channels/status-keys.ts` | `HINT_STATUS_PREFIX = "hint:"` (`:1`), `MIRROR_STATUS_PREFIX = "mirror:"` (`:3`) | footer reads both (`core/segments.ts:55`, `:59`); subagents writes `hint:subagents` (`api/plugins/agent-panel.ts:17`); spending writes `mirror:spending` (`api/plugin.ts:10`) | ONE EXTENSION'S: footer's rule for placing statuses | footer |
| `guards.ts` | `isPlainObject`, `isFiniteNumber`, `isStringArray` | context, mcp-import, prune, spending, subagents, transcript | PURE | stays |
| `handoff/handoff-document.ts` | `handoffRoot` = `<tmp>/pi-handoff` (`:58`), `handoffPath` (`:60-61`), the request and seed entry types (`:14`, `:16`), validation, the tool-row contract | session-limits, subagents write; ui-kit renders; prune reads the root (`extensions/prune/api/extension.ts:4`) | SHARED FORMAT: two writers (session-limits `core/handoff.ts:64`, subagents `core/model/paths.ts:12`) | stays if the owner accepts shared formats; else session-limits (see 4) |
| `handoff/handoff-file.ts` | write a file, once more if the folder vanished (`:9-19`) | subagents (`core/run-agent/runner.ts:399`), `handoff-tool.ts:45` | PURE: generic despite its name | stays; a generic name would suit it |
| `handoff/handoff-limit.ts`, generic part | `HandoffLimit`, `LimitLevel`, `limitLevel` (`:17`, `:30-32`), `WORKING_CONTEXT`, `workingContextText` (`:44-46`) | footer, session-limits, subagents, ui-kit | SHARED FORMAT: the level scale both handoff writers and the footer use | stays with the handoff protocol |
| `handoff/handoff-limit.ts`, settings part | `Limits` (`:4`), `limitsSchema` (`:10`), `mainLimit` (`:19`) | `limitsSchema`: session-limits only (`api/extension.ts:3`, `:12`); `mainLimit`: session-limits, footer (`core/segments.ts:8`, `:64`) | ONE EXTENSION'S: session-limits' settings and their meaning | session-limits |
| `handoff/handoff-prompt.ts` | handoff instruction, seed text, retry text | session-limits, subagents | SHARED FORMAT | with the handoff protocol |
| `handoff/handoff-seam.ts` | `LIMIT_SEAM`, `seamLabel` | session-limits, subagents | SHARED FORMAT | with the handoff protocol |
| `handoff/handoff-tool.ts` | the handoff tool definition | session-limits, subagents | SHARED FORMAT | with the handoff protocol |
| `plugin/plugin-contract.ts` | `Plugin`, `Bus` and the plugin context types | all fifteen extensions, the manager | PURE | stays |
| `plugin/settings-files.ts` | settings file load, read, write, paths | manager, mcp-import, prune, style, subagents | PURE | stays |
| `project-dir.ts` | `projectPath` (`:29`), `ensureProjectSubdir` (`:31`), `writeProjectFile` (`:45`) | subagents only | PURE: generic, and `AGENTS.md:18` names it as the only way to write under `<cwd>/.pi/`. One user today. | stays |
| `text/format.ts`, `text/front-matter.ts`, `text/text-layout.ts` | formatting, front matter, `DOT` and line layout | many; `parseFrontmatter`: style, subagents | PURE | stay |

The docs say the same in words: `platform/shared/ARCHITECTURE.md` names subagents 14 times, session-limits 11, footer 9, spending 5 (counted with `grep -o -i -w`). Each mention needs rewording or moves with its module.

## 2. `platform/ui-kit`

| Module | Finding | Rating | Destination |
|---|---|---|---|
| `context-limit.ts` | `limitFigure` (`:15`) and `limitTail` (`:22`): footer only. `limitLine` (`:25`): subagents only. `handoffNotice` (`:28`): session-limits and subagents. `NO_MODEL` (`:13`): context and footer. All draw the shared limit level. | MIXED | `limitFigure` and `limitTail` to footer, `limitLine` to subagents, `handoffNotice` with the handoff protocol. Each has one user, so moving is plain. |
| `handoff-rows.ts` | rows for the handoff request, seed and tool (`:49`, `:74`, `:85`) | session-limits and subagents | SHARED FORMAT, with the handoff protocol |
| `row.ts`, `list.ts`, `select.ts`, `multi-select.ts`, `tabs.ts`, `key-hints.ts`, `glyphs.ts`, `cache-tone.ts` | generic widgets. Several have one user today (for example `groupedTabBar`, `multiSelectForm`, `scrolledLines`), but none encodes that user's data. | PURE | stay |

## 3. `platform/pi-adapter` and `platform/extension-manager`

- **pi-adapter**: no shipped `.ts` file names an extension, except `ui/footer.ts:17` `FOOTER_WIDGET_KEY = "pi-footer"`, which is the footer extension's namespace (`extensions/footer/api/extension.ts:6`). Many exports have one user (for example `readSessionHeader`: prune; `resolveModel`: subagents). That is expected: the adapter is the only way to reach pi (`AGENTS.md:15`), so each pi capability lives there whoever uses it. Rating: PURE, with the one key to rename to something generic. Its docs name extensions (`ARCHITECTURE.md`: subagents 8 times, transcript 12, context 14, which is partly the plain word "context").
- **extension-manager**: code names no extension. `ARCHITECTURE.md:11` and `:17` name session-limits and subagents as examples, and `:25` lists subagents' bus events. Rating: PURE; reword the docs.

## 4. What the strict reading cannot do under today's rules

- A consumer's `core/` or `ui/` may not import another extension (`biome.json:567-569`). Footer uses `mainLimit` in `core/segments.ts:8`, `:64`, the `SpendingTotals` type in `core/segments.ts:9`, `:20`, and `agentsSpend`, `sessionSpend` in `ui/render.ts:10`, `:16`, `:93`, `:109`. If those move to session-limits and spending, footer's `api/` has to import them and pass values down, or footer gets its own copy of the type. Both need care; a copy is the drift the plan wants to stop.
- Subagents uses `handoffPath` in `core/model/paths.ts:12`. If session-limits owned the handoff protocol, subagents' `core/` could not import it. So the handoff protocol has no extension that can own it under today's import rules; it is a real shared format.
- Each `index.ts` may only re-export from `./api/` (`test/architecture.test.ts:450`). A published format has to sit in, or be re-exported by, the owner's `api/`. Importing an owner's `index.ts` also loads its `api/extension.ts` and everything below it, since `index.ts` re-exports the default factory (every `extensions/*/index.ts` is that one line today).
