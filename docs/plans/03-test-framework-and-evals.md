# 03 Test framework and evals

Plan for a root `test-framework/` (shared test helpers) and a root `evals/` (prompt and agent quality), done together with the restructure: `core/adapter` → `pi-adapter/`, `core/manager` → `extension-manager/`, `extensions/<name>/{api,core,ui,tests,index.ts}`.

Terms used below:

- **unit test**: fakes only, no network, runs in `npm run check` and CI.
- **live test**: a real agent runtime; checks *mechanics* (wiring, grants, nesting, worktrees, handoff, wake). Pass/fail is meant to be deterministic. It stays next to its code.
- **eval**: a real agent runtime; judges *quality* of prompts and agent frontmatter. Repeated runs, pass-rate thresholds, cost and time report. Lives in root `evals/`.

---

## 1 Helper inventory

Paths are current. "Used by" counts files that import the helper (grep of import specifiers, the helper itself excluded).

### 1.1 core/test

| Helper | Provides | Used by | Shared / local | Duplication notes |
|---|---|---|---|---|
| `core/test/helpers/fakes.ts` (913 lines) | `createFakeHost` / `FakeHost` (full `Host` contract plus recorders and drivers: `start`, `settle`, `turnEnd`, `runCommand`, `renderTool`, `pressEditorKey`, ...), `createFakeRuntime` (catalog with invented refs, `spawn` → `FakeChild`), `FakeChild` (`finish`, `turn`, `emit`), `catalogModel`, `usageOf`, `plainTheme`, `taggedTheme`, `flush`, `flushTimers`, `FAKE_FOOTER_KEY` | 74 files: subagents 35, core/test/manager 11, transcript 5, questionnaire 4, session-limits 4, context 3, others 1–2 each | **shared** → split into `fake-host.ts`, `fake-agent-runtime.ts`, `themes.ts`, `wait.ts` | Imports `textMetrics` from `core/adapter/pi-tools.ts` (fakes.ts:47), so every "pi-free" unit test transitively loads pi-tui. `usageOf` (fakes.ts:715) is re-invented as local `usage(...)` at `core/test/adapter/session-file.test.ts:4`, `pi-context.test.ts:32`, `usage.test.ts:5` |
| `core/test/helpers/fake-form.ts` | `openFakeForm`, `FakeForm` (fake `showForm` with fake `TextInput`) | fakes.ts, 1 subagents test | **shared** (`fake-form.ts`) | – |
| `core/test/helpers/keys.ts` | `key(name)`, `char(value)` `KeyPress` builders | 8 (manager 5, questionnaire 1, subagents 2) + re-exports | **shared** (`key-presses.ts`) | Second `key(name, char?)` at `extensions/subagents/test/helpers/overlay.ts:19`; re-exported at `overlay.ts:21`, `questionnaire/test/fixtures.ts:26`, `subagents/test/plugins/agent-setup/setup-context.ts:6` (re-export of the overlay variant). Three import paths for one thing |
| `core/test/adapter/offline.ts` | `realOverlayParts` (real pi transcript and scroll panes), `sessionFacts(file)` (tools, calls, results of a session file), re-exports `parseSessionLines`, `promptRecordEntry`, `readSessionFile`, `formatRoutedMessage` | 5 subagents files (overlay helper, grants and implementer live tests, view tests) | **shared, pi-facing** (`test-framework/pi/`) | Three session readers: `sessionFacts` (offline.ts:18), `sessionLines`/`sessionHeader` (`core/test/adapter/live.ts:200-206`), `runtime.readSession(...).items` (used in `live-runs.ts`) |
| `core/test/adapter/render-theme.ts` | `initRenderTheme`, `initRenderKeys` (pi global theme and keybindings), `plainPiTheme` (pi `Theme` stub) | 11 (adapter 8, subagents 3) | **shared, pi-facing** | `plainPiTheme` (render-theme.ts:17) is the pi-typed twin of `plainTheme` (fakes.ts:50) |
| `core/test/adapter/tool-rows.ts` | Render tool rows through real pi: `renderTool`, `renderPaneTool`, `renderExpandedEdit`, `renderPaneEdit`, `piEditDiff`, `piRenderContext`, `visible` | 5 (adapter 4, transcript 1) | **shared, pi-facing** | `visible` (tool-rows.ts:36) is one of six ANSI strippers, see 1.4 |
| `core/test/adapter/live.ts` | Live setup: `PI_LIVE_MODEL` / `PI_LIVE_CHORE_MODEL` parsing, temp agent dir (`prepareAgentDir`, `setupLive`, `teardownLive`, `describeLive`), `liveAgentModel`, `liveChoreModel`, `liveModel`, `createLiveRuntime`, `openMainLikeSession`, `realContextMarkers`, `sessionLines`, `sessionHeader`, `waitUntil`, `quiet`, `costOf`, `reportCost`, `LIVE_TIMEOUT_MS`, `PI_DEFAULT_TOOLS` | 13 (adapter 2, subagents 11) | **shared, pi-facing** (`test-framework/pi/live/`) except `waitUntil`, `quiet`, `costOf`, `reportCost` which are pi-free | `openMainLikeSession` (live.ts:236) and `openSession` in `core/test/adapter/wake.live.test.ts:41` are the same pi session bootstrap (loader, `createAgentSession`, settled counter, `bindExtensions`) |

### 1.2 extensions/subagents/test

