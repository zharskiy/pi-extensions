# 00 · Master plan

Restructure `pi-extensions` into enforced layers without changing behaviour. This document is the work order; the detail lives in:

- [01-lint-guardrails.md](01-lint-guardrails.md): Biome and knip configuration, what each rule can express, what stays in `test/architecture.test.ts`.
- [02-target-architecture.md](02-target-architecture.md): current facts, target trees, rules R1–R16, extension-manager changes, per-extension file tables, pi-adapter surface and type revision, renames, phases.
- [03-test-framework-and-evals.md](03-test-framework-and-evals.md): `test-framework/` layout and API, `evals/` runner, CI and packaging changes.
- [04-architecture-plan-review.md](04-architecture-plan-review.md): the review whose findings and reconciled decisions are folded into 01–03.
- [05-pi-evals-research.md](05-pi-evals-research.md): research on pi's evals package; its recommendations are folded into 03, Phases 3, 8 and 9.

## 1. Final root tree

```
pi-extensions/
├── pi-adapter/            only shipped code importing pi packages; index.ts is its surface
│   ├── index.ts  types/  runtime/  child/  ui/  editor/  tools/  context/  prompt/  tests/
├── extension-manager/     plugin runtime, bus, settings watching, createManagedExtension
│   ├── index.ts  extension-manager.ts  managed-extension.ts  bus.ts  watch-settings.ts  tests/
├── ui-kit/                theme-aware rendering components
│   ├── index.ts  row.ts  key-hints.ts  glyphs.ts  list.ts  select.ts  tabs.ts  multi-select.ts  cache-tone.ts  tests/
├── shared/                pi-free, theme-free, host-free helpers
│   ├── index.ts  format.ts  text-layout.ts  settings-files.ts  host-channels.ts  handoff-document.ts  cache-hit.ts  plain-object.ts  plugin-contract.ts  tests/
├── extensions/<name>/     13 extensions
│   ├── index.ts  api/  core/  ui/  tests/  README.md  ARCHITECTURE.md  STRUCTURE.md  (prompts/ agents/)
├── test-framework/        fakes and harnesses; pi/ is the only test code importing pi packages
│   ├── index.ts  fake-*.ts  themes.ts  waiting.ts  extension-harness.ts  valid-handoff.ts  live/  eval-runs/  pi/  pi/live/  tests/
├── evals/                 prompt-quality runs (live, paid, never in CI)
│   ├── README.md  subagents/{planner,reviewer,implementer,routing,support}/
├── test/                  architecture.test.ts
├── docs/                  research/  plans/
├── ARCHITECTURE.md  STRUCTURE.md  AGENTS.md  README.md
├── vitest.config.ts  vitest.live.config.ts  vitest.evals.config.ts
├── biome.json  knip.json  package.json  tsconfig.json
```

Every code folder carries `index.ts`, `ARCHITECTURE.md`, `STRUCTURE.md` and `tests/`. `core/` disappears.

## 2. Layer rules

Direction: `pi-adapter ← shared ← ui-kit ← extension-manager ← extensions(core ← ui ← api ← index.ts) ← test-framework ← evals`.

