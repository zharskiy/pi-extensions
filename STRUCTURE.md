# Repository structure

Folder layout only. Runtime behavior is described in ARCHITECTURE.md.

### Tree

```
pi-extensions/
├── pi-adapter/                  # the only shipped code that imports pi packages
│   ├── index.ts                 # the public surface: contract types, createPiExtension, settleWithin, row geometry
│   ├── types/                   # contract types
│   │   └── contract.ts          # host/runtime interfaces and shared types, ThemeLike (fg over role tokens, bold, inverse, panels, width, truncate, wrap)
│   ├── runtime/                 # pi session wiring
│   │   ├── pi-adapter.ts        # createPiExtension: contract -> pi API
│   │   ├── pi-phase.ts          # turn phase reducer (waiting/thinking/writing/toolArgs/tool/idle)
│   │   ├── pi-scope.ts          # child scope (no extension boots in an agent)
│   │   ├── pi-shared.ts         # shared(name, init): one record per name on globalThis, shared by adapter copies
│   │   ├── session-file.ts      # reads session jsonl: entries, transcripts, context tokens
│   │   ├── messages.ts / route.ts # text (finalRunTexts: a child's final run), routing
│   │   └── settle-within.ts     # settleWithin: wait for a promise at most ms
│   ├── child/                   # child sessions, models, skills
│   │   ├── pi-child.ts          # runtime that starts child agent sessions
│   │   ├── pi-skills.ts         # skill inventory: loaded skill commands plus pi's default discovery
│   │   ├── pi-models.ts / model-resolver.ts  # model catalog (availableModels: credentialed models with
│   │   │                        #   their thinking levels), matching
│   │   └── pi-codemode.ts       # codemode worker cap (PI_CODEMODE_MAX_WORKERS), owned value shared by adapter copies
│   ├── ui/                      # HostUi on pi-tui
│   │   ├── pi-ui.ts             # HostUi: widgets, overlay, notify, key observation, thinking label, columns
│   │   ├── pi-tui-context.ts    # HostState (current ctx and tools) and tuiContext (the ctx when in tui mode)
│   │   ├── pi-form.ts           # HostUi.showForm: the inline form shell
│   │   ├── pi-overlay.ts        # overlaysCleared: waits until no overlay is visible
│   │   ├── pi-text-input.ts     # form TextInput over pi-tui's Editor, its theme and focus
│   │   ├── pi-keys.ts           # KeyPress naming through pi keybinding ids
│   │   ├── pi-footer.ts         # custom footer, live context/model/thinking getters
│   │   ├── pi-notice.ts         # HostUi.setNotice: one-line notices between the editor and the footer
│   │   ├── pi-thinking-label.ts # hidden thinking label: composed hint, record on globalThis, OSC 133 prefix
│   │   ├── pi-working.ts        # working message and visibility (HostUi)
│   │   └── row-layout.ts        # PAD, CHILD_COLUMN, CHILD_MARK, isBlankLine, childLead: row geometry
│   ├── editor/
│   │   ├── pi-editor.ts         # editor subclass: optional EditorFrame, empty-←/↓/Esc hooks, key capture
│   │   ├── pi-editor-history.ts # ↑ input history shared by every editor, seeded on resume and fork
│   │   └── pi-editor-input.ts   # editor submit key, command completion, re-submit
│   ├── tools/                   # tool registration and rendering
│   │   ├── pi-tools.ts          # tool wrapping, themeLike (role tokens -> pi colours) and textMetrics
│   │   │                        #   (width, truncate, wrap), fitLines (cut lines to a width)
│   │   ├── pi-tool-rows.ts      # Host.registerToolRows: a pi tool renderer resolver that draws rows (built-ins
│   │   │                        #   included) in the self shell, shared with transcript panes
│   │   ├── pi-row-component.ts  # RowComponent (padded row lines plus an indented pi body under ↳), the
│   │   │                        #   tool-rows record on globalThis and the shared output pad
│   │   ├── pi-entries.ts        # Host.registerEntryRenderer and registerMessageRenderer over pi's renderers
│   │   └── pi-transcript.ts     # transcript pane, pi renderer capture
│   ├── context/
│   │   ├── pi-context.ts        # Host.contextFacts and request usage, composed
│   │   ├── pi-context-prompt.ts # prompt sections (replay or system prompt) and tools with source and exposure
│   │   ├── pi-context-messages.ts # per-message and per-block token estimates
│   │   ├── usage.ts             # usage sums
│   │   └── pi-usage.ts          # last and main request usage, main memoised on session and leaf
│   ├── prompt/
│   │   ├── main-prompt.ts       # rebuilds the main session system prompt
│   │   └── pi-sections.ts       # prompt sections shared by every adapter copy (main and agents), each with its owner
│   └── tests/                   # adapter tests (may import adapter files and pi directly), live/wake.live.test.ts
├── extension-manager/           # plugin runtime; imports pi-adapter/index.ts and shared/index.ts only
│   ├── index.ts                 # public surface
│   ├── extension-manager.ts     # enables plugins in dependency order
│   ├── bus.ts                   # createBus, the typed event bus
│   ├── watch-settings.ts        # settings session watch and once-per-error warnings
│   └── tests/
├── ui-kit/                      # theme-aware components; imports pi-adapter/index.ts and shared/index.ts only
│   ├── index.ts                 # public surface
│   ├── cache-tone.ts            # cache rate colour thresholds and coloured percentage
│   ├── list.ts                  # selectable list: lines, keys, shared hints
│   ├── select.ts                # single-choice form over the list
│   ├── tabs.ts                  # tab bar and Tab/←→ keys (questionnaire, /agents setup)
│   ├── multi-select.ts          # checkbox list (Space, a all, n none, scroll window) and multiSelectForm
│   ├── glyphs.ts                # state marks: MARKS (◌ ✓ ✗ ⊘ » ↳ ›), Mark, markGlyph, markOf, pointerMark
│   ├── key-hints.ts             # hint grammar: EXPAND_BINDING, expandHint, appendHint, countLine,
│   │                            #   keyHints and hintLines (bottom strips), framed (rule, lines, hints, rule)
│   ├── row.ts                   # pi-native row layout: the 0/2/4 grid, row/rowChildren, titleLine,
│   │                            #   failureSuffix, wrapChild, preview
│   └── tests/
├── shared/                      # pi-free, theme-free helpers; imports pi-adapter/index.ts only
│   ├── index.ts                 # public surface
│   ├── plugin-contract.ts       # plugin, services and typed event bus types
│   ├── handoff-document.ts      # handoff sections and validator (shared format)
│   ├── host-channels.ts         # busy/awaiting-input/usage/totals channel names, payloads, parsers
│   ├── format.ts                # token, window, duration, error-text, ~/ and short path formatters,
│   │                            #   noun/counted, formatCost and formatMoney
│   ├── cache-hit.ts             # cache hit rate
│   ├── text-layout.ts           # dot separator, ELLIPSIS and cutStart, accent rule, wrapped lines
│   ├── plain-object.ts          # isPlainObject
│   ├── settings-files.ts        # settings schema, file parsing and merge, readText
│   └── tests/
├── test-framework/              # test-only fakes and harnesses, never published
│   ├── index.ts                 # pi-free surface (imports only the four layer index.ts files)
│   ├── fake-host.ts             # createFakeHost, createTurnScope, hiddenMessageTexts, FAKE_FOOTER_KEY
│   ├── fake-agent-runtime.ts    # createFakeAgentRuntime, FakeChildSession, catalogModel (invented refs)
│   ├── fake-form.ts             # fake showForm with a fake text input
│   ├── themes.ts                # plainTheme, tokenTaggingTheme, paintRecordingTheme
│   ├── key-presses.ts  rendered-text.ts  usage-builders.ts  waiting.ts  temp-dirs.ts
│   ├── extension-harness.ts     # startExtension: plugins on the extension manager over the fakes
│   ├── recorded-sessions.ts     # session .jsonl line builders
│   ├── valid-handoff.ts         # VALID_HANDOFF
│   ├── live/                    # pi-free live helpers: seed-project, session-reading, cost, the MCP fixture server
│   ├── eval-runs/               # pi-free eval runner: run-record, repeatRuns, rubric, pass-threshold, reportEval
│   ├── pi/                      # the only test helpers that import pi: render-theme, tool-rows, overlay, session-files
│   │   └── live/                # describeLive, isolated agent dir, live runtime, openPiSession,
│   │                            #   startLiveExtension, session-events (RunRecord from a live session)
│   └── tests/                   # unit tests of the framework
├── extensions/
│   ├── subagents/               # background agents (main extension)
│   │   ├── src/
│   │   │   ├── index.ts         # entry point, wires settings + plugins
│   │   │   ├── plugins.ts       # ordered plugin list
│   │   │   ├── model/           # types, events, plugin, settings, paths,
│   │   │   │                    #   agent-schema, agent-override (override value checks),
│   │   │   │                    #   model-resolution (resolutionProblem), context-limit,
│   │   │   │                    #   manifest (manifest.json read and restore)
│   │   │   ├── components/      # pure TUI render helpers (format.ts formatters, the receipt (receipt,
│   │   │   │                    #   receiptText, plainReceipt, formatCalls) and agentReceipt, padding and
│   │   │   │                    #   wrapping over the theme, state-text.ts marks, spinner, words
│   │   │   │                    #   and stop words, agent-row, tree.ts (chain links, terminals,
│   │   │   │                    #   tree order, connectors, selection carry), refresh.ts
│   │   │   │                    #   throttle/ticker and tick cadence)
│   │   │   └── plugins/         # one folder per feature, see below
│   │   ├── agents/              # bundled agent definitions (*.md): leads/ (planner, implementer,
│   │   │                        #   reviewer, general), chores/ (scout, editor, fetch, shell,
│   │   │                        #   image, verifier)
│   │   ├── prompts/             # main-session.md, main-session-agent-status.md,
│   │   │                        #   base-system-prompt.md, handoff.md, create-agent.md (the /agents create brief)
│   │   ├── tests/               # mirrors src, plus support/ and live/ (routing.live.test.ts
│   │   │                        #   checks the main session's routing, planner-plan.live.test.ts
│   │   │                        #   the planner's plan on past commits, reviewer-review and
│   │   │                        #   implementer-change score the reviewer and implementer
│   │   │                        #   on past commits too)
│   │   └── README.md
│   ├── session-limits/          # main session hands over before it fills
│   │   ├── src/                 # index, conversation, limits, thresholds,
│   │   │                        #   handoff, settings, seed-row (the handoff seed message as a row)
│   │   ├── prompts/handoff.md   # handoff instruction template
│   │   ├── tests/
│   │   └── README.md
│   ├── spending/                # footer with total session cost
│   │   ├── src/                 # index, ledger, footer, spending
│   │   ├── tests/
│   │   └── README.md
│   ├── working-indicator/       # rotating verb and prompt time in the working line
│   │   ├── src/                 # index, working-indicator
│   │   ├── tests/
│   │   └── README.md
│   ├── notifications/           # terminal notification when pi waits for you
│   │   ├── src/                 # index, notifications, settings
│   │   ├── tests/
│   │   └── README.md
│   ├── command-aliases/         # friendlier names for built-in commands
│   │   ├── src/                 # index, command-aliases (ALIASES)
│   │   ├── tests/
│   │   └── README.md
│   ├── composer/                # input between two rules with pi's › message cursor as the prompt
│   │   ├── src/                 # index, composer, frame
│   │   ├── tests/
│   │   └── README.md
│   ├── questionnaire/           # questionnaire tool: batch of multiple-choice questions in one form
│   │   ├── src/                 # index, questionnaire (tool spec, execute), view (form view, arm delay),
│   │   │                        #   form (pure state; tab keys from ui-kit/tabs.ts), render (form
│   │   │                        #   lines), summary (call and result renderers), result (types,
│   │   │                        #   normalising, model text)
│   │   ├── tests/
│   │   └── README.md
│   ├── style/                   # /style: output style for the main session and every agent
│   │   ├── src/                 # index, style (wiring), styles (prompt files), settings (file I/O),
│   │   │                        #   pick (the list)
│   │   ├── prompts/concise.md   # one file per style, front matter `description:`
│   │   ├── tests/
│   │   └── README.md
│   ├── context/                 # /context: context window breakdown and cache hits
│   │   ├── src/                 # index, context (command, entry renderer, short paths), buckets (facts
│   │   │                        #   to breakdown), breakdown (usage model, cache figures), snapshot
│   │   │                        #   (stored entry validation), grid, details (sections, message buckets),
│   │   │                        #   render (compose), summary (plain one-line summary)
│   │   ├── tests/
│   │   └── README.md
│   ├── footer/                  # multi-line status footer with session totals
│   │   ├── src/                 # index, footer (wiring), render (pure line builders)
│   │   ├── tests/
│   │   └── README.md
│   ├── transcript/              # tool rows (state glyph, title, ↳ outcome) and the thinking label
│   │   ├── src/                 # index, transcript (wiring), tools (the look per tool, titles, outcomes),
│   │   │                        #   look (shared look types and helpers), shell (bash, powershell),
│   │   │                        #   codemode (summary and nested call rows), generic (MCP and unknown
│   │   │                        #   tools), output (clean lines, shell status, previews, count lines),
│   │   │                        #   diff (parse, count and draw an edit's diff), words (changed words)
│   │   ├── tests/
│   │   └── README.md
│   └── mcp-import/              # /mcp-import: MCP servers from Claude Code or Cursor into pi's mcp.json
│       ├── src/                 # index, mcp-import (command, file I/O), args (parse, complete),
│       │                        #   sources (each tool's files), convert (one entry), plan (merge
│       │                        #   without overwriting), pick (source and server choice without
│       │                        #   arguments), report (messages)
│       ├── tests/
│       └── README.md
├── docs/research/               # background notes: pi's rendering surface, another agent's transcript
├── test/architecture.test.ts    # import-boundary and layout rules
├── AGENTS.md                    # short guide for coding agents
├── ARCHITECTURE.md              # how it works
├── STRUCTURE.md                 # this file
├── LICENSE
├── README.md                    # package overview
└── .github/workflows/ci.yml     # npm run check, package contents check
```