| Helper | Provides | Used by | Shared / local | Duplication notes |
|---|---|---|---|---|
| `helpers/harness.ts` | `PACKAGE_ROOT`, `tempDir` (auto-cleaned), `startPlugins` (extension manager over fake host + runtime, error capture), `createHarness` (temp root, fake host paths, fake runtime seeded with shipped agent models), `wakeTexts`, `spawnAgents` | 37 (29 unit, 5 live, live.ts, live-runs.ts, settings test) | **split**: `tempDir`, `startPlugins` core, `wakeTexts` → shared (`temp-dirs.ts`, `extension-harness.ts`, `hiddenMessageTexts`); `createHarness` (shipped models), `spawnAgents`, NAMESPACE cleanup → local | `tempDir` re-implemented at `core/test/adapter/live-agent-dir.test.ts:9`; 27 more inline `mkdtempSync(join(tmpdir(), ...))` with hand-written cleanup (conformance.test.ts ×12, pi-adapter.test.ts ×2, settings tests, mcp-import ×2, notifications, style, session-limits ×2, ...) |
| `helpers/live.ts` | `createLiveHarness(label, {agents, settings, trusted, skills})`: real runtime + fake host + all plugins, shipped agent files patched to the live model, `run`, `waitForWakes`, `seed(sha)`, `close` (cost report, no plugin errors, every agent on the expected model) | 8 live tests, live-runs.ts | **split**: `seed(sha)` (git archive → fresh repo, node_modules link) → shared (`seed-project.ts`); the rest is subagents-specific → `extensions/subagents/tests/support/live-harness.ts` (imported by subagents live tests **and** by evals) | `REPO_ROOT` computed twice (live.ts:47, live-runs.ts:9); git invocations with fixed identity in four places: live.ts `SEED_GIT`, `worktree.live.test.ts:8` `git()`, `live-runs.ts` `repoGit`, `reviewer-review.live.test.ts` `git apply` (plus unit `run-agent/worktree.test.ts:45` `createRepo`) |
| `helpers/live-runs.ts` | `runChain` (run a lead, wait for its successor chain to close, collect helpers, calls, cost, time), `ChainOutcome`, `handoverLines`, `helperCounts`, `failureReason`, `failureSuffix`, `taskLine`, `bashCommands`, `commandsLine`, `concurrentRuns`, `liveRuns` (the old plan-runs variable), `repoGit` | planner, reviewer, implementer live tests, live-helpers.test.ts | **split**: `concurrentRuns`, `liveRuns`, `repoGit`, `bashCommands`, `commandsLine` → shared (eval runner, `seed-project.ts`, `session-reading`); `runChain`, `handoverLines`, `taskLine` (knows the `Task from ... (agent id ...)` header) → `evals/subagents/support/agent-chains.ts` | Repeat count read twice with different env vars: `live-runs.ts:11` the old plan-runs variable, `routing.live.test.ts:17,43` the old routing-runs variable. Majority threshold `> runs / 2` hand-written in 4 places (planner ×3, reviewer, implementer) |
| `helpers/agent-patch.ts` | `patchAgentFile` (rewrite frontmatter: model, limit, name, fields, body), `shippedGroup`, `modelForGroup`, `LIVE_LIMIT` | live.ts, live-helpers.test.ts | **local** (subagents agent-file format) | – |
| `helpers/turns.ts` | `createTurns(host)`: keeps the fake host busy across overlapping tool calls, settles once | live.ts, live-helpers.test.ts | **shared** (`fake-host.ts` as `createTurnScope`) – generic over `FakeHost` | – |
| `helpers/findings.ts` | `parseFindings`, `findingRefs`, `hitsLine`, `citesFile` (reviewer "Findings" section → `path:line` refs), `largestOutput` | reviewer, implementer live tests, findings.test.ts | **evals**: `parseFindings` & co → `evals/subagents/support/reviewer-findings.ts`; `largestOutput` → shared `session-reading` | – |
| `helpers/plan-rows.ts` | `planStatus`, `planFiles` (planner plan rows → `files:`), `relativeTo` | planner live test, findings.ts, live-helpers.test.ts | **evals** (`evals/subagents/support/plan-rows.ts`); `relativeTo` → shared path util | – |
| `helpers/overlay.ts` | `plain`, `key`, `fakeOverlayApi` (OverlayApi over real pi panes), `openLastOverlay`, `disposeOverlays`, `selectedRow`, `recordingTheme`, `grepSession` (recorded session fixture with NAMESPACE prompt record) | 6 unit tests + setup-context | **split**: `fakeOverlayApi`, `openLastOverlay`, `disposeOverlays`, `plain` → shared pi-facing (`test-framework/pi/overlay.ts`); `selectedRow`, `grepSession` → local | `recordingTheme` (overlay.ts:83, tagged + `<b>`) = `boldTheme` at `extensions/footer/test/render.test.ts:9` |
| `helpers/records.ts` | `agentRecord`, `newAgentInput` builders | 12 unit tests | **local** | – |
| `helpers/handoff.ts` | `VALID_HANDOFF` document | 2 subagents unit tests; the same document is inlined at `extensions/session-limits/test/limits.test.ts:48` and `handoff.test.ts:28` | **shared** (`test-framework/valid-handoff.ts`; subagents-only variants in `extensions/subagents/tests/support/handoff-cases.ts`), per review finding 20 | two extensions carry copies today |
| `plugins/agent-setup/setup-context.ts` | `SetupContext` fixture, `PATHS`, `press`, `render` | 3 agent-setup tests | **local** | `press` reducer pattern repeated at `questionnaire/test/form.test.ts:15` (domain-specific, leave) |
| `plugins/agent-view/fixtures/recorded-session.jsonl` | Recorded session file | `view.test.ts:41` | **local** fixture; the *builders* for such files are shared (`recorded-sessions.ts`) | `grepSession` (overlay.ts:115) builds the same kind of fixture in code |
| `live/fixtures/mcp-server.ts` | Stdio MCP server with one `code` tool returning argv[2] | `grants.live.test.ts:16` | **shared** (`test-framework/live/fixture-mcp-server.ts`) – generic MCP wiring fixture, mcp-import live tests could use it | – |

### 1.3 Other extensions

| Helper | Provides | Used by | Shared / local | Notes |
|---|---|---|---|---|
| `extensions/transcript/test/helpers.ts` | `rows` (`transcriptRows` instance), `numbered(count)` | 3 transcript tests | **local** | – |
| `extensions/questionnaire/test/fixtures.ts` | `SCOPE`, `PRIORITY` questions, `questions(...)`, re-exports `key`, `char` | 5 questionnaire tests | **local** (drop the key re-export) | – |
| `extensions/context/test/fixtures.ts` | `breakdown`, `facts` (`ContextFacts`), `usage` (`PromptTokens`), `STAMP`, `snapshot` | 3 context tests | **local**; `facts(...)` is a candidate for shared `contextFacts()` once a second user appears | – |