1. R1 No import cycles (Biome `noImportCycles`).
2. R2 Only `pi-adapter/**` and `test-framework/pi/**` import `@earendil-works/*` or `typebox` (Biome).
3. R3 `pi-adapter/**` imports nothing from the repo; `pi-adapter/types/**` imports only `types/` (Biome).
4. R4 `extension-manager/**` imports only `pi-adapter/index.ts` and `shared/index.ts` (Biome).
5. R5 `shared/**` imports only `pi-adapter/index.ts`; `ui-kit/**` only that and `shared/index.ts` (Biome).
6. R6 Extension code reaches outside its folder only through the four root `index.ts` files and `extensions/<other>/index.ts`; never test code (Biome).
7. R7 `core/` imports own `core/`, `shared/index.ts`, `pi-adapter/index.ts`; never `ui/`, `api/`, `index.ts`, `ui-kit/`, `extension-manager/`, other extensions (Biome).
8. R8 `ui/` imports own `ui/`, `core/`, `ui-kit/index.ts`, `shared/index.ts`, `pi-adapter/index.ts`; never `api/`, `index.ts`, `extension-manager/`, other extensions (Biome).
9. R9 `api/` is the composition root: own `api/`, `core/`, `ui/`, all four roots, and other extensions' `index.ts` (Biome).
10. R10 `extensions/<x>/index.ts` contains only `export … from "./api/…"` (architecture test).
11. R11 `tests/` may import anything in its extension, `test-framework/**`, the four roots' `index.ts`, other extensions' `index.ts` (Biome).
12. R12 `test-framework/**` imports the four roots' `index.ts`; `pi/**` may also import pi packages and adapter internals; pi-free modules never import `pi/**`; nothing imports extensions or evals (Biome + architecture test).
13. R13 `evals/**` imports `test-framework/**`, `extensions/*/index.ts`, `extensions/*/tests/support/**`, the four roots; nothing imports `evals/` (Biome).
14. R14 Folder shape `index.ts api/ core/ ui/ tests/ README.md ARCHITECTURE.md STRUCTURE.md prompts/ agents/`; depth ≤ 3; `*.test.ts` only in `tests/`, `*.eval.ts` only in `evals/`; no `src/`; no duplicate basenames repo-wide among non-index, non-test files (architecture test).
15. R15 No dead code: unused exports, types, enum members, files, dependencies (knip, `includeEntryExports`); unused locals, imports, parameters, private members (Biome); non-API class members `private`/`#` by convention.
16. R16 Repo rules unchanged: no provider or model names outside shipped agent files and the subagents README; writes only under pi's agent/session dir with the listed exceptions.

## 3. Phases