### Subagents plugins (extensions/subagents/src/plugins/)

```
fetch-tool/         # the fetch tool: index.ts (plugin, `fetchTool` service, tool spec), fetch.ts (request,
                    #   limits, redirects), text.ts (readable text, title)
agent-definitions/  # loads agents/**/*.md: loader.ts (files, then the agents.<name> overrides and
                    #   their checks), fields.ts (field rules), yaml-lite.ts (frontmatter parser),
                    #   prompt assembly
agent-registry/     # in-memory agent records (registry.ts), restored from manifests at session start
run-agent/          # index.ts (plugin, wake, block invalidation), runner.ts (skills and spawn-cap
                    #   checks), tools.ts (run_agent, message_agent), render.ts (block), placement.ts
                    #   + worktree.ts, task.ts (task text), outbox.ts, result.ts (result pick,
                    #   result.md, inlining), model-text.ts, semaphore.ts, handoff.ts (handoff
                    #   template and schema service), handoff-tool.ts (every child's handoff tool)
agent-status/       # status tool and snapshots
agent-view/         # /agents menu and overlay: index (command, menu, routing to services), overlay.ts (list/view host),
                    #   list.ts + list-model.ts (tree sections), view.ts, loader.ts,
                    #   request-block.ts (the view's Request block)
agent-setup/        # /agents setup and create: index (plugin, service, save), form.ts (pure state
                    #   and keys), render.ts (form lines), line.ts (one-line form), write.ts (merge
                    #   into the file), create.ts (/agents create: parse and the brief for the main
                    #   session), agent-template.ts (the skeleton the brief embeds)
interrupt/          # Esc after an interrupted turn: confirm to stop running agents (index.ts)
agent-panel/        # panel below the editor: model.ts (rows, window, lingers), keys.ts (selection keys)
limits/             # per-agent context limit steps
usage-report/       # reports agent usage to the spending channel
```

