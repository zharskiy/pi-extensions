# 02 · Target architecture

Technical restructuring of `pi-extensions`. Product behaviour stays identical; every phase ends with `npm run check` green. Facts in section 1 were verified against the tree on branch `refactor/modular-architecture`. Revision 2 applies the review in [04-architecture-plan-review.md](04-architecture-plan-review.md): all 20 findings were re-verified against the source and taken; none is disputed.

## 1. Current state

| Area | Verified facts |
| --- | --- |
| Layers | `core/adapter` (37 files, 4,895 lines) is the only place importing pi packages; `core/manager` (18 files, 1,437 lines) mixes plugin infrastructure (`extension-manager`, `plugin`, `bus`, `settle`) with shared helpers (`format`, `layout`, `row`, `hints`, `marks`, `list`, `select`, `tabs`, `multi-select`, `cache`, `settings`, `channels`, `handoff`, `guards`). |
| Adapter → manager | Four adapter files import the manager: `pi-child.ts:17` (`settleWithin`), `pi-notice.ts:2` (`PAD`), `pi-row-component.ts:2` (`CHILD_COLUMN`, `isBlankLine`), `pi-tool-rows.ts:4` (`childLead`). Also `core/test/adapter/pi-transcript.test.ts:8` imports `manager/marks.ts`. |
| Cycle | One runtime import cycle: `pi-footer.ts:9 → pi-notice.ts:6 (tuiContext from pi-ui.ts) → pi-ui.ts:19 (createFooterSetter from pi-footer.ts)`. Biome `noImportCycles` flags exactly these three files. |
| Extensions | 13 extensions, `extensions/<name>/src/**` (139 files, 14,206 lines) and `extensions/<name>/test/**` (22,298 lines). Only **subagents** uses `createExtensionManager` (11 plugins); the other 12 call `createPiExtension((host, runtime, paths) => createX(...), { root, namespace })` directly. Only style and session-limits read `paths.root` in that callback. |
| Imports from core | 135 adapter import lines outside `core/adapter` (`contract.ts` 122, `pi-adapter.ts` 14, test helpers the rest); manager helpers: `format` 23, `layout` 17, `hints` 16, `row` 13, `marks` 13, `settings` 10, `channels` 9, `guards` 7, `cache`/`tabs`/`select`/`list` 4 each, `multi-select`/`handoff` 3, `extension-manager`/`plugin`/`bus`/`settle` 1 each (all subagents). |
| Guardrails today | `test/architecture.test.ts` (import scan) plus Biome `noRestrictedImports` for `@earendil-works/*` and `typebox` outside `core/adapter/**` and `core/test/adapter/**`. No cycle detection, no dead-code check. Biome 2.5.15 ships `noImportCycles`; knip 6 is the dead-code tool (plan 01). |
| Biggest unions | `core/adapter/contract.ts:10` `ThemeToken` 18 members (7 of them `thinking*`); `contract.ts:104` `KeyPress.name` 16 members. Wide interfaces: `contract.ts:299` `Host` 32 members incl. `ui`; `contract.ts:204` `HostUi` 23 methods. Ad-hoc `Pick<Host \| HostUi, …>` narrowings: `pi-editor.ts:155`, `pi-editor-input.ts:5`, `pi-usage.ts:8`, `pi-ui.ts:97`, `pi-working.ts:6`, `pi-footer.ts:123`, `pi-context.ts:51`, `pi-entries.ts:29`, `subagents/src/model/manifest.ts:9,25,52` (`pi-tools.ts:136` is a `Pick` of pi's own render context, not of `Host`). |
| Other unions (fine as domain enums) | `pi-phase.ts:11 PhaseEvent` 5; `manager/marks.ts:13 Mark` 5; `context/src/breakdown.ts:6 CategoryKey` 9; `context/src/buckets.ts:11 MessageKey` 6; `session-limits/src/thresholds.ts:12 Phase` 6; `subagents/src/model/types.ts:7 AgentState` 7; `components/format.ts:12 ReceiptKind` 7; `agent-definitions/fields.ts:13 FieldKind` 6. `THINKING_LEVELS` (`contract.ts:391`) is `readonly string[]`, not a tuple. |
| Test tooling | `core/test/helpers/fakes.ts` (913 lines, 74 importers; imports `resolveModel` from `model-resolver.ts` and `textMetrics` from `pi-tools.ts`), `fake-form.ts`, `keys.ts`; `core/test/adapter/{offline,live,render-theme,tool-rows}.ts` (`live.ts` imports pi packages directly); subagents `test/helpers/*` (10 files) + `test/plugins/agent-setup/setup-context.ts`; `context/test/fixtures.ts`, `questionnaire/test/fixtures.ts`, `transcript/test/helpers.ts`. `VALID_HANDOFF` lives in subagents but the same document is inlined in `session-limits/test/limits.test.ts:48` and `handoff.test.ts:28`. |
| Live tests | 10 files: `core/test/adapter/wake.live.test.ts` and 9 under `extensions/subagents/test/live/`. Four (`planner-plan`, `reviewer-review`, `implementer-change`, `routing`) run N concurrent runs and assert a majority threshold: they score prompt quality, not behaviour. |
| Packaging | `package.json#files` lists `core/adapter`, `core/manager`, `extensions/*/src/**`, prompts, agents, READMEs, root docs; `pi.extensions` lists 13 × `./extensions/<name>/src/index.ts`; CI runs `npm pack --dry-run` and fails on `/test/\|\.snap\|fixtures`. `tsconfig.json#include` = `core`, `extensions`, `test`, two vitest configs. npm 11 honours `!**/tests/**` in `files`; brace patterns like `extensions/*/{index.ts,api}/**` do not match files (review finding 3). |
| Child exclusion | `pi-child.ts:125` `isExcluded` resolves exclude entries against **cwd** (`resolve(dir)`) and compares absolute paths; subagents passes `[join(root, "src")]` today. Relative entries would match nothing. |
| Settings timing | `core/manager/settings.ts:161` `watchSettings` reloads in `host.onSessionStart` because `cwd` and `projectTrusted` are only known then; `extensions/subagents/src/index.ts` registers its settings reload **before** `createExtensionManager`, so plugins enabled later see fresh settings on the same event. |

## 2. Target layout

### 2.1 Repo root

```
pi-extensions/
├── pi-adapter/            the only shipped code importing pi packages (was core/adapter)
├── extension-manager/     plugin runtime, bus, settings watching, managed-extension factory (was core/manager, infra part)
├── ui-kit/                theme-aware rendering helpers shared by extensions (was core/manager, UI part)
├── shared/                pi-free, theme-free, host-free helpers: text formatting, settings files, channels protocol, handoff document, plugin contract types
├── extensions/<name>/     13 extensions, each api/ core/ ui/ tests/ index.ts (+ README.md, prompts/, agents/)
├── test-framework/        fakes, harnesses, pi-backed test helpers (pi/), live mechanics (pi/live/), eval runner (eval-runs/)
├── evals/                 prompt and agent-frontmatter quality runs (live, paid, never in CI)
├── test/                  repo-wide architecture test (what Biome and knip cannot express)
├── docs/                  research/, plans/
├── ARCHITECTURE.md        rules + links (short)
├── STRUCTURE.md           top-level tree + links (short)
├── AGENTS.md
├── vitest.config.ts  vitest.live.config.ts  vitest.evals.config.ts
├── biome.json  knip.json
└── package.json  tsconfig.json
```

Every top-level code folder has `index.ts` (public surface), `ARCHITECTURE.md`, `STRUCTURE.md`, and `tests/`. `shared/STRUCTURE.md` states the admission rule: a module may live there only if it imports nothing but `pi-adapter/index.ts` types and node built-ins, takes no `Host`, and paints no theme; anything else belongs to `ui-kit/` or `extension-manager/`.

### 2.2 One extension

```
extensions/footer/
├── index.ts               export { default } from "./api/extension.ts"; export type … from "./api/types.ts"
├── api/                   composition root and public types; may import core and ui
│   ├── extension.ts       export default createManagedExtension({ namespace: "pi-footer", root, plugins: [footerPlugin] })
│   ├── plugin.ts          the Plugin object: enable(ctx) wires host, core and ui
│   └── types.ts           types another extension may consume (channel payloads, settings shape)
├── core/                  business logic; imports pi-adapter types, shared/, own core only
├── ui/                    rendering, overlays, forms, key handling; imports own core, ui-kit, shared, pi-adapter
├── tests/                 unit tests, fixtures, *.live.test.ts; local helpers in tests/support/
├── README.md              user-facing (unchanged)
├── ARCHITECTURE.md        behaviour: what the plugin does at runtime (moved out of root ARCHITECTURE.md)
├── STRUCTURE.md           file map of api/core/ui/tests
└── prompts/ agents/       non-code assets where they exist today
```

Folders that would be empty are omitted (command-aliases has no `ui/`); the folder-shape rule restricts allowed names, it does not require presence.

### 2.3 pi-adapter

```
pi-adapter/
├── index.ts                      public surface (section 6.2)
├── types/                        contract.ts split by domain; imports nothing but other types/ files
│   ├── theme.ts                  ThemeToken (= PaintToken|StatusToken|SyntaxToken|ThinkingToken), BgToken, ThemeLike
│   ├── keys.ts                   KeyPress, KeyName = NavigationKey|EditKey|AppKey|"other", isNavigationKey
│   ├── host.ts                   Host = ToolHost & PromptHost & LifecycleHost & MessagingHost & EntryHost & SessionHost & { ui }
│   ├── host-ui.ts                HostUi = NoticeUi & OverlayUi & WidgetUi & EditorUi & KeysUi & { style }
│   ├── runtime.ts                AgentRuntime, ChildSession, ChildEvent, SpawnSpec, StopReason, MessageDelivery
│   ├── tools.ts                  ToolSpec, AnyToolSpec, ToolResult, ToolRenderState, ToolCallView, ToolRow(s), RowLines
│   ├── session.ts                SessionInfo, SessionControl, NewSessionOptions, RunMode, ShutdownReason, Phase, DialogKind/Event, IdleInfo
│   ├── context.ts                ContextSnapshot, ContextFacts, ContextSection, ContextTool, ContextMessage, MessageBlock, PromptTokens
│   ├── usage.ts                  UsageTotals, emptyUsage, addUsage
│   ├── model.ts                  ModelInfo, ModelChoice, ModelResolution, AvailableModel, THINKING_LEVELS (as const), ThinkingLevel, splitModelRequest
│   ├── view.ts                   ViewComponent, OverlayApi/Factory, FormApi/Factory, TextInput, ScrollPane, TranscriptPane, TranscriptItem, WidgetHandle, EditorFrame/Layout, EditorKeyHandler, FooterData/Render, EntryRender, MessageRender
│   └── messages.ts               HiddenMessage, RoutedMessage, CommandSpec, PromptTool, SkillInfo, SessionRecord, CodemodeShortfall
├── runtime/                      pi session wiring
│   ├── extension.ts              ← pi-adapter.ts (createPiExtension, mcpBuiltinLoaded, sessionSkillFiles, parentTools)
│   ├── host.ts                   ← pi-adapter.ts (createPiHost, phase reducer, held hidden messages)
│   ├── phase.ts                  ← pi-phase.ts
│   ├── child-scope.ts            ← pi-scope.ts (childScope, insideChildSession)
│   ├── global-record.ts          ← pi-shared.ts (shared() → globalRecord())
│   ├── settle-within.ts          ← core/manager/settle.ts (settleWithin; the adapter is its first consumer)
│   ├── session-file.ts           ← session-file.ts
│   └── message-text.ts           ← messages.ts + route.ts (formatRoutedMessage)
├── child/                        spawning and configuring child sessions
│   ├── child-runtime.ts          ← pi-child.ts (createPiRuntime, childSettings, childToolNames, isExcluded)
│   ├── child-extension.ts        ← pi-child.ts (createChildExtension, ParentSource)   [split]
│   ├── model-catalog.ts          ← pi-models.ts
│   ├── model-resolver.ts         ← model-resolver.ts
│   ├── skills.ts                 ← pi-skills.ts
│   └── codemode.ts               ← pi-codemode.ts
├── ui/                           HostUi implementation on pi-tui
│   ├── tui-context.ts            ← pi-ui.ts (HostState, tuiContext) — extracted to break the footer→notice→ui cycle
│   ├── create-ui.ts              ← pi-ui.ts (createUi, createScrollPane)
│   ├── form.ts                   ← pi-form.ts
│   ├── overlay.ts                ← pi-overlay.ts
│   ├── text-input.ts             ← pi-text-input.ts
│   ├── notices.ts                ← pi-notice.ts
│   ├── footer.ts                 ← pi-footer.ts
│   ├── working-message.ts        ← pi-working.ts
│   ├── thinking-label.ts         ← pi-thinking-label.ts
│   ├── key-events.ts             ← pi-keys.ts
│   ├── row-layout.ts             ← core/manager/layout.ts PAD + row.ts CHILD_COLUMN, isBlankLine, childLead (adapter-owned row constants)
│   └── theme-bridge.ts           ← pi-tools.ts (piColor, themeLike, textMetrics, fitLines)   [split]
├── editor/
│   ├── editor.ts                 ← pi-editor.ts
│   ├── history.ts                ← pi-editor-history.ts
│   └── input.ts                  ← pi-editor-input.ts
├── tools/                        tool registration and rendering bridges
│   ├── tool-bridge.ts            ← pi-tools.ts (toPiTool, toPiResult, fromPiResult)   [split]
│   ├── tool-rows.ts              ← pi-tool-rows.ts
│   ├── row-component.ts          ← pi-row-component.ts
│   ├── entry-renderers.ts        ← pi-entries.ts
│   └── transcript.ts             ← pi-transcript.ts (capturePiRenderers, createTranscriptPane)
├── context/
│   ├── context-facts.ts          ← pi-context.ts
│   ├── context-messages.ts       ← pi-context-messages.ts
│   ├── context-prompt.ts         ← pi-context-prompt.ts
│   ├── usage-math.ts             ← usage.ts
│   └── usage-events.ts           ← pi-usage.ts
├── prompt/
│   ├── main-prompt.ts            ← main-prompt.ts
│   └── sections.ts               ← pi-sections.ts
├── tests/                        ← core/test/adapter/*.test.ts; tests/live/wake.live.test.ts; tests/support/fake-pi.ts (fake pi ExtensionAPI, 9 copies today)
├── ARCHITECTURE.md  STRUCTURE.md
```

The `pi-` prefix disappears: the folder name already says it. No two files in `pi-adapter/` share a basename (review finding 17).

## 3. Layer rules

| # | Rule | Enforced by |
| --- | --- | --- |
| R1 | No import cycles anywhere. | Biome `noImportCycles` |
| R2 | Only `pi-adapter/**` and `test-framework/pi/**` may import `@earendil-works/*` or `typebox`. | Biome override per folder; architecture test re-checks placement |
| R3 | `pi-adapter/**` imports nothing from the repo outside `pi-adapter/`. `pi-adapter/types/**` imports only other `types/` files. | Biome `pi-adapter/**` override (bans `**/extensions/**`, `**/extension-manager/**`, `**/ui-kit/**`, `**/shared/**`, `**/test-framework/**`, `**/evals/**`, `**/test/**`) |
| R4 | `extension-manager/**` may import `pi-adapter/index.ts` and `shared/index.ts`; must not import `ui-kit/`, `extensions/`, `test-framework/`, `evals/`. | Biome |
| R5 | `shared/**` may import `pi-adapter/index.ts` only. `ui-kit/**` may import `pi-adapter/index.ts` and `shared/index.ts` only. | Biome |
| R6 | Code in `extensions/<x>/` reaches outside the extension only through `pi-adapter/index.ts`, `extension-manager/index.ts`, `ui-kit/index.ts`, `shared/index.ts`, and `extensions/<y>/index.ts`; never `test-framework/`, `evals/`, `test/`. Deep imports into another extension are forbidden. (Today no extension imports another; the plan introduces none.) | Biome, one override per folder depth |
| R7 | `extensions/<x>/core/**` may import own `core/`, `shared/index.ts`, `pi-adapter/index.ts`. Must not import own `ui/`, own `api/`, own `index.ts`, `ui-kit/`, `extension-manager/`, or any other extension. | Biome |
| R8 | `extensions/<x>/ui/**` may import own `ui/`, own `core/`, `ui-kit/index.ts`, `shared/index.ts`, `pi-adapter/index.ts`. Must not import own `api/`, own `index.ts`, `extension-manager/`, or any other extension. | Biome |
| R9 | `extensions/<x>/api/**` may import own `api/`, `core/`, `ui/`, `extension-manager/index.ts`, `ui-kit/index.ts`, `shared/index.ts`, `pi-adapter/index.ts`, and `extensions/<y>/index.ts`. The only place a foreign extension surface may enter. | Biome |
| R10 | `extensions/<x>/index.ts` contains only `export … from "./api/…"` statements. | architecture test |
| R11 | `extensions/<x>/tests/**` may import anything inside the extension, `test-framework/**` (incl. `test-framework/pi/**`), and the four shared roots through their `index.ts`. Must not import another extension except via its `index.ts`. | Biome |
| R12 | `test-framework/**` may import `pi-adapter/index.ts`, `extension-manager/index.ts`, `ui-kit/index.ts`, `shared/index.ts`; `test-framework/pi/**` may additionally import pi packages and `pi-adapter/**` internals. Root modules of `test-framework/` never import `test-framework/pi/**`. Nothing in `test-framework/` imports `extensions/` or `evals/`. | Biome (+ architecture test for the root→pi check) |
| R13 | `evals/**` may import `test-framework/**`, `extensions/*/index.ts`, `extensions/*/tests/support/**`, and the four shared roots. Nothing imports `evals/`. | Biome |
| R14 | Folder shape: `extensions/<x>/` contains only `index.ts`, `api/`, `core/`, `ui/`, `tests/`, `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `prompts/`, `agents/`; source depth ≤ 3 below `extensions/<x>/` (the Biome overrides cover depths 0–3). `*.test.ts` only in `tests/`; `*.eval.ts` only in `evals/`; no `src/` folder anywhere; no duplicate basenames repo-wide among non-index, non-test files. | architecture test |
| R15 | Dead code: no unused exports, exported types, enum members, files or dependencies (knip, `includeEntryExports: true`); no unused locals, imports, parameters or private class members (Biome). Public class members: convention `private`/`#` for non-API members (no tool covers them). | knip + Biome |
| R16 | Unchanged repo rules: no provider or model names outside shipped agent files and the subagents README; writes only under pi's agent/session dir with the listed exceptions. | review + existing tests |

Direction in one line: `pi-adapter ← shared ← ui-kit ← extension-manager ← extensions(core ← ui ← api ← index.ts) ← test-framework ← evals`.

Biome overrides match paths, so the `extensions/*/core/**` and `extensions/*/ui/**` overrides can be enabled before any extension is converted: they match nothing until a `core/` or `ui/` folder exists. No allowlists are needed.

## 4. Extension manager changes

Today's API (`createExtensionManager({ host, runtime, settings, plugins, root, disabled, onError })` returning `{ bus, services, disableAll }`, `Plugin<E,S,C> = { id, requires?, enable(ctx) }`) stays. Changes:

| Change | Why / parity requirement |
| --- | --- |
| `Plugin`, `PluginContext`, `Disable`, `Bus`, `BusOf`, `ServiceRegistry` types move to `shared/plugin-contract.ts`; `extension-manager/index.ts` re-exports them. | `core/` files (`subagents/src/model/plugin.ts`, `model/events.ts`) import these types; R7 bans `extension-manager/` from `core/`, and Biome cannot exempt type-only imports in `noRestrictedImports`. |
| `PluginContext` gains `paths: { root, agentDir }`. | style and session-limits read `paths.root` in the boot callback today; subagents reads `paths.agentDir`. Additive. |
| `createManagedExtension<E,S,C>(options)` in `extension-manager/managed-extension.ts` returns `ExtensionFactory & { boot, options }`. | One call replaces the hand-written boot in every `index.ts`; `boot` is what `test-framework` harnesses (`startExtension`, `startLiveExtension`) run against fakes or a live runtime without going through pi. |
| `options.host?: (host: Host) => Host` | session-limits wraps the host with `conversationOnly` before anything sees it. |
| `options.settings?: { defaults: S; schema: SettingsSchema<S>; file: string; afterReload?(settings: S, info: SessionInfo, runtime: AgentRuntime): string[] }` | The manager calls `watchSettings` itself, registers the reload in `host.onSessionStart` **before** any plugin `enable` (today's subagents order), patches `ctx.settings` in place and reports `afterReload` warnings via `host.ui.notify(…, "warning")`. Plugins read `ctx.settings.x` at use time, which equals today's getter semantics in notifications and session-limits. Omitted → `S = undefined`. A unit test in `extension-manager/tests/` asserts "settings reload runs before plugin session-start handlers". |
| `options.childExclude?: string[]` is resolved against `paths.root` before reaching `createPiRuntime`. Subagents passes `childExclude: [root]` (the whole extension folder). | `isExcluded` (`pi-child.ts:125`) resolves against cwd; relative entries match nothing and the extension would load inside every child session (review finding 1). The new entry `extensions/subagents/index.ts` sits outside `api/core/ui`, so the whole folder is the right exclusion; `prompts/` and `agents/` are neither tools nor extensions. A unit test on `isExcluded` with a relative entry guards this. The 12 plain extensions pass no `childExclude`, as today. |
| `options.onError` default rethrows. | Today a plain extension's boot error propagates to pi; keep that. Subagents passes its notify handler as it does now. |
| `extension-manager/index.ts` exports `createExtensionManager`, `createManagedExtension`, `createBus`, `watchSettings`, `reportSettingsErrors` and re-exports the `shared/plugin-contract` types. | Single import for `api/` code. `parseSettings`, `readText`, `readSettingsFile`, `userSettingsPath`, `projectSettingsPath`, `readSettingsFiles`, `loadSettingsFiles`, `SettingsSchema` go to `shared/settings-files.ts` (used by `core/` files: `runner.ts:15`, `agent-setup/write.ts:4`, four `settings.ts`). |

Behaviour parity notes: a single plugin whose `enable` returns `undefined` makes `disableAll()` a no-op, identical to today's plain extensions which register nothing to undo. `skillInventory` passes straight through to `createPiExtension`. Namespaces (`pi-<name>`) and entry keys are unchanged, so session entries and settings files are untouched.

Sketch, `extensions/footer/api/` and `index.ts`:

```ts
// api/plugin.ts
export const footerPlugin: Plugin<never, {}, undefined> = {
  id: "footer",
  enable({ host }) { return createFooter(host); },   // today's createFooter body, unchanged
};

// api/extension.ts
export default createManagedExtension({
  namespace: "pi-footer",
  root: join(import.meta.dirname, ".."),   // extension root; api/ is one level down, as src/ was
  plugins: [footerPlugin],
});

// index.ts
export { default } from "./api/extension.ts";
```

Subagents keeps its 11 plugins and passes `childExclude: [root]`, `skillInventory: true`, `settings: { defaults: defaultSettings(), schema, file: SETTINGS_FILE, afterReload: checkModels }`, `disabled: disabledPlugins(agentDir)`, `onError: notify`.

## 5. Per-extension migration

Legend: `→ api/…` composition root or public type; `→ core/…` logic; `→ ui/…` rendering. `[split]` = file mixes layers and is cut as described. `index.ts` always becomes root `index.ts` + `api/extension.ts`; tests move `test/` → `tests/` unchanged unless noted; local test helpers go to `tests/support/`. Every manager import is rewritten: `format`/`layout` → `shared/`, `settings` → `shared/settings-files` (or the manager's `settings` option for `watchSettings`), `channels` → `shared/host-channels`, `guards` → `shared/plain-object`, `handoff` → `shared/handoff-document`, `hints`/`row`/`marks`/`list`/`select`/`tabs`/`multi-select` → `ui-kit/`.

### command-aliases
| Current | New | Note |
| --- | --- | --- |
| src/command-aliases.ts | api/plugin.ts | 29 lines, registers commands; no ui/ folder. |
| src/index.ts | index.ts + api/extension.ts | |

### composer
| Current | New | Note |
| --- | --- | --- |
| src/composer.ts | api/plugin.ts | |
| src/frame.ts | ui/frame.ts | `createFrame`, `CHEVRON`. |

### context
| Current | New | Note |
| --- | --- | --- |
| src/breakdown.ts | core/breakdown.ts | `cache` maths → `shared/cache-hit`. |
| src/buckets.ts | core/buckets.ts | |
| src/snapshot.ts | core/snapshot.ts | |
| src/summary.ts | ui/summary.ts | text with `format`/`layout`; presentation. |
| src/grid.ts | ui/grid.ts | |
| src/details.ts | ui/details.ts | |
| src/render.ts | ui/render.ts | |
| src/context.ts | api/plugin.ts | wiring (command, overlay). |
| test/fixtures.ts | tests/support/context-snapshots.ts | local. |

### footer
| Current | New | Note |
| --- | --- | --- |
| src/footer.ts | api/plugin.ts + core/status.ts | [split] channel subscriptions and status state → core; `setFooter` wiring → api. |
| src/render.ts | ui/render.ts + core/segments.ts | [split] channel payload parsing (`host-channels`, `cache-hit`) → core; painting (`cache-tone`) stays ui. |

### mcp-import
| Current | New | Note |
| --- | --- | --- |
| src/args.ts, convert.ts, plan.ts, sources.ts | core/ (same names) | pure. |
| src/report.ts | ui/report.ts | formats the report text. |
| src/pick.ts | ui/pick.ts | select / multi-select overlay. |
| src/mcp-import.ts | api/plugin.ts + core/import-flow.ts | [split] command flow (read sources → plan → apply) → core; command registration, picker, notify → api. `settings` import → `shared/settings-files`. |

### notifications
| Current | New | Note |
| --- | --- | --- |
| src/notifications.ts | core/notifications.ts + api/plugin.ts | [split] wait tracking, timers, idle/dialog logic → core (takes `NoticeUi & LifecycleHost`); subscriptions and `terminalNotify` wiring → api. |
| src/settings.ts | core/settings.ts | schema + defaults; imports `shared/settings-files`. |
| src/index.ts | index.ts + api/extension.ts | `watchSettings` → `settings: { defaults, schema, file }`. |

### questionnaire
| Current | New | Note |
| --- | --- | --- |
| src/result.ts | core/questions.ts | types, normalisation, result text. |
| src/questionnaire.ts | api/plugin.ts + core/questionnaire.ts | [split] tool param validation and awaiting-input channel state → core; tool registration + `showForm` → api. |
| src/form.ts, render.ts, view.ts, summary.ts | ui/ (same names) | |
| test/fixtures.ts | tests/support/questions.ts | local; drop the `key` re-export. |

### session-limits
| Current | New | Note |
| --- | --- | --- |
| src/conversation.ts | core/conversation-host.ts | Host wrapper; becomes the `host` option of `createManagedExtension`. Typed against capability interfaces after phase 5. |
| src/handoff.ts | core/handoff.ts | uses `shared/handoff-document`. |
| src/thresholds.ts | core/thresholds.ts + ui/threshold-text.ts | [split] ratio maths → core; `marks` glyph text → ui. |
| src/limits.ts (577) | core/limits.ts + ui/limit-messages.ts + api/plugin.ts | [split] state machine and channel publishing → core; `hints` strings → ui; host wiring → api. |
| src/seed-row.ts | ui/seed-row.ts | |
| src/settings.ts | core/settings.ts | imports `shared/settings-files`. |
| src/index.ts | index.ts + api/extension.ts | `host: conversationOnly`, `settings: {…}`, reads `prompts/handoff.md` via `ctx.paths.root`. |

### spending
| Current | New | Note |
| --- | --- | --- |
| src/ledger.ts | core/ledger.ts | |
| src/spending.ts | core/spending.ts + api/plugin.ts | [split] totals and channel maths → core; subscriptions/status key → api. |
| src/footer.ts | ui/footer-text.ts | |

### style
| Current | New | Note |
| --- | --- | --- |
| src/styles.ts | core/styles.ts | loads `prompts/` from `ctx.paths.root`. |
| src/settings.ts | core/settings.ts | imports `shared/settings-files`. |
| src/style.ts | core/style.ts + api/plugin.ts | [split] prompt-section assembly → core; command + settings wiring → api. |
| src/pick.ts | ui/pick.ts | |

### transcript
| Current | New | Note |
| --- | --- | --- |
| src/words.ts | core/word-spans.ts | pure wrapping. |
| src/tools.ts (288) | core/tool-kinds.ts + ui/tools.ts | [split] classification of tool calls → core; painting → ui. |
| src/codemode.ts, diff.ts, generic.ts, output.ts, shell.ts | ui/ (same names) | renderers. |
| src/look.ts | ui/tool-look.ts | |
| src/transcript.ts | api/plugin.ts | `registerToolRows` wiring. |
| test/helpers.ts | tests/support/transcript-rows.ts | `rows`, `numbered` stay local. |

### working-indicator
| Current | New | Note |
| --- | --- | --- |
| src/working-indicator.ts (186) | core/indicator-state.ts + ui/indicator-text.ts + api/plugin.ts | [split] phase/elapsed state → core; label text → ui; `setWorkingMessage` wiring → api. |

### subagents
| Current | New | Note |
| --- | --- | --- |
| src/index.ts | index.ts + api/extension.ts | `createManagedExtension` with 11 plugins, `childExclude: [root]`. |
| src/plugins.ts | api/plugins.ts | ordered plugin list. |
| src/model/plugin.ts, events.ts | core/model/ | now import `Plugin`/`Bus` types from `shared/index.ts` (`plugin-contract`). |
| src/model/types.ts, settings.ts, agent-schema.ts, agent-override.ts, context-limit.ts, manifest.ts, model-resolution.ts, paths.ts | core/model/ (same names) | `settings.ts` → `shared/plain-object`, `shared/settings-files`; `manifest.ts` `Pick<Host>` sites → capability interfaces (phase 5); `agent-override.ts:29` `.includes` gets a `ThinkingLevel` guard. |
| src/components/format.ts (196) | core/components/receipt.ts + ui/components/format.ts | [split] theme-free: `formatCalls`, `ReceiptKind/Segment/Facts`, `receipt`, `plainReceipt`, `formatCtx`, `singleLine`, `firstLine`, `elapsedOf`, `agentReceipt`, `cutChars` → core; painted: `receiptText`, `truncatePainted`, `padEndCols`, `innerWidth`, `padLine`, `alignRight`, `wrapCols` → ui. The re-exports of `counted`, `errorText`, `formatDuration`, `formatTokens`, `DOT`, `PAD` are dropped; the 19 importers take them from `shared/index.ts` (`PAD` from `pi-adapter/index.ts`). |
| src/components/refresh.ts | core/components/refresh.ts | |
| src/components/tree.ts | core/components/tree.ts + ui/components/tree-glyphs.ts | [split] `nestPrefix` glyphs → ui. |
| src/components/agent-row.ts, state-text.ts | ui/components/ | |
| src/plugins/agent-definitions/{fields,loader,prompt,yaml-lite}.ts | core/agent-definitions/ | |
| src/plugins/agent-definitions/index.ts | api/plugins/agent-definitions.ts | |
| src/plugins/agent-registry/registry.ts | core/agent-registry/registry.ts | `errorText` from `shared/index.ts`. |
| src/plugins/agent-registry/index.ts | api/plugins/agent-registry.ts | |
| src/plugins/agent-panel/model.ts | core/agent-panel/panel-state.ts + ui/agent-panel/panel-lines.ts | [split] `panelLines` uses `hints`. |
| src/plugins/agent-panel/keys.ts | ui/agent-panel/keys.ts | |
| src/plugins/agent-panel/index.ts | api/plugins/agent-panel.ts + ui/agent-panel/panel.ts | [split] widget rendering → ui. |
| src/plugins/agent-setup/form.ts | ui/agent-setup/form.ts + core/agent-setup/scope.ts | [split] `SCOPES`, `Scope`, `SetupChange` → core (imported by `line.ts:9`). |
| src/plugins/agent-setup/{agent-template,create,line,write}.ts | core/agent-setup/ | `write.ts` → `shared/plain-object`, `shared/settings-files`. |
| src/plugins/agent-setup/render.ts | ui/agent-setup/render.ts | |
| src/plugins/agent-setup/index.ts | api/plugins/agent-setup.ts + ui/agent-setup/overlay.ts | [split] overlay construction → ui. |
| src/plugins/agent-status/snapshot.ts | core/agent-status/snapshot.ts | |
| src/plugins/agent-status/index.ts | api/plugins/agent-status.ts + ui/agent-status/status-text.ts | [split] `hints`/`marks`/`row` text → ui. |
| src/plugins/agent-view/loader.ts | core/agent-view/source.ts | |
| src/plugins/agent-view/list-model.ts | core/agent-view/list-model.ts + ui/agent-view/list-hints.ts | [split] hint strings → ui. |
| src/plugins/agent-view/{list,overlay,request-block,view}.ts | ui/agent-view/ | |
| src/plugins/agent-view/index.ts | api/plugins/agent-view.ts + ui/agent-view/picker.ts | [split] `select` picker → ui. |
| src/plugins/fetch-tool/{fetch,text}.ts | core/fetch-tool/ | |
| src/plugins/fetch-tool/index.ts | api/plugins/fetch-tool.ts | |
| src/plugins/interrupt/index.ts | api/plugins/interrupt.ts | 65 lines, wiring. |
| src/plugins/limits/context-step.ts | core/limits/context-step.ts | |
| src/plugins/limits/index.ts | api/plugins/limits.ts | |
| src/plugins/run-agent/{handoff,outbox,placement,result,semaphore,task,worktree}.ts | core/run-agent/ | |
| src/plugins/run-agent/model-text.ts | core/run-agent/model-text.ts | text, not paint: `resolutionError` is imported by `runner.ts:37`. |
| src/plugins/run-agent/runner.ts (1,067) | core/run-agent/runner.ts | moved intact (decision: not split); `readText` → `shared/settings-files`, `settleWithin` → `pi-adapter/index.ts`. |
| src/plugins/run-agent/tools.ts | core/run-agent/tools.ts + ui/run-agent/pending-rows.ts | [split] its `row` import → ui. |
| src/plugins/run-agent/handoff-tool.ts | core/run-agent/handoff-tool.ts + ui/run-agent/handoff-row.ts | [split]. |
| src/plugins/run-agent/render.ts | ui/run-agent/render.ts | |
| src/plugins/run-agent/index.ts | api/plugins/run-agent.ts | |
| src/plugins/usage-report/index.ts | api/plugins/usage-report.ts | |
| test/helpers/* | tests/support/* and test-framework (section 8) | |
| test/live/*.live.test.ts (5) | tests/live/ | the other 4 → `evals/` (section 8). |

## 6. pi-adapter

### 6.1 Layout
Section 2.3. Internal dependency direction: `types ← runtime/ child/ ui/ editor/ tools/ context/ prompt`; `runtime/host.ts` is the only module that imports from every other subfolder (it assembles the host). `ui/tui-context.ts` is imported by `ui/notices.ts`, `ui/footer.ts` and `ui/create-ui.ts`; `ui/create-ui.ts` imports `ui/footer.ts`, never the reverse. `ui/theme-bridge.ts` and `ui/row-layout.ts` are imported by `tools/`, `editor/`, `ui/`; nothing in `ui/` imports `tools/`.

### 6.2 Public surface (`pi-adapter/index.ts`)
Everything extensions, the extension manager, ui-kit, shared and the test framework may use:
- all `types/**` exports;
- `createPiExtension`, `ExtensionFactory`, `ExtensionOptions` (runtime/extension.ts);
- `globalRecord` (runtime/global-record.ts), `insideChildSession` (runtime/child-scope.ts), `formatRoutedMessage` (runtime/message-text.ts), `settleWithin` (runtime/settle-within.ts);
- `PAD`, `CHILD_COLUMN`, `isBlankLine`, `childLead` (ui/row-layout.ts) for `ui-kit/row.ts` and `shared/text-layout.ts`;
- `textMetrics` (ui/theme-bridge.ts) and `resolveModel`, `CatalogModel`, `ModelPreferences` (child/model-resolver.ts) for `test-framework/themes.ts` and `fake-agent-runtime.ts` (review finding 8);
- `THINKING_LEVELS`, `ThinkingLevel`, `splitModelRequest`, `emptyUsage`, `addUsage` (types/).

Nothing else leaves the folder. `test-framework/pi/**` is the exception for test-only access to internals (R12).

### 6.3 Type revision

| Today | Change | Effect on callers |
| --- | --- | --- |
| `ThemeToken` 18 members | `PaintToken = "accent"\|"border"\|"borderAccent"\|"muted"\|"dim"\|"text"`, `StatusToken = "success"\|"warning"\|"error"`, `SyntaxToken = "syntaxString"\|"syntaxVariable"`, `ThinkingToken = \`thinking${Capitalize<ThinkingLevel>}\``; `ThemeToken` = union of the four. | None: same string set; `satisfies Record<ThemeToken, true>` in `pi-tools.test.ts:302` stays exhaustive. `ui-kit/cache-tone.ts` `CacheTone` becomes `StatusToken`. |
| `THINKING_LEVELS: readonly string[]` | `as const` tuple; `ThinkingLevel = (typeof THINKING_LEVELS)[number]`; `isThinkingLevel(value: string)` guard replaces the two `.includes` sites (`contract.ts:404`, `subagents/src/model/agent-override.ts:29`). | Compile-checked; no runtime change. |
| `KeyPress.name` 16 members | `NavigationKey` (up/down/left/right/pageUp/pageDown/home/end), `EditKey` (enter/escape/space/tab/backTab/backspace), `AppKey` ("toggleTools"), `KeyName = … \| "other"`; guard `isNavigationKey(key)`. | None for existing `switch` code and `Partial<Record<KeyPress["name"], …>>` consumers; list/select components type their handlers with `NavigationKey \| EditKey`. |
| `Host` 32 members | Capability interfaces: `ToolHost` (registerTool, registerCommand, dispatchCommand), `PromptHost` (setMainPrompt, setPromptSection), `LifecycleHost` (onSessionStart/Shutdown, onIdle, onTurnEnd, onCompact, onAgentStart, onPhase, onDialog, isIdle), `MessagingHost` (sendHiddenMessage, publish, subscribe), `EntryHost` (appendEntry, registerEntryRenderer, registerToolRows, registerMessageRenderer, readEntries), `SessionHost` (session, sessionName, sessionUsage, context, contextFacts, model, thinkingLevel, lastRequestUsage, mainRequestUsage). `Host` = intersection + `ui`. | The `Pick<Host\|HostUi>` sites listed in section 1 (`pi-editor.ts:155`, `pi-editor-input.ts:5`, `pi-usage.ts:8`, `pi-ui.ts:97`, `pi-working.ts:6`, `pi-footer.ts:123`, `pi-context.ts:51`, `pi-entries.ts:29`, `manifest.ts:9,25,52`), `conversationOnly` and plugin `enable` signatures name the capability they need. All are subsets of the proposed interfaces (review check E). |
| `HostUi` 23 methods | `NoticeUi` (notify, setStatus, setNotice, confirm, terminalNotify), `OverlayUi` (openOverlay, showForm), `WidgetUi` (setWidget, setFooter, setWorkingMessage, setWorkingVisible, setHiddenThinkingLabel), `EditorUi` (onEditorSubmit, mapCommandCompletion, submitEditor, setEditorFrame, onEmptyEditorLeft/Down/Escape, captureEditorKeys), `KeysUi` (keyText, onKeyPress), plus `style`. | None; fakes implement the intersection. Optional follow-up (open question 2): `onEmptyEditorKey("left"\|"down"\|"escape", handler)` replaces three methods. |
| `ChildEvent`, `ModelResolution`, `TranscriptItem` | already discriminated; move to their domain file, no change. | |
| `StopReason`, `Phase`, `ShutdownReason`, `DialogKind`, `RunMode` | keep; declare `as const` tuples where a runtime list exists and derive the type. | |
| Extension-level enums (`AgentState`, `CategoryKey`, `MessageKey`, `ReceiptKind`, `FieldKind`, `Mark`) | keep; domain enums under 10 members. | |

Generics stay as they are (`ToolSpec<P,D>`, `Plugin<E,S,C>`, `FormApi<T>`); no union was found that generics would simplify.

## 7. Shared helpers

| Today (`core/manager/`) | New home | Reason |
| --- | --- | --- |
| extension-manager.ts, plugin.ts (runtime part), bus.ts (runtime part) | `extension-manager/` | plugin runtime. |
| plugin.ts, bus.ts (types: `Plugin`, `PluginContext`, `Disable`, `Bus`, `BusOf`, `ServiceRegistry`) | `shared/plugin-contract.ts` | `core/` files declare plugin and bus types; R7 bans `extension-manager/` from `core/` (review finding 2b). |
| settings.ts (`watchSettings`, `reportSettingsErrors`) | `extension-manager/watch-settings.ts` | need `Host`. |
| settings.ts (`parseSettings`, `readText`, `readSettingsFile`, `userSettingsPath`, `projectSettingsPath`, `readSettingsFiles`, `loadSettingsFiles`, `SettingsSchema`) | `shared/settings-files.ts` | pure file reading and parsing used by `core/` files (review finding 2a). |
| settle.ts | `pi-adapter/runtime/settle-within.ts`, exported from `pi-adapter/index.ts` | `pi-child.ts:17` imports it; keeping R3 strict means the adapter owns it. Subagents `runner.ts` imports it from `pi-adapter/index.ts`. |
| guards.ts | `shared/plain-object.ts` | |
| handoff.ts | `shared/handoff-document.ts` | validation shared by session-limits and subagents. |
| channels.ts | `shared/host-channels.ts` | cross-extension `host.publish` protocol; cannot live in one extension because extensions do not deep-import each other. |
| format.ts | `shared/format.ts` | theme-free text formatting, needed by `core/` layers (R7). |
| layout.ts (`DOT`, `ELLIPSIS`, `cutStart`, `rule`, `prefixed`, `padded`) | `shared/text-layout.ts` | theme-free string layout; `PAD` is re-exported from `pi-adapter/index.ts`. |
| layout.ts `PAD`; row.ts `CHILD_COLUMN`, `isBlankLine`, `childLead` | `pi-adapter/ui/row-layout.ts` | imported by `pi-notice.ts:2`, `pi-row-component.ts:2`, `pi-tool-rows.ts:4`; adapter-owned row geometry (review finding 5). `ui-kit/row.ts` imports them from `pi-adapter/index.ts` (R5 direction). |
| cache.ts | `shared/cache-hit.ts` (`reportedCache`, `cacheHitPercent`, `sessionCacheHit`) + `ui-kit/cache-tone.ts` (`cacheTone`, `cachePercentText`) | context/core and footer/core use the maths; footer/ui the tone. |
| row.ts (rest), hints.ts, marks.ts, list.ts, select.ts, tabs.ts, multi-select.ts | `ui-kit/` (`row.ts`, `key-hints.ts`, `glyphs.ts`, `list.ts`, `select.ts`, `tabs.ts`, `multi-select.ts`) | theme-aware rendering components. |

Rules: R4, R5, R7, R8. `shared/index.ts` and `ui-kit/index.ts` are the only entry points. Each has `tests/` (moved from `core/test/manager/`). `shared/` keeps its name; its `STRUCTURE.md` carries the admission rule from section 2.1 (review finding 19).

## 8. Test framework and evals

Layout, names and API follow [03-test-framework-and-evals.md](03-test-framework-and-evals.md) as reconciled by the review; this section records what matters for the restructure.

### 8.1 `test-framework/`

```
test-framework/
├── index.ts                   pi-free public API
├── fake-host.ts               createFakeHost, FakeHost, createTurnScope, hiddenMessageTexts        ← helpers/fakes.ts, subagents turns.ts/harness.ts
├── fake-agent-runtime.ts      createFakeAgentRuntime, FakeAgentRuntime, FakeChildSession, catalogModel ← helpers/fakes.ts
├── fake-form.ts               openFakeForm, FakeForm                                                ← helpers/fake-form.ts
├── usage-builders.ts          usageTotals, promptTokens                                             ← fakes.ts usageOf + 3 local copies
├── key-presses.ts             key, char                                                             ← helpers/keys.ts + overlay.ts:19
├── themes.ts                  plainTheme, tokenTaggingTheme, paintRecordingTheme                    ← fakes.ts + 5 local recorders
├── rendered-text.ts           plainText, plainLines, visibleWidth                                   ← 6 ANSI strippers
├── waiting.ts                 flushMicrotasks, flushTimers, waitUntil, pause
├── temp-dirs.ts               useTempDirs                                                           ← subagents harness.ts tempDir
├── extension-harness.ts       startExtension({ plugins | extension, settings, host?, runtime? })   ← subagents harness.ts startPlugins, generalised
├── recorded-sessions.ts       session .jsonl builders                                               ← overlay.ts grepSession
├── valid-handoff.ts           VALID_HANDOFF                                                         ← subagents helpers/handoff.ts (+ session-limits inline copies); named apart from shared/handoff-document.ts (R14)
├── live/                      pi-free: seed-project.ts, fixture-mcp-server.ts, session-reading.ts, cost.ts
├── eval-runs/                 pi-free eval runner: eval-runs.ts (evalRunCount, PI_EVAL_RUNS, repeatRuns), rubric.ts, pass-threshold.ts, eval-report.ts
├── pi/                        the only test code importing pi packages (R2, R12)
│   ├── render-theme.ts  tool-rows.ts  overlay.ts  session-files.ts                                 ← core/test/adapter/{render-theme,tool-rows,offline}.ts, subagents overlay.ts
│   └── live/              live-model.ts (describeLive, setupLive…), live-agent-dir.ts, live-runtime.ts, pi-session.ts (openPiSession), live-extension.ts (startLiveExtension)   ← core/test/adapter/live.ts, wake.live.test.ts openSession
├── tests/                     unit tests of the framework (incl. live-agent-dir.test.ts)
├── ARCHITECTURE.md  STRUCTURE.md
```

`startLiveExtension({ extension, agentDir, settings })` boots any `createManagedExtension` result (its `.boot`) on a real agent runtime and a fake host; it knows no extension. Subagents-specific knowledge (`AgentRecord`, `runChain`, `chainLinks`, `wakeTexts`, `spawnAgents`, agent-file patching) stays in `extensions/subagents/tests/support/live-harness.ts` as a thin layer, which evals may import (R13, review finding 10).

Stays extension-local in `tests/support/`: subagents `agent-records.ts`, `agent-patch.ts`, `subagents-harness.ts` (thin wrapper: `shippedModels()`, `defaultSettings()` over `startExtension`), `live-harness.ts`, `handoff-cases.ts` (subagents-specific handoff variants), `recorded-grep-session.ts`, `routing-session.ts`, `fetch-stub.ts`, `setup-context.ts`; `context/tests/support/context-snapshots.ts`; `questionnaire/tests/support/questions.ts`; `transcript/tests/support/transcript-rows.ts`; `pi-adapter/tests/support/fake-pi.ts`. Eval-only helpers (`parseFindings`, `plan-rows`, chain outcome formatting) go to `evals/subagents/support/`.

### 8.2 Live test classification

| File | Class | Reason | New path |
| --- | --- | --- | --- |
| core/test/adapter/wake.live.test.ts | live test | asserts wake delivery of the adapter with a real pi session | pi-adapter/tests/live/wake.live.test.ts |
| subagents/test/live/grants.live.test.ts | live test | asserts exact tool/skill/MCP grant sets reaching a child | extensions/subagents/tests/live/grants.live.test.ts |
| subagents/test/live/handoff.live.test.ts | live test | deterministic: handoff file written at the smallest limit, successor wakes caller | extensions/subagents/tests/live/ |
| subagents/test/live/nesting.live.test.ts | live test | wake routing between nested agents | extensions/subagents/tests/live/ |
| subagents/test/live/run-agent.live.test.ts | live test | one run reaches done with result, cost, linked session file | extensions/subagents/tests/live/ |
| subagents/test/live/worktree.live.test.ts | live test | file lands in `.pi/worktrees`, worktree kept | extensions/subagents/tests/live/ |
| subagents/test/live/planner-plan.live.test.ts | eval | `it.each(fixtures)`, N concurrent runs, majority threshold, cost logging: scores the planner prompt | evals/subagents/planner/plan-recall.eval.ts |
| subagents/test/live/reviewer-review.live.test.ts | eval | planted bug found in > runs/2 | evals/subagents/reviewer/planted-defects.eval.ts |
| subagents/test/live/implementer-change.live.test.ts | eval | hidden tests pass in > runs/2 | evals/subagents/implementer/hidden-tests.eval.ts |
| subagents/test/live/routing.live.test.ts | eval | main-session prompt routes requests to the expected agent | evals/subagents/routing/main-session-routing.eval.ts |
| core/test/adapter/live-agent-dir.test.ts | unit test | tests `prepareAgentDir` offline | test-framework/tests/live-agent-dir.test.ts |
| subagents/test/live/fixtures/mcp-server.ts | fixture | pi-free stdio MCP server, reusable by mcp-import | test-framework/live/fixture-mcp-server.ts |

### 8.3 `evals/`

Layout per plan 03 §4: one folder per judged subject with a `*-cases.ts` data file and one `*.eval.ts`, plus `evals/subagents/support/`. `vitest.evals.config.ts` includes `evals/**/*.eval.ts`, serial, `testTimeout: 1_800_000`; `npm run evals` (needs `PI_LIVE_MODEL`, never in CI); `PI_EVAL_RUNS` replaces the old plan-runs variable and the old routing-runs variable. `vitest.live.config.ts` keeps `extensions/*/tests/live/**/*.live.test.ts` and `pi-adapter/tests/live/**/*.live.test.ts` at 600 s. Unit `vitest.config.ts` uses the explicit include list of plan 03 §5 (no repo-wide glob).

## 9. Renames

| Current | New | Why |
| --- | --- | --- |
| core/adapter/pi-adapter.ts | pi-adapter/runtime/extension.ts + runtime/host.ts | a file named like its folder hides two things: the factory and the host. |
| core/adapter/pi-shared.ts (`shared`) | pi-adapter/runtime/global-record.ts (`globalRecord`) | it is a record on `globalThis` shared across package copies; "shared" says nothing about where or why. |
| core/adapter/pi-scope.ts | pi-adapter/runtime/child-scope.ts | it marks and detects child sessions. |
| core/adapter/route.ts (3 lines) + messages.ts | pi-adapter/runtime/message-text.ts | one formatter in the messages domain; distinct from `types/messages.ts`. |
| core/adapter/pi-tools.ts | tools/tool-bridge.ts + ui/theme-bridge.ts | half converts tools, half converts themes and text metrics. |
| core/adapter/pi-ui.ts | pi-adapter/ui/create-ui.ts + ui/tui-context.ts | it builds the `HostUi`; the context extraction breaks the only cycle. |
| core/adapter/pi-keys.ts | pi-adapter/ui/key-events.ts | distinct from `types/keys.ts`. |
| core/adapter/pi-context.ts | pi-adapter/context/context-facts.ts | distinct from `types/context.ts`. |
| core/adapter/pi-notice.ts / pi-working.ts | ui/notices.ts / ui/working-message.ts | name the thing, not the pi hook. |
| core/adapter/pi-entries.ts | tools/entry-renderers.ts | it registers entry renderers. |
| core/adapter/pi-models.ts | child/model-catalog.ts | it lists available models. |
| core/adapter/usage.ts / pi-usage.ts | context/usage-math.ts / context/usage-events.ts | two files called "usage" differ by pure maths vs pi events. |
| core/manager/settle.ts | pi-adapter/runtime/settle-within.ts | named after its one export; owned by its first consumer. |
| core/manager/guards.ts | shared/plain-object.ts | the only guard is `isPlainObject`. |
| core/manager/settings.ts | shared/settings-files.ts + extension-manager/watch-settings.ts | file parsing vs host-bound watching. |
| core/manager/plugin.ts, bus.ts (types) | shared/plugin-contract.ts | the contract plugins implement, apart from the runtime that runs them. |
| core/manager/marks.ts | ui-kit/glyphs.ts | it maps a state to a glyph. |
| core/manager/hints.ts | ui-kit/key-hints.ts | key-binding hint lines. |
| core/manager/layout.ts | shared/text-layout.ts (+ `PAD` to pi-adapter/ui/row-layout.ts) | string padding and rules, no theme. |
| core/manager/cache.ts | shared/cache-hit.ts + ui-kit/cache-tone.ts | "cache" reads as memoisation; it is cache-hit percentage and its colour. |
| core/manager/channels.ts | shared/host-channels.ts | names of `host.publish` channels and their parsers. |
| core/manager/handoff.ts | shared/handoff-document.ts | validates the handoff document format. |
| transcript/src/look.ts | transcript/ui/tool-look.ts | describes how a tool call looks in the transcript. |
| transcript/src/words.ts | transcript/core/word-spans.ts | its export is `wordSpans`. |
| subagents/src/components/format.ts | core/components/receipt.ts + ui/components/format.ts, minus the re-exports | re-exports hide the real dependency. |
| subagents/src/plugins/agent-view/loader.ts | core/agent-view/source.ts | its export is `createAgentSource`. |
| subagents/src/plugins/agent-panel/model.ts | core/agent-panel/panel-state.ts | "model" collides with `model/` and LLM models. |
| core/test/helpers/fakes.ts (913 lines) | test-framework/{fake-host,fake-agent-runtime,themes,usage-builders}.ts | one file per fake. |
| `createFakeRuntime`, `taggedTheme`, `recordingTheme`, `flush`, `quiet`, `createTurns`, `wakeTexts`, `fakeOverlayApi`/`realOverlayParts`, `liveRuns`, `concurrentRuns`, `openMainLikeSession`, `costOf`, `usageOf` | `createFakeAgentRuntime`, `tokenTaggingTheme`, `tokenTaggingTheme({ bold: true })`/`paintRecordingTheme`, `flushMicrotasks`, `pause`, `createTurnScope`, `hiddenMessageTexts`, `createOverlayApi`, `evalRunCount`, `repeatRuns`, `openPiSession`, `totalCost`, `usageTotals` | plan 03 names; each says what it builds or waits for. |
| `tests/helpers/` | `tests/support/` | distinguishes extension-local support from the framework's helpers. |

## 10. Migration phases

Each phase is one PR (or, for 7, a set of independent PRs), leaves `npm run check` green, and turns on the lint rules listed for it. Phases are **sequential** except 7a–7l and 7m, which touch disjoint files (review finding 11). Exact order: **0 → 1 → 2 → 3 → 4 → 5 → 6 → {7a–7l ∥ 7m} → 8 → 9**.

| # | Phase | Files touched | Lint / config | Risk |
| --- | --- | --- | --- | --- |
| 0 | Break the adapter cycle: extract `HostState` + `tuiContext` from `pi-ui.ts` into `core/adapter/pi-tui-context.ts`; `pi-notice.ts` and `pi-footer.ts` import that. Add knip as a devDependency with `knip.json` on current paths and the baseline findings fixed (plan 01 lists 9 exports, 3 types). | `core/adapter/{pi-ui,pi-notice,pi-footer}.ts`, new `pi-tui-context.ts`, `knip.json`, `package.json`, the 12 baseline files | enable `noImportCycles: "error"`, `noUnusedImports/Variables/FunctionParameters/PrivateClassMembers: "error"`, `noReExportAll`, `npm run knip` in `check` | low; `pi-ui.test.ts`, `pi-footer.test.ts`, `pi-notice` coverage unchanged. |
| 1 | `core/adapter/*` → the section 2.3 subfolders of `pi-adapter/` with basenames unchanged (`pi-ui.ts` → `ui/pi-ui.ts`, …; `pi-tui-context.ts` → `ui/`), add `pi-adapter/index.ts` with the section 6.2 surface, move `settleWithin` → `runtime/settle-within.ts` and the row constants → `ui/row-layout.ts` (finding 5), rewrite the 135 import sites to the barrel; `core/test/adapter/pi-transcript.test.ts` imports `marks` from its new place in phase 2 (temporarily from `core/manager`). | every file importing `core/adapter/**`; `package.json#files`; `tsconfig.json#include`; `vitest*.config.ts`; `biome.json` (pi-package override path); README paths | Biome `pi-adapter/**` override (R3) on; pi-package ban paths updated; the four generic `extensions/*/…/*.ts` overrides (depths 0–3) on with two groups: pi-package ban and `**/pi-adapter/**` + `!**/pi-adapter/index.ts` | medium: mechanical, touches every extension; paths only. |
| 2 | `core/manager` → `extension-manager/`, `ui-kit/`, `shared/` with `index.ts` each (section 7 split incl. `settings-files`/`watch-settings`, `plugin-contract`, `cache-hit`/`cache-tone`); rewrite ~130 import sites; delete `core/`; manager tests follow to `extension-manager/tests/`, `ui-kit/tests/`, `shared/tests/`. | every file importing `core/manager/**`; configs | Biome overrides for `extension-manager/**` (R4), `shared/**`, `ui-kit/**` (R5) on; `knip.json` project paths updated | medium: no logic change; `format`/`layout` consumers rewired. |
| 3 | `test-framework/` (plan 03 §3 layout, including `pi/` and `pi/live/`, `eval-runs/`, `valid-handoff.ts`; `startExtension({ plugins, … })` only, i.e. today's `startPlugins` generalised); adapter tests → `pi-adapter/tests/` (+ `tests/support/fake-pi.ts`, `tests/live/`); extension tests `test/` → `tests/`, helpers → `tests/support/`; duplicate themes/keys/ANSI strippers removed; `pi-adapter/index.ts` exports `textMetrics`, `resolveModel`, `CatalogModel`, `ModelPreferences`. | 74 importers of fakes, ~150 test files, vitest includes (explicit list), CI pack grep (`/tests?/\|test-framework/\|evals/\|\.snap\|fixtures\|\.eval\.ts`) + positive `index.ts` count (13) | Biome overrides `test-framework/**`, `evals/**`, `test/**` then `test-framework/pi/**` (R2, R12) on; architecture test reduced to R10/R14/placement checks | medium: path churn; themes differ subtly (close tag, bold marker) — keep old semantics behind options. |
| 4 | pi-adapter section 9 renames and the three splits (`pi-adapter.ts`, `pi-tools.ts`, `pi-child.ts`) inside the subfolders phase 1 created; no type change. | `pi-adapter/**` only (incl. its tests and `test-framework/pi/**` imports of internals) | — | low: `index.ts` keeps the surface stable. |
| 5 | pi-adapter type revision: `types/` split, capability interfaces, `ThemeToken`/`KeyName` sub-unions, `THINKING_LEVELS as const` + guard. Additive first (aliases keep old names), then narrow the `Pick<…>` sites and `conversationOnly`. | `pi-adapter/types/**`, the Pick sites listed in section 1, `session-limits/src/conversation.ts`, `subagents/src/model/{manifest,agent-override}.ts` | — | medium: compile-checked; no runtime diff. |
| 6 | Extension manager: `PluginContext.paths`, `createManagedExtension` (`boot`, `host`, `settings`, `childExclude` resolution, `onError` rethrow), tests for handler order and `isExcluded` with a relative entry; subagents adopts it (`childExclude: [root]`); `startExtension` accepts a managed extension; `startLiveExtension` in `test-framework/pi/live/`. | `extension-manager/**`, `shared/plugin-contract.ts`, `extensions/subagents/src/index.ts`, `test-framework/extension-harness.ts`, `test-framework/pi/live/live-extension.ts`, subagents `tests/support/{subagents-harness,live-harness}.ts` | generic `extensions/*/…/*.ts` overrides get their full group lists (R6, R9); `extensions/*/core/**`, `extensions/*/ui/**`, `extensions/*/tests/**` overrides (R7, R8, R11) on — core/ui match nothing until a `core/`/`ui/` folder exists | medium: subagents boot path changes; covered by `plugins.test.ts`, settings tests and live `run-agent`. |
| 7a–7l | One PR per plain extension (smallest first: command-aliases, composer, working-indicator, style, spending, footer, notifications, questionnaire, context, transcript, mcp-import, session-limits): `src/` → `api/ core/ ui/` per section 5, `test/` → `tests/` (+ `tests/support/`), root `index.ts`, plugin on `createManagedExtension`, per-extension ARCHITECTURE.md/STRUCTURE.md, `pi.extensions` entry. | that extension's folder; one line each in `package.json#pi.extensions` and `README.md` | overrides already on; the architecture test's folder-shape rule (R14) accepts both `src/` and the new shape until phase 9 | low each; the [split] cuts are the only places a wrong cut changes behaviour — existing unit tests cover them. |
| 7m | Subagents in three PRs, sequential: (i) `model/` + `components/` → `core/`/`ui/` (incl. `format.ts` split, `scope.ts`, `model-text.ts` → core); (ii) `plugins/*` logic → `core/`, rendering → `ui/`; (iii) plugin indexes → `api/plugins/`, root `index.ts`, `tests/` move, per-extension docs. Runs in parallel with 7a–7l (disjoint files). | `extensions/subagents/**`, its `pi.extensions` line | same | medium: 70 source files, 61 test files; live tests rerun locally after (iii). |
| 8 | `evals/`: move the four quality suites onto `eval-runs` (`repeatRuns`, `expectPassRate(MAJORITY)`, `reportEval`), `evals/subagents/support/`, `vitest.evals.config.ts`, `npm run evals`, `PI_EVAL_RUNS`, `evals/README.md`; `test:live` excludes evals. Depends on 7m(iii) (support paths). | `evals/**`, `extensions/subagents/tests/live/` (4 files removed), `tests/support/live-harness.ts`, configs, subagents README | `evals/**` override already on; knip `entry` adds `evals/**/*.eval.ts` and the fixture server | low. |
| 9 | Docs and lock-down: root ARCHITECTURE.md/STRUCTURE.md shortened to rules + links; per-folder docs for pi-adapter, extension-manager, ui-kit, shared, test-framework; README paths; AGENTS.md rule sentence ("extensions import each other only through `index.ts`"); architecture test R14 rejects `src/`; knip `includeEntryExports` enforced on the 13 `index.ts`. | docs, `test/architecture.test.ts`, `knip.json` | final rule set, no exceptions | low. |

Rollback: each phase is a pure move/rename with import rewrites (phase 5 adds types, phase 6 adds a factory), so `git revert` of one PR restores the previous green state.

## 11. Open questions

None. The last two were decided after the review: `api/` stays the composition root (the plugin object must see `core/` and `ui/`; the folder set `index.ts api/ core/ ui/ tests/` is fixed, no fifth folder), and `onEmptyEditorLeft/Down/Escape` stay as three methods.

Resolved by the review and the orchestrator: cross-extension imports through `index.ts` are permitted (from `api/` only, R9); knip is adopted; `createManagedExtension` rethrows by default; evals use `startLiveExtension` from the framework plus `extensions/subagents/tests/support/`; `runner.ts` is not split; settings keep getter/watch semantics with the manager owning the reload; `childExclude` is absolute; `!**/tests/**` negation in `files` works; `shared/` keeps its name with an admission rule.