Each phase is one PR that leaves `npm run check` green. Order: **0 → 1 → 2 → 3 → 4 → 5 → 6 → {7a–7l ∥ 7m} → 8 → 9**. Only 7a–7l and 7m run in parallel; they touch disjoint folders. Every other phase depends on the one before it (1 needs the cycle gone; 2 moves files 1 rewired; 3 moves tests onto the barrels 1–2 created; 4 reorganises inside the folder 3 emptied of tests; 5 edits the types 4 split; 6 needs `shared/plugin-contract.ts` from 2 and the harness from 3; 7 needs `createManagedExtension` from 6 and the capability interfaces from 5; 8 needs 7m(iii)'s `tests/support/` paths; 9 needs everything).

### Phase 0 · Break the adapter cycle, add knip
- Goal: a tree on which `noImportCycles`, the unused-code rules and knip run clean.
- Moves: extract `HostState` + `tuiContext` from `core/adapter/pi-ui.ts` into `core/adapter/pi-tui-context.ts`; `pi-notice.ts` and `pi-footer.ts` import it. Fix the 12 baseline findings listed in 01 (`parentTools`, `RowComponent`, `setupLive`, `teardownLive`, `UNKNOWN_LIMIT`, `LIVE_LIMIT`, `REPO_ROOT`, `RUNS_ENV`, `muted`, `SourceSpend`, `ReceiptKind`, `Severity`; Biome `modelLabel`, `live`).
- Config: `biome.json` enables `noImportCycles`, `noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters`, `noUnusedPrivateClassMembers`, `noReExportAll`, `noPrivateImports`, `noSelfImport` at `error`; `knip.json` on today's paths (01 §knip, phase-0 note); `knip` devDependency; `check` = typecheck + lint + knip + test.
- Acceptance: `npm run check` green; `biome lint` reports zero cycles; `knip` reports zero issues.
- Risk: low. Parallelism: none.

### Phase 1 · `core/adapter` → `pi-adapter/`
- Goal: the adapter is a top-level folder with one public surface.
- Moves: `core/adapter/*` → the 02 §2.3 subfolders `pi-adapter/{types,runtime,child,ui,editor,tools,context,prompt}/` with basenames unchanged (`contract.ts` → `types/contract.ts`, `pi-ui.ts` → `ui/pi-ui.ts`, `pi-tui-context.ts` → `ui/pi-tui-context.ts`, …); `core/manager/settle.ts` → `pi-adapter/runtime/settle-within.ts`; `PAD` (layout.ts) and `CHILD_COLUMN`, `isBlankLine`, `childLead` (row.ts) → `pi-adapter/ui/row-layout.ts`, re-imported by `core/manager/{layout,row}.ts` from the barrel; new `pi-adapter/index.ts` with the 02 §6.2 surface; rewrite the 135 import lines of `contract.ts`/`pi-adapter.ts` to `pi-adapter/index.ts`; `core/test/adapter/` stays until phase 3 but imports move to the barrel where the symbol is public.
- Config: `package.json#files` (`pi-adapter/**` minus tests), `tsconfig.json#include`, vitest includes, Biome pi-package override path → `pi-adapter/**`; `pi-adapter/**` override (R3) on; the four generic `extensions/*/…/*.ts` overrides (depths 0–3) on with two groups only, the pi-package ban and `**/pi-adapter/**` + `!**/pi-adapter/index.ts` (the remaining groups arrive in phase 6); knip `project`.
- Acceptance: `npm run check` green; no file outside `pi-adapter/` and `core/test/adapter/` imports `pi-adapter/<anything but index.ts>` (Biome, not grep); `pi-adapter/**` imports nothing from `core/`; every adapter file sits in one of the eight subfolders.
- Risk: medium (touches every extension, paths only). Parallelism: none.

### Phase 2 · `core/manager` → `extension-manager/`, `ui-kit/`, `shared/`
- Goal: infrastructure, rendering components and pure helpers in three folders with barrels; `core/` deleted.
- Moves: 02 §7 table (incl. `settings.ts` split into `shared/settings-files.ts` + `extension-manager/watch-settings.ts`; `plugin.ts`/`bus.ts` types → `shared/plugin-contract.ts`; `cache.ts` → `shared/cache-hit.ts` + `ui-kit/cache-tone.ts`; renames in 02 §9); `core/test/manager/*` → `{extension-manager,ui-kit,shared}/tests/`; rewrite ~130 import lines; `core/test/adapter/pi-transcript.test.ts` imports glyphs from `ui-kit/index.ts`.
- Config: Biome overrides `extension-manager/**` (R4), `shared/**`, `ui-kit/**` (R5) on; `files`, `tsconfig`, vitest, knip paths.
- Acceptance: `npm run check` green; `core/` no longer exists; `grep -rE "(\.\./)+core/" --include=*.ts` finds nothing; README, ARCHITECTURE.md and STRUCTURE.md mentions of `core/` paths point at the new folders.
- Risk: medium (no logic change). Parallelism: none.

### Phase 3 · `test-framework/`, tests → `tests/`
- Goal: one test framework, extension tests in `tests/`, adapter tests in `pi-adapter/tests/`, CI pack check updated.
- Moves: 03 §3 layout (`fake-host.ts`, `fake-agent-runtime.ts`, `themes.ts`, `waiting.ts`, `extension-harness.ts` with `startExtension({ plugins, … })` only (today's `startPlugins`), `valid-handoff.ts` (`VALID_HANDOFF`; subagents keeps its cases in `tests/support/handoff-cases.ts`), `live/`, `eval-runs/`, `pi/`, `pi/live/`); pi-free `eval-runs/run-record.ts` (`RunRecord`, replaces `RunCost`) and `pi/live/session-events.ts` filling it from the live session; `startLiveExtension` and `prepareAgentDir` isolate with a symlinked `auth.json` and a `PI_CODING_AGENT_DIR` override, both restored in teardown; `core/test/adapter/*.test.ts` → `pi-adapter/tests/` (+ `tests/support/fake-pi.ts`, `tests/live/wake.live.test.ts`); each `extensions/<x>/test/` → `tests/`, helpers → `tests/support/`; duplicate theme/key/ANSI helpers deleted; `pi-adapter/index.ts` adds `textMetrics`, `resolveModel`, `CatalogModel`, `ModelPreferences`; names per 02 §9 last rows.
- Config: vitest unit include = explicit list (03 §5); live config `extensions/*/tests/live/**`, `pi-adapter/tests/live/**`; CI grep `'/tests\?/\|test-framework/\|evals/\|\.snap\|fixtures\|\.eval\.ts'` plus positive count of 13 `index.ts` (03 §5); `files` adds `!**/tests/**`; Biome overrides `test-framework/**`, `test-framework/*.ts`+`live/**`+`eval-runs/**`, `test-framework/pi/**`, `evals/**`, `test/**`, `pi-adapter/tests/**` on; `test/architecture.test.ts` reduced to R10/R14/placement/`pi.extensions` rows; knip vitest config list.
- Acceptance: `npm run check` green; `npm run test:live` passes locally for `wake` and the five subagents live tests; `npm pack --dry-run` grep clean.
- Risk: medium (theme helpers differ subtly: close tag, bold marker; keep old semantics behind options). Parallelism: none.

### Phase 4 · pi-adapter internal reorganisation
- Goal: 02 §9 renames and the three file splits inside the subfolders phase 1 created; surface unchanged.
- Moves: renames per 02 §9 (`pi-` prefix dropped; `pi-shared.ts` → `runtime/global-record.ts`, `pi-scope.ts` → `runtime/child-scope.ts`, `route.ts` + `messages.ts` → `runtime/message-text.ts`, `pi-keys.ts` → `ui/key-events.ts`, `pi-context.ts` → `context/context-facts.ts`, `usage.ts`/`pi-usage.ts` → `context/usage-math.ts`/`usage-events.ts`, `pi-tui-context.ts` → `ui/tui-context.ts`, …); splits: `pi-adapter.ts` → `runtime/extension.ts` + `runtime/host.ts`, `pi-tools.ts` → `tools/tool-bridge.ts` + `ui/theme-bridge.ts`, `pi-child.ts` → `child/child-runtime.ts` + `child/child-extension.ts`; `pi-adapter/tests/**` and `test-framework/pi/**` import paths follow.
- Config: Biome `pi-adapter/types/**` override on (R3 types rule).
- Acceptance: `npm run check` green; `pi-adapter/index.ts` diff is paths only; no file under `pi-adapter/` starts with `pi-`; no duplicate basenames under `pi-adapter/`.
- Risk: low. Parallelism: none.

### Phase 5 · pi-adapter type revision
- Goal: narrower types, same strings.
- Changes: `types/` split by domain; `ThemeToken` = `PaintToken | StatusToken | SyntaxToken | ThinkingToken`; `KeyName` sub-unions + `isNavigationKey`; `Host` = capability interfaces + `ui`; `HostUi` = `NoticeUi & OverlayUi & WidgetUi & EditorUi & KeysUi & { style }`; `THINKING_LEVELS as const`, `ThinkingLevel`, `isThinkingLevel` replacing the `.includes` sites; then narrow the `Pick<…>` sites (02 §1) and `session-limits/src/conversation.ts`, `subagents/src/model/{manifest,agent-override}.ts`.
- Config: none.
- Acceptance: `npm run check` green; `tsc` passes with no `as` casts added; the `satisfies Record<ThemeToken, true>` test still compiles.
- Risk: medium (compile-checked, no runtime diff). Parallelism: none.

### Phase 6 · Extension manager: `createManagedExtension`
- Goal: one factory boots every extension; harnesses can boot it without pi.
- Changes: `PluginContext.paths`; `extension-manager/managed-extension.ts` (`namespace`, `root`, `plugins`, `host?`, `settings?` with `afterReload`, `childExclude?` resolved against `root`, `skillInventory?`, `disabled?`, `onError` default rethrow) returning `ExtensionFactory & { boot, options }`; the manager registers the settings reload in `onSessionStart` before any plugin `enable`; subagents `src/index.ts` adopts it with `childExclude: [root]`; `test-framework/extension-harness.ts` `startExtension` gains the `{ extension, … }` form next to `{ plugins, … }`; `test-framework/pi/live/live-extension.ts` `startLiveExtension`; subagents `tests/support/{subagents-harness,live-harness}.ts` on top.
- Tests added: "settings reload runs before plugin session-start handlers"; `isExcluded` rejects relative entries (02 §4).
- Config: the four generic `extensions/*/…/*.ts` overrides get their full group lists (barrels for extension-manager, ui-kit, shared; other-extension rule; test-code bans); `extensions/*/core/**`, `extensions/*/ui/**`, `extensions/*/tests/**` overrides (R7, R8, R11) on; the core/ui ones match nothing until phase 7.
- Acceptance: `npm run check` green; subagents `plugins.test.ts`, settings tests and the live `run-agent` test pass; a child session started from the subagents live test loads no subagents code.
- Risk: medium (subagents boot path). Parallelism: none.

### Phase 7a–7l · Plain extensions, one PR each
- Status: done, with 7m (dd2d4be..a6f77b2).
- Goal: each extension in `index.ts api/ core/ ui/ tests/` on `createManagedExtension`.
- Order (smallest first): command-aliases, composer, working-indicator, style, spending, footer, notifications, questionnaire, context, transcript, mcp-import, session-limits. Moves per 02 §5 tables; `[split]` rows are the only logic cuts.
- Per PR: `src/` → `api/ core/ ui/`, `test/` already in `tests/` (phase 3) gets `support/` where needed, root `index.ts`, `api/extension.ts`, `api/plugin.ts`, per-extension `ARCHITECTURE.md` + `STRUCTURE.md` (behaviour section moved out of the root ARCHITECTURE.md), `pi.extensions` entry → `./extensions/<x>/index.ts`, README path.
- Config: none new (overrides already on). Acceptance: `npm run check` green; the extension's unit tests pass unchanged apart from import paths; Biome reports zero `noRestrictedImports` violations in the folder.
- Risk: low each. Parallelism: all 7a–7l PRs are independent of each other and of 7m; merge in any order.

### Phase 7m · Subagents, three sequential PRs
- (i) `src/model/` + `src/components/` → `core/model/`, `core/components/receipt.ts` + `ui/components/format.ts` (format split, re-exports dropped), `core/agent-setup/scope.ts` extracted, `model-text.ts` → core.
- (ii) `src/plugins/*` logic → `core/<plugin>/`, rendering → `ui/<plugin>/` per 02 §5 ([split] rows).
- (iii) plugin indexes → `api/plugins/*.ts`, `api/plugins.ts`, `api/extension.ts`, root `index.ts`, `tests/support/` final names, per-extension docs, `pi.extensions` entry.
- Acceptance per PR: `npm run check` green; after (iii) `npm run test:live` locally green for the five subagents live tests.
- Risk: medium (70 source, 61 test files). Parallelism: runs alongside 7a–7l; (i)→(ii)→(iii) sequential.

### Phase 8 · `evals/`
- Status: done (c27ac08).
- Goal: the four prompt-quality suites run as evals, not live tests.
- Moves: `planner-plan`, `reviewer-review`, `implementer-change`, `routing` live tests → `evals/subagents/<subject>/*.eval.ts` + `*-cases.ts` on `test-framework/eval-runs` (`repeatRuns`, `expectPassRate(MAJORITY)`, `reportEval`); eval-only helpers → `evals/subagents/support/`; `evals/README.md`.
- Config: `vitest.evals.config.ts` (`evals/**/*.eval.ts`, `pool: "forks"`, `maxWorkers: 1`, serial, 1_800_000 ms); gitignored `evals/.results/<timestamp>/` (`observations.jsonl`, session snapshots of failed runs) with an `evals/.results/` entry in `.gitignore`; `npm run evals`; `PI_EVAL_RUNS` replaces the old plan-runs variable/the old routing-runs variable; knip `entry` adds `evals/**/*.eval.ts`; AGENTS.md documents `npm run evals`.
- Acceptance: `npm run check` green; `npm run test:live` no longer runs the four suites; `npm run evals` runs locally with `PI_LIVE_MODEL`.
- Risk: low. Parallelism: none (depends on 7m(iii)).

### Phase 9 · Docs and lock-down
- Status: in progress.
- Goal: documentation matches the tree; the last exceptions close.
- Changes: root `ARCHITECTURE.md`/`STRUCTURE.md` shortened to rules + links; `ARCHITECTURE.md`/`STRUCTURE.md` for pi-adapter, extension-manager, ui-kit, shared (admission rule), test-framework; AGENTS.md rule sentence ("extensions import each other only through `index.ts`"); README paths; `test/architecture.test.ts` R14 rejects `src/`; knip `includeEntryExports` enforced on the 13 `index.ts`; revisit `vitest-evals` once a release supports vitest 5 (plan 05 §4.4).
- Acceptance: `npm run check` green with the final `biome.json` and `knip.json` from 01; no `src/` folder; `test/architecture.test.ts` is ≤ the rows marked vitest in 01's matrix.
- Risk: low. Parallelism: none.

## 4. Decisions already taken

Cross-extension imports are allowed only through `extensions/<x>/index.ts` and only from `api/` (none exist today). knip is adopted as a devDependency. `createManagedExtension` rethrows boot errors by default. Settings keep getter/watch semantics; the manager owns the reload and registers it before plugins. `childExclude` entries are resolved against the extension root. `settleWithin` and the row-layout constants move into `pi-adapter` so R3 holds without exceptions. `runner.ts` is not split. Evals use `startLiveExtension` from `test-framework/pi/live/` and subagents record types from `extensions/subagents/tests/support/`. `shared/` keeps its name with an admission rule in its `STRUCTURE.md`. The two questions left open in 02 §11 are decided: `api/` stays the composition root (no fifth folder; the folder set `index.ts api/ core/ ui/ tests/` is fixed by the user), and `onEmptyEditorLeft/Down/Escape` stay as three methods. Nothing is open.