### Conventions

- Only `pi-adapter/**` (including `pi-adapter/tests/`) and `test-framework/pi/**` may import pi packages, and everything else reaches the adapter only through `pi-adapter/index.ts`; both enforced by biome (`noRestrictedImports`). Shipped code never imports `test-framework/`. `test/architecture.test.ts` enforces the other import and layout rules.
- Each plugin folder has `index.ts` (the plugin) plus helpers; plugins never import each other.
- Extensions never import each other; they only share `extension-manager/`, `ui-kit/` and `shared/`. Cross-extension formats and channel names live in `shared/handoff-document.ts` and `shared/host-channels.ts`.
- Tests live outside `src/` in `tests/` and mirror the source path (`src/plugins/x` -> `tests/plugins/x`); extension-local helpers live in `tests/support/`, shared ones in `test-framework/`.
- `*.live.test.ts` (in `extensions/subagents/tests/live/`, plus the adapter's `pi-adapter/tests/live/wake.live.test.ts`) are local-only and need `PI_LIVE_MODEL` plus pi credentials. Their helper API is `test-framework/pi/live/`: `describeLive` creates the temporary agent dir in `beforeAll` (a link to the real `auth.json`, a copy of `models.json`, `PI_CODING_AGENT_DIR` pointed at it) and removes it and restores the variable in `afterAll`; it fails, never skips, when setup is impossible. `liveAgentModel()` returns the model from `PI_LIVE_MODEL`, `liveChoreModel()` the one from the optional `PI_LIVE_CHORE_MODEL` (else the same), `startLiveExtension` boots a plugin list on the real runtime over the fake host, and `openPiSession` opens a real pi session. `extensions/subagents/tests/support/live-harness.ts` builds the subagents live harness on top (`seed(sha)` fills the project through `seedProjectFromCommit`), with the pure `agent-patch.ts`, `plan-rows.ts` and `findings.ts` beside it and `live-runs.ts` to run a lead's chain to its close.
- Settings files are `<agentDir>/pi-<extension>.json` (user) and `<cwd>/.pi/pi-<extension>.json` (trusted projects): `pi-subagents.json`, `pi-session-limits.json`, `pi-notifications.json`, `pi-style.json`. The files the extensions write are listed in ARCHITECTURE.md (Persistence summary).
- Custom entries in the main session file are named `<namespace>:<kind>`, for example `pi-spending:usage` and `pi-context:snapshot` (one per `/context` in tui mode).
- Prompts (`prompts/*.md`) and agent definitions (`agents/**/*.md`) are markdown read at runtime.
- No provider or model names in code or prompts (unit-test fixtures use neutral fake names). The shipped agent files name their models as configuration, and the subagents README lists them.

### Published vs development-only

- Published: the explicit `files` list in `package.json`: `pi-adapter`, `extension-manager`, `ui-kit`, `shared` (each without its `tests/`), `extensions/*/src/**`, `extensions/*/prompts/**`, `extensions/subagents/agents`, `extensions/*/README.md`, and the root `README.md`, `LICENSE`, `ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`. No tests, fixtures, snapshots, `test-framework/` or `evals/` are packed; CI fails if they appear in `npm pack` or if the pack does not hold the 13 entry files.
- Entry points (`pi.extensions`): `extensions/{subagents,session-limits,spending,working-indicator,notifications,command-aliases,composer,questionnaire,style,context,footer,mcp-import,transcript}/src/index.ts`.
- Development-only: `test-framework/`, `pi-adapter/tests`, `extension-manager/tests`, `ui-kit/tests`, `shared/tests`, `extensions/*/tests`, `test/`, `.github/`, config files below.

### Config files

- `package.json`: version, pi entry points, `files`, scripts (`check`, `test`, `test:live`).
- `tsconfig.json`: strict NodeNext, no emit, includes `pi-adapter`, `extension-manager`, `ui-kit`, `shared`, `extensions`, `test-framework`, `test`.
- `vitest.config.ts`: unit tests (`pi-adapter/tests`, `extension-manager/tests`, `ui-kit/tests`, `shared/tests`, `extensions/*/tests`, `test-framework/tests`, `test`), excludes `*.live.test.ts` and `*.eval.ts`.
- `vitest.live.config.ts`: only live tests (`extensions/*/tests/live`, `pi-adapter/tests/live`), serial, long timeouts.
- `biome.json`: format/lint, plus the pi-import restriction outside the adapter and `test-framework/pi`, and the layer rules for `pi-adapter`, `shared`, `ui-kit`, `extension-manager`, `test-framework`, `evals` and `test`.
- `.github/workflows/ci.yml`: Node 22, `npm run check` and the pack contents check; no credentials, no live tests.
- `.gitignore`: node_modules, .DS_Store, .claude.