### 1.4 Duplication not tied to one helper file

| Pattern | Copies | Shared replacement |
|---|---|---|
| ANSI strip of rendered lines | `subagents/test/helpers/overlay.ts:17` `plain`, `core/test/adapter/tool-rows.ts:36` `visible`, `pi-tool-rows.test.ts:33` `plain`, `pi-transcript.test.ts:307` `plainLines`, `conformance.test.ts:903` `plain`, `composer/test/frame.test.ts:16` `visible`, plus ~20 inline `stripVTControlCharacters` maps | `plainLines(lines)`, `plainText(line)`, `visibleWidth(line)` in `rendered-text.ts` |
| Theme that records painted tokens | `core/test/manager/row.test.ts:19`, `session-limits/test/seed-row.test.ts:29`, `transcript/test/tools.test.ts:10` | `paintRecordingTheme()` → `{ theme, painted, bolded }` |
| Tagged theme with bold marker | `overlay.ts:83` `recordingTheme`, `footer/test/render.test.ts:9` `boldTheme` | `tokenTaggingTheme({ bold: true })` |
| Fake pi `ExtensionAPI` / `ctx` | `core/test/adapter/pi-working.test.ts:5`, `pi-editor.test.ts:25`, `pi-entries.test.ts:6`, `pi-context.test.ts:89`, `pi-editor-input.test.ts:15`, `conformance.test.ts:92`, `pi-adapter.test.ts:14,37`, `pi-footer.test.ts:25` (9 copies) | **local to pi-adapter**: `pi-adapter/tests/support/fake-pi.ts` (only pi-adapter tests need pi's API shape; not part of the framework) |
| `fetch` stub | `subagents/test/plugins/fetch-tool/plugin.test.ts:12`, `fetch.test.ts:19` | local `extensions/subagents/tests/support/fetch-stub.ts` |
| pi session bootstrap | `live.ts:236`, `wake.live.test.ts:41` | one `openPiSession(options)` in `test-framework/pi/live/` |

---

## 2 Live test classification

| File / block | Classification | Reason | Destination |
|---|---|---|---|
| `core/test/adapter/wake.live.test.ts` (both `it`) | LIVE TEST | Adapter mechanics: replaced main prompt survives a hidden wake run; hidden message sent at run start lands in that run. Marker-string assertions | `pi-adapter/tests/live/wake.live.test.ts` |
| `subagents/test/live/run-agent.live.test.ts` | LIVE TEST | One scout reaches `done`, has cost, session file linked to parent, wake carries the id. Wiring | `extensions/subagents/tests/live/run-agent.live.test.ts` |
| `nesting.live.test.ts` | LIVE TEST | Depth, caller ids, one wake to the nested caller, one wake to main. Wiring | `extensions/subagents/tests/live/nesting.live.test.ts` |
| `worktree.live.test.ts` | LIVE TEST | Worktree path, branch, kept cleanup, clean main checkout | `extensions/subagents/tests/live/worktree.live.test.ts` |
| `handoff.live.test.ts` | LIVE TEST | Context-limit handoff mechanics: state `handoff`, successor chain, one wake. It also validates the handoff document the agent wrote; keep that as a format check (the validator is deterministic). A handoff *quality* eval can come later (§7) | `extensions/subagents/tests/live/handoff.live.test.ts` |
| `grants.live.test.ts` (3 `it`) | LIVE TEST | Exact tool list, skill payload, MCP tool presence, no context leak, no write without the grant. The code-word answers only prove the granted tools were reachable | `extensions/subagents/tests/live/grants.live.test.ts`; `fixtures/mcp-server.ts` → `test-framework/live/fixture-mcp-server.ts` |
| `routing.live.test.ts` (`it.each` 9 cases) | EVAL | Judges `prompts/main-session.md` and the agents' `description` frontmatter: does the main session pick the right agent, pass `skills` only when named, write a brief with Goal/Scope/Done when/Return. Already repeated with the old routing-runs variable and printed as hit counts | `evals/subagents/routing/` |
| `planner-plan.live.test.ts` (`it.each` 3 fixtures) | EVAL | Plan quality of `agents/leads/planner.md`: recall of the commit's files, missing paths, helper count; majority of N runs | `evals/subagents/planner/` |
| `reviewer-review.live.test.ts` (`it.each` 3 fixtures) | EVAL | Does the reviewer find a planted defect (line within 5), cite the call site, give a verdict; majority of N | `evals/subagents/reviewer/` |
| `implementer-change.live.test.ts` (`it.each` 3 fixtures) | EVAL | Does the implementer's change pass the commit's hidden tests; majority of N; also logs largest bash output (helper delegation quality) | `evals/subagents/implementer/` |

Note: eval fixtures are pinned to historical SHAs and `seed(sha)` checks out *that* tree, so the restructure does not invalidate them (the implementer's hidden test paths such as `core/test/adapter/pi-editor.test.ts` are paths at the fixture SHA).

---

## 3 test-framework

### 3.1 Rules

- `test-framework/` is test-only; never in `package.json#files`.
- Pi-free root modules import only `pi-adapter/index.ts` (types plus the exported `textMetrics`, `resolveModel`, `CatalogModel`, review finding 8), `extension-manager/index.ts`, `ui-kit/index.ts` and `shared/index.ts`. Never `extensions/` (rule R12 of plan 02).
- `test-framework/pi/` is the only part that imports pi-adapter internals; it imports pi packages directly only where pi-adapter has no function for it (global theme and keybindings init, `createAgentSession` and loader for real sessions, pi's theme module for tool rows). Biome enforces it: the `test-framework/pi/**` override (listed after `test-framework/**`, because Biome overrides do not merge) lifts the pi-package ban; the architecture test only checks that no file outside `pi-adapter/**` and `test-framework/pi/**` imports a pi package.
- No provider or model names: the fake catalog keeps invented refs (`fake/model`, `acme/...`, `beta/...`); live and eval models come from env only.
- Extension tests import `test-framework` (and `test-framework/pi` when they render through pi); never `pi-adapter` internals. Extension-local helpers live in `extensions/<name>/tests/support/` (not `helpers/`, to keep them apart from the framework).
- Live mechanics shared by live tests and evals are generic: `test-framework/pi/live/live-extension.ts` exports `startLiveExtension({ extension, agentDir, settings })`, which boots any `createManagedExtension` result (its `.boot`) on a real agent runtime and a fake host. It isolates the run with a symlinked `auth.json` and a `PI_CODING_AGENT_DIR` override, both restored in teardown. Note, not scheduled: pi-ai's `fauxProvider` could later run parts of the mechanics tests (wake, grants, nesting) as CI-safe unit tests with scripted tool calls (plan 05 §4.3). The copy-and-write-back approach from plan 05 (credential copied through `readStoredCredential`, `HOME` override) was rejected because it races with pi's own token refresh. Subagents record types and chain helpers stay in `extensions/subagents/tests/support/live-harness.ts` as a thin layer over it (review finding 10).

### 3.2 Layout

```
test-framework/
├── index.ts                       # pi-free public API (everything below except pi/)
├── fake-host.ts                   # createFakeHost, FakeHost, createTurnScope, hiddenMessageTexts
├── fake-agent-runtime.ts          # createFakeAgentRuntime, FakeAgentRuntime, FakeChildSession, catalogModel
├── fake-form.ts                   # openFakeForm, FakeForm
├── usage-builders.ts              # usageTotals(cost, tokens), promptTokens({...})
├── key-presses.ts                 # key, char
├── themes.ts                      # plainTheme, tokenTaggingTheme, paintRecordingTheme
├── rendered-text.ts               # plainText, plainLines, visibleWidth (node:util only)
├── waiting.ts                     # flushMicrotasks, flushTimers, waitUntil, pause
├── temp-dirs.ts                   # useTempDirs (auto cleanup per file)
├── extension-harness.ts           # startExtension: plugins on extension-manager over fakes
├── recorded-sessions.ts           # build session .jsonl lines: userLine, assistantToolCall, toolResultLine, writeSessionFile
├── live/                          # pi-free helpers for live tests and evals
│   ├── seed-project.ts            # repoRoot, repoGit, seedProjectFromCommit, applyCommitDiff, replaceExactlyOnce
│   ├── fixture-mcp-server.ts      # stdio MCP server, one `code` tool (spawned via process.execPath)
│   ├── session-reading.ts         # bashCommands, largestToolOutput, commandsLine
│   └── cost.ts                    # totalCost, reportCost
├── eval-runs/                     # pi-free eval runner and scoring (renamed from evals/, review finding 17)
│   ├── index.ts
│   ├── eval-runs.ts               # evalRunCount (PI_EVAL_RUNS), repeatRuns
│   ├── rubric.ts                  # Check, Rubric, gradeRun, gradeRuns
│   ├── pass-threshold.ts          # expectPassRate, MAJORITY
│   ├── run-record.ts              # RunRecord, RunEvent (pi-free; output, events, usage incl. cost, timings, errors)
│   └── eval-report.ts             # reportEval (console + optional JSON file)
├── valid-handoff.ts               # VALID_HANDOFF (shared by session-limits and subagents tests); not handoff-document.ts, which is shared/'s basename
├── pi/                            # the pi-facing module
│   ├── index.ts
│   ├── render-theme.ts            # initPiRenderTheme, initPiKeybindings, plainPiTheme
│   ├── tool-rows.ts               # renderToolRows, renderPaneToolRows, renderEditDiff, piEditDiff, piRenderContext
│   ├── overlay.ts                 # createOverlayApi, openLastOverlay, disposeOverlays
│   ├── session-files.ts           # sessionFacts, parseSessionLines, readSessionFile, promptRecordEntry, sessionHeader
│   └── live/
│       ├── index.ts
│       ├── live-model.ts          # PI_LIVE_MODEL / PI_LIVE_CHORE_MODEL, setupLive, teardownLive, describeLive, liveAgentModel, liveChoreModel
│       ├── live-agent-dir.ts      # prepareAgentDir (auth.json symlink, models copy), PI_CODING_AGENT_DIR override and restore, realContextMarkers
│       ├── session-events.ts      # sessionEvents(messages), runUsage(session): fills RunRecord from the live session
│       ├── live-runtime.ts        # createLiveAgentRuntime
│       ├── pi-session.ts          # openPiSession (merges openMainLikeSession and wake's openSession)
│       └── live-extension.ts      # startLiveExtension: any managed extension on a real runtime + fake host
└── tests/                         # unit tests of the framework itself (fakes conformance, parsers, scoring)
```

Renames, so names say what they are without reading code:

| Old | New |
|---|---|
| `createFakeRuntime` | `createFakeAgentRuntime` |
| `taggedTheme` | `tokenTaggingTheme` |
| `recordingTheme` / `boldTheme` / local painted recorders | `tokenTaggingTheme({ bold: true })` / `paintRecordingTheme()` |
| `flush` | `flushMicrotasks` |
| `quiet` | `pause` |
| `createTurns` | `createTurnScope` |
| `wakeTexts` | `hiddenMessageTexts` |
| `fakeOverlayApi` / `realOverlayParts` | `createOverlayApi` |
| `liveRuns`, the old routing-runs variable | `evalRunCount`, `PI_EVAL_RUNS` |
| `concurrentRuns` | `repeatRuns(count, run, { parallel: true })` |
| `openMainLikeSession` | `openPiSession` |
| `costOf` | `totalCost` |
| `usageOf` | `usageTotals` |

### 3.3 Public API sketch

```ts
// test-framework/index.ts  (pi-free)
export type FakeHost = Host & { /* recorders and drivers as today: tools, commands, hidden, notices,
  widgets, overlays, forms, entries, ...; start, settle, turnEnd, runCommand, shutdown, tool, renderTool,
  pressEditorKey, emit, dialog, ... */ };
export function createFakeHost(info?: Partial<SessionInfo>): FakeHost;
export function createTurnScope(host: Pick<FakeHost, "idle" | "settle">): <T>(work: () => Promise<T>) => Promise<T>;
export function hiddenMessageTexts(host: FakeHost): string[];

export type FakeChildSession = ChildSession & { spec: SpawnSpec; finish(text: string, o?: FinishOptions): void;
  turn(context: Partial<ContextSnapshot>, stopReason?: StopReason, toolCalls?: number): void; emit(e: ChildEvent): void };
export type FakeAgentRuntime = AgentRuntime & { catalog: CatalogModel[]; children: FakeChildSession[];
  sessions: Map<string, SessionRecord>; failNextSpawn?: string; child(id: string): FakeChildSession };
export function createFakeAgentRuntime(extraModels?: CatalogModel[]): FakeAgentRuntime;
export function catalogModel(ref: string, authenticated?: boolean, patch?: Partial<CatalogModel>): CatalogModel;

export type FakeForm = { view: ViewComponent; closed: boolean; result?: unknown; render(width?: number): string[];
  press(...keys: KeyPress[]): void; type(text: string): void };
export function openFakeForm<T>(factory: FormFactory<T>, theme: ThemeLike, signal: AbortSignal | undefined,
  register: (form: FakeForm) => void): Promise<T | undefined>;

export function usageTotals(cost: number, tokens?: number): UsageTotals;
export function promptTokens(patch: Partial<PromptTokens>): PromptTokens;
export function key(name: KeyPress["name"], char?: string): KeyPress;
export function char(value: string): KeyPress;

export const plainTheme: ThemeLike;
export function tokenTaggingTheme(options?: { close?: (token: ThemeToken) => string; bold?: boolean }): ThemeLike;
export function paintRecordingTheme(): { theme: ThemeLike; painted: { token: ThemeToken; text: string }[]; bolded: string[] };

export function plainText(line: string): string;
export function plainLines(lines: string[]): string[];
export function visibleWidth(line: string): number;

export function flushMicrotasks(rounds?: number): Promise<void>;
export function flushTimers(): Promise<void>;
export function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void>;
export function pause(ms: number): Promise<void>;

export function useTempDirs(): { make(prefix?: string): string };   // registers afterEach/afterAll cleanup

export type ExtensionHarnessOptions<S> = { plugins: Plugin[]; settings: S; root: string;
  host?: FakeHost; runtime?: AgentRuntime; sessionPaths?: boolean /* id, file, cwd, agentDir under a temp root */ };
export type ExtensionHarness<S> = { root: string; host: FakeHost; runtime: AgentRuntime; settings: S;
  manager: ExtensionManager; services: ServiceRegistry; bus: Bus; errors: unknown[] };
export function startExtension<S>(options: ExtensionHarnessOptions<S>): ExtensionHarness<S>;

export function sessionLine(entry: SessionLineInput): string;          // recorded-sessions.ts
export function writeSessionFile(dir: string, lines: string[]): string;

// test-framework/live/*  (pi-free, re-exported from index.ts under `live`)
export const repoRoot: string;
export function repoGit(args: string[]): string;
export function seedProjectFromCommit(project: string, sha: string): void;    // git archive, fresh repo, node_modules link
export function applyCommitDiff(project: string, sha: string): void;          // uncommitted diff of sha^..sha
export function replaceExactlyOnce(project: string, edit: { file: string; from: string; to: string }): number; // returns line
export const fixtureMcpServerPath: string;
export function bashCommands(items: SessionItem[]): string[];
export function largestToolOutput(results: ToolOutput[], toolName: string): number;
export function totalCost(usages: Iterable<UsageTotals>): number;
export function reportCost(label: string, cost: number): void;

// test-framework/eval-runs/index.ts  (pi-free)
export function evalRunCount(): number;                                        // PI_EVAL_RUNS, default 1
export function repeatRuns<T>(count: number, run: (index: number) => Promise<T>, options?: { parallel?: boolean }): Promise<T[]>;
export type Check<O> = { name: string; passes(outcome: O): boolean; explain?(outcome: O): string };
export type Rubric<O> = Check<O>[];
export type RunEvent = { type: "message"; role: string; text: string } | { type: "tool_call"; name: string; arguments: unknown } | { type: "tool_result"; name: string; text: string; isError: boolean };
export type RunRecord = { output: string; events: RunEvent[];     // run-record.ts, pi-free
  usage: { inputTokens: number; outputTokens: number; toolCalls: number; costUsd?: number };   // costUsd absent when the model has no pricing: reported "unavailable", never $0
  timings: { totalMs: number }; errors: string[] };
export type RunCost = RunRecord["usage"];                                      // replaces { cost, durationMs }; duration is RunRecord["timings"].totalMs
export type GradedRun<O> = { index: number; outcome: O; failedChecks: string[]; passed: boolean; record: RunRecord };
export type EvalResult<O> = { name: string; runs: GradedRun<O>[]; passRate: number;
  checkPassRates: Record<string, number>; meanCost: number; meanDurationMs: number };
export function gradeRuns<O>(name: string, outcomes: O[], rubric: Rubric<O>, recordOf: (o: O) => RunRecord): EvalResult<O>;
export type PassThreshold = { moreThan: number } | { atLeast: number };          // fractions of runs
export const MAJORITY: PassThreshold;                                            // { moreThan: 0.5 }, today's rule
export function expectPassRate<O>(result: EvalResult<O>, threshold: PassThreshold, check?: string): void;
export function reportEval<O>(result: EvalResult<O>, describeRun?: (run: GradedRun<O>) => string[]): void;

// test-framework/pi/index.ts  (pi-facing)
export function initPiRenderTheme(): void;
export function initPiKeybindings(): void;
export const plainPiTheme: unknown;   // pi Theme, typed through pi-adapter
export function renderToolRows(rows: ToolRows, input: ToolInput): { lines: string[]; plain: string[] };
export function renderPaneToolRows(rows: ToolRows, input: PaneInput): string[];
export function piEditDiff(content: string, edits: { oldText: string; newText: string }[]): Promise<string>;
export function createOverlayApi(options?: { rows?: number; theme?: ThemeLike; host?: FakeHost }):
  { api: OverlayApi; state: { closed: boolean; renders: number }; transcripts: { owner?: string }[] };
export function openLastOverlay(host: FakeHost, rows?: number, theme?: ThemeLike):
  { view: ViewComponent; lines(width?: number): string[] };
export function disposeOverlays(): void;
export function sessionFacts(file: string): { tools: string[]; calls: string[]; results: ToolOutput[] };
export function parseSessionLines(lines: string[], promptRecord: string): SessionRecord;
export function sessionHeader(file: string): { parentSession?: string } | undefined;

// test-framework/pi/live/index.ts  (pi-facing, real agents)
export const LIVE_TIMEOUT_MS: number;
export function describeLive(name: string, body: () => void): void;            // fails, never skips, without env/credentials
export function liveAgentModel(): string;                                       // from PI_LIVE_MODEL
export function liveChoreModel(): string;                                       // PI_LIVE_CHORE_MODEL or the agent model
export function realContextMarkers(): string[];
export function createLiveAgentRuntime(options: { namespace: string; exclude: string[] },
  parent?: { trusted?: boolean; skillFiles?: SkillFile[] }): AgentRuntime;
export type PiSessionOptions = { root: string; systemPrompt?: string; builtinTools?: string[];
  customTools?: AnyToolSpec[]; skillPaths?: string[]; extensions?: { name: string; factory: unknown }[] };
export function openPiSession(options: PiSessionOptions):
  Promise<{ cwd: string; ask(text: string): Promise<void>; settledRuns(): number; close(): void }>;
export type LiveExtension = { host: FakeHost; runtime: AgentRuntime; settings: unknown; manager: ExtensionManager;
  run(text: string, timeoutMs: number): Promise<void>; close(): Promise<void> };
export function startLiveExtension<S>(options: { extension: ManagedExtension<S>; agentDir: string; settings?: Partial<S>;
  trusted?: boolean; skillFiles?: SkillFile[] }): LiveExtension;   // extension.boot from createManagedExtension
export function sessionEvents(messages: unknown[]): RunEvent[];                  // session-events.ts
export function runUsage(session: unknown): RunRecord["usage"];                  // from getSessionStats()
```

Extension-specific support that stays local (examples): `extensions/subagents/tests/support/{subagents-harness.ts, live-harness.ts, agent-patch.ts, agent-records.ts, handoff-cases.ts, recorded-grep-session.ts, routing-session.ts}`; `extensions/questionnaire/tests/support/questions.ts`; `extensions/context/tests/support/context-snapshots.ts`; `extensions/transcript/tests/support/transcript-rows.ts`; `pi-adapter/tests/support/fake-pi.ts`. `subagents/tests/support/` is the one support folder evals may import (`live-harness.ts`, `routing-session.ts`); `live-harness.ts` wraps `startLiveExtension` with subagents' agent-file patching, `AgentRecord` chain helpers (`runChain`, `chainLinks`, `wakeTexts`) and `spawnAgents`.

---

## 4 evals

### 4.1 Layout (per extension, then per judged subject)

```
evals/
├── subagents/
│   ├── support/
│   │   ├── agent-chains.ts           # runChain, ChainOutcome, handoverLines, helperCounts, taskLine
│   │   ├── reviewer-findings.ts      # parseFindings, findingRefs, hitsLine, citesFile
│   │   ├── reviewer-findings.test.ts # unit, runs in npm run check
│   │   ├── plan-rows.ts              # planStatus, planFiles
│   │   └── plan-rows.test.ts
│   ├── routing/
│   │   ├── routing-cases.ts          # request → expected agent / skill / direct answer
│   │   └── main-session-routing.eval.ts
│   ├── planner/
│   │   ├── planner-cases.ts          # sha, request, expected files, unscored, maxHelpers
│   │   └── plan-recall.eval.ts
│   ├── reviewer/
│   │   ├── reviewer-cases.ts         # sha, planted defect, edits, call sites
│   │   └── planted-defects.eval.ts
│   └── implementer/
│       ├── implementer-cases.ts      # sha, task, hidden tests
│       └── hidden-tests.eval.ts
└── (future: session-limits/ handoff summary quality, style/ concise answers)
```

- Eval files are `*.eval.ts`, never `*.test.ts`, so no unit or live glob can collect them.
- One folder per judged subject (a shipped agent file or a prompt); cases separate from the runner so adding a case touches data only.
- Evals import `test-framework`, `test-framework/eval-runs`, `test-framework/pi/live`, `extensions/subagents/tests/support/*` and `evals/*/support` (rule R13 of plan 02). Not extension `core/` or `ui/` directly; routing's tool stubs come from `subagents/tests/support/routing-session.ts`.

### 4.2 Model and run count

- Model only from env, same as live: `PI_LIVE_MODEL=provider/id[:thinking]` (leads), optional `PI_LIVE_CHORE_MODEL` (chores). One credential setup for both suites; no model names in eval code or cases.
- `PI_EVAL_RUNS` (default 1) replaces the old plan-runs variable and the old routing-runs variable.
- `PI_EVAL_REPORT=<file>` (optional) appends one JSON line per eval result. Each run is a `RunRecord`.
- Results are also written to a gitignored `evals/.results/<timestamp>/` holding one `observations.jsonl` and the session snapshots of failed runs (plan 05 §4.4).

### 4.3 Reporting

Console, one line per run and one per eval, as today:

```
[eval] reviewer/planted-defects 686fc95 run 2/5: done, found, findings 4, verdict ship with fixes, helpers 2 (scout 1, shell 1), calls 18, cost $0.41, 3m12s
[eval] reviewer/planted-defects 686fc95: 4/5 passed (needs > 50%), found 4/5, verdict 5/5, mean cost $0.38, mean 3m05s
```

JSON line: `{ name, case, model, runs, passRate, checkPassRates, meanCost, meanDurationMs, failedChecks[] , at }`. The model in the report comes from the env at run time, not from code.

### 4.4 Example eval sketch

```ts
// evals/subagents/reviewer/planted-defects.eval.ts
import { it } from "vitest";
import { evalRunCount, expectPassRate, gradeRuns, MAJORITY, repeatRuns, reportEval, type Rubric } from "../../../test-framework/eval-runs/index.ts";
import { applyCommitDiff, replaceExactlyOnce } from "../../../test-framework/live/seed-project.ts";
import { describeLive } from "../../../test-framework/pi/live/index.ts";
import { createLiveHarness } from "../../../extensions/subagents/tests/support/live-harness.ts";
import { runChain } from "../support/agent-chains.ts";
import { hitsLine, parseFindings } from "../support/reviewer-findings.ts";
import { reviewerCases, type ReviewerCase } from "./reviewer-cases.ts";

type Outcome = { state: string; found: boolean; verdict?: string; cost: number; durationMs: number };

const rubric: Rubric<Outcome> = [
  { name: "done", passes: (o) => o.state === "done" },
  { name: "found", passes: (o) => o.found, explain: (o) => `missed, state ${o.state}` },
];

const reviewOnce = async (entry: ReviewerCase, index: number): Promise<Outcome> => {
  const live = createLiveHarness(`review ${entry.sha} run ${index + 1}`, { agents: { reviewer: { from: "reviewer" }, scout: { from: "scout" } } });
  try {
    live.seed(`${entry.sha}^`);
    applyCommitDiff(live.project, entry.sha);
    const line = replaceExactlyOnce(live.project, entry.plant);
    const chain = await runChain(live, "reviewer", entry.task, entry.timeoutMs);
    const findings = parseFindings(chain.terminal?.resultText ?? "");
    return { state: chain.terminal?.state ?? "missing", found: hitsLine(findings, { file: entry.plant.file, line, slack: 5 }),
      cost: chain.cost, durationMs: chain.durationMs };
  } finally {
    await live.close();
  }
};

describeLive("eval reviewer planted defects", () => {
  it.each(reviewerCases)("reviews $sha", async (entry) => {
    const outcomes = await repeatRuns(evalRunCount(), (index) => reviewOnce(entry, index), { parallel: true });
    const result = gradeRuns(`reviewer/planted-defects ${entry.sha}`, outcomes, rubric, (o) => o);
    reportEval(result);
    expectPassRate(result, MAJORITY);
  });
});
```

### 4.5 Why not pi's evals package

Pi ships `@earendil-works/pi-evals`, but it is private to the pi monorepo, its runner `vitest-evals` peers vitest 4 while this repo pins vitest 5, and its harness rejects any loaded extension, so it cannot run ours. We keep the custom runner and borrow the run record shape, the isolation pattern, the vitest settings and the session snapshot. Details in [05](05-pi-evals-research.md).

---

## 5 Config and script changes

| File | Change |
|---|---|
| `vitest.config.ts` (unit) | explicit list, no repo-wide glob: `include: ["pi-adapter/tests/**/*.test.ts", "extension-manager/tests/**/*.test.ts", "ui-kit/tests/**/*.test.ts", "shared/tests/**/*.test.ts", "extensions/*/tests/**/*.test.ts", "test-framework/tests/**/*.test.ts", "evals/**/support/**/*.test.ts", "test/**/*.test.ts"]`, `exclude: [...configDefaults.exclude, "**/*.live.test.ts", "**/*.eval.ts"]` |
| `vitest.live.config.ts` | `include: ["extensions/*/tests/live/**/*.live.test.ts", "pi-adapter/tests/live/**/*.live.test.ts"]`; rest unchanged (no file parallelism, verbose, 600 s test, 120 s hook) |
| `vitest.evals.config.ts` (new) | `include: ["evals/**/*.eval.ts"]`, `pool: "forks"`, `maxWorkers: 1`, `fileParallelism: false`, `reporters: ["verbose"]`, `testTimeout: 1_800_000` (cases set their own), `hookTimeout: 120_000` |
| `package.json` scripts | add `"evals": "vitest run --config vitest.evals.config.ts"`; keep `test`, `test:live`; `check` stays `typecheck && lint && test` (unit only) |
| `package.json#files` | explicit entries, no brace patterns (npm 11 expands `extensions/*/{index.ts,api,core,ui}/**` to `extensions/*/index.ts/**`, which drops every `index.ts`, review finding 3): `pi-adapter`, `extension-manager`, `ui-kit`, `shared`, `extensions/*/index.ts`, `extensions/*/api/**`, `extensions/*/core/**`, `extensions/*/ui/**`, `extensions/*/prompts/**`, `extensions/subagents/agents`, `extensions/*/README.md`, `extensions/*/ARCHITECTURE.md`, `extensions/*/STRUCTURE.md`, `README.md`, `LICENSE`, `ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`, `!**/tests/**` (negation verified with npm 11.19.1); never list `test-framework`, `evals`, `docs` |
| `pi.extensions` | `./extensions/<name>/index.ts` |
| `tsconfig.json#include` | `["pi-adapter", "extension-manager", "extensions", "test-framework", "evals", "test", "vitest.config.ts", "vitest.live.config.ts", "vitest.evals.config.ts"]` |
| `.github/workflows/ci.yml` pack check | negative: `! grep -E '/tests?/|test-framework/|evals/|\.snap|fixtures|\.eval\.ts' pack.txt`; positive: `test "$(grep -c 'extensions/[a-z-]*/index.ts' pack.txt)" = 13` so a wrong `files` entry cannot silently drop the entry files. CI never runs `test:live` or `evals` |
| `test/architecture.test.ts` | keeps only what Biome cannot express (plan 01, reconciled): R10 (`extensions/*/index.ts` contains only `export … from "./api/…"`), R14 (folder shape: allowed names under `extensions/<name>/`, `*.test.ts` only in `tests/`, no `src/`), the pi-package placement check (`pi-adapter/**`, `test-framework/pi/**` only), `test-framework` root modules never import `test-framework/pi`, `pi.extensions` ↔ `extensions/*/index.ts` match (13), no `*.eval.ts` outside `evals/`, no duplicate basenames repo-wide among non-index, non-test files. Path-direction rules are Biome overrides (plan 01); dead code is knip. |
| `biome.json` overrides | move `extensions/mcp-import/test/**` to `extensions/mcp-import/tests/**`; add the `test-framework/**` ban and the later `test-framework/pi/**` exemption (plan 01) |
| README / ARCHITECTURE / STRUCTURE / subagents README | test sections: `npm run evals`, `PI_EVAL_RUNS`, `PI_EVAL_REPORT`; move the routing/planner/reviewer/implementer paragraphs from the subagents README's live list to an evals list |

---

## 6 Migration steps

| # | Step | Risk | Mitigation |
|---|---|---|---|
| 1 | Create `test-framework/` by **moving** `core/test/helpers/*` and the shared parts of `core/test/adapter/{offline,render-theme,tool-rows,live}.ts`; leave the old files as one-line re-exports | Low | Re-exports keep the 74+ importers compiling; `npm run check` green before step 2 |
| 2 | Add new unit tests in `test-framework/tests/` (fake host contract coverage, `rendered-text`, rubric, pass threshold) and add `test-framework/tests/**` to the unit include | Low | – |
| 3 | Merge duplicates: `key`/`char`, themes (`tokenTaggingTheme`, `paintRecordingTheme`), `plainLines`, `useTempDirs`, `usageTotals`, `openPiSession` (wake + routing). Update call sites file by file | Medium: themes differ subtly (close tag `</>` vs `""`, bold marker) and snapshot-like string assertions depend on them | Keep options that reproduce each variant exactly; no assertion text changes in this step |
| 4 | Pull `textMetrics` through pi-adapter's public surface (`pi-adapter/api` or `pi-adapter/index.ts`) for `plainTheme`; decide whether `plainTheme` stays pi-backed (§7) | Medium: wrap/truncate behaviour of every rendering unit test | Run the full unit suite; diff failures only |
| 5 | Repo restructure (other plan): `core/adapter` → `pi-adapter/`, `core/manager` → `extension-manager/`, `extensions/*/test` → `tests/`, local helpers to `tests/support/`. Switch imports from the re-export shims to `test-framework` and delete the shims | High: mass path change across ~150 test files, architecture test rewrite | Mechanical codemod per extension, one commit each; architecture test updated in the same commit as the paths it checks |
| 6 | Split subagents helpers: `harness.ts` → `subagents-harness.ts` on `startExtension`; `live.ts` → `live-harness.ts` on `seedProjectFromCommit`; `turns.ts` → framework; `findings.ts`, `plan-rows.ts`, chain parts of `live-runs.ts` → `evals/subagents/support/`; split `live-helpers.test.ts` and `findings.test.ts` along | Medium | Unit tests of these helpers move with them and stay in `npm run check` |
| 7 | Move live tests to `extensions/subagents/tests/live/` and `pi-adapter/tests/live/`; MCP fixture to `test-framework/live/`; update `vitest.live.config.ts` | Low | `npm run test:live` once locally with a cheap model; check the same pass/fail as before |
| 8 | Convert the four quality suites to `evals/**/*.eval.ts` on the eval runner (rubric, `repeatRuns`, `expectPassRate(MAJORITY)`, `reportEval`); add `vitest.evals.config.ts` and `npm run evals`; replace the old plan-runs variable / the old routing-runs variable with `PI_EVAL_RUNS` | Medium: behaviour change in thresholds or logging would break comparisons with past runs | Keep identical thresholds and log fields; run `PI_EVAL_RUNS=1 npm run evals` once and compare lines with an old `test:live` log |
| 9 | Config hardening: `package.json#files`, CI pack grep, tsconfig include, biome override, new architecture rules | Low–medium: a wrong `files` glob ships tests or drops runtime files | `npm pack --dry-run` diff against the pre-restructure list |
| 10 | Docs: README, ARCHITECTURE, STRUCTURE, subagents README | Low | – |

---

## 7 Open questions

1. ~~`plainTheme` and pi-tui.~~ Decided (review finding 8): `pi-adapter/index.ts` exports `textMetrics`, `resolveModel`, `CatalogModel`, `ModelPreferences`; `plainTheme` stays pi-backed and `themes.ts` stays in the pi-free root (it imports only `pi-adapter/index.ts`).
2. **Import style.** Relative paths (`../../../test-framework/index.ts`) as today, or Node subpath imports in `package.json#imports` (`#test-framework`, `#test-framework/pi`, `#test-framework/eval-runs`)? Subpath imports read better and survive moves; they put test paths in the published `package.json`.
3. **Pi calls with no pi-adapter function** (`initTheme`, `setKeybindings`, `createAgentSession`, `DefaultResourceLoader`, pi's theme module URL): keep them in `test-framework/pi/` under the architecture rule, or add test-support exports to pi-adapter (dead code in the shipped package)?
4. **Eval model env.** Reuse `PI_LIVE_MODEL` / `PI_LIVE_CHORE_MODEL` (proposed) or add `PI_EVAL_MODEL` so evals can run a stronger lead than the live suite without editing the shell each time?
5. **Thresholds.** Keep the single `MAJORITY` rule for all evals, or allow per-case thresholds (e.g. the cross-module reviewer fixture that is documented as expected to miss on cheap models could declare `{ atLeast: 0 }` and only report)?
6. ~~Report location.~~ Decided (plan 05 §4.4): console lines plus a gitignored `evals/.results/<timestamp>/` with `observations.jsonl` and session snapshots; `PI_EVAL_REPORT` stays as the opt-in single file. Tests may write there: the AGENTS.md file rule binds extensions, not tests.
7. **Grants and handoff.** Both depend on the model following an instruction (call these tools, read files in turn). They are kept as live tests because the assertions are mechanical; confirm, and decide whether a separate handoff *document quality* eval is wanted.
8. ~~Extension-manager harness for other extensions.~~ Decided: every extension is a `createManagedExtension` result (plan 02 §4), so `startExtension` takes either a plugin list or a managed extension (`extension.boot`) and one harness serves all 13.
