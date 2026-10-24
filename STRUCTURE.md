# Repository structure

Folder layout only. Runtime behavior is described in ARCHITECTURE.md.

### Tree

```
pi-extensions/
├── core/                        # shared code, no extension-specific logic
│   ├── adapter/                 # the only place that imports pi packages
│   │   ├── contract.ts          # host/runtime interfaces and shared types, ThemeLike (fg over role tokens, bold, italic, inverse, panels, width, truncate, wrap)
│   │   ├── pi-adapter.ts        # createPiExtension: contract -> pi API
│   │   ├── pi-child.ts          # runtime that starts child agent sessions
│   │   ├── pi-skills.ts         # skill inventory: loaded skill commands plus pi's default discovery
│   │   ├── pi-ui.ts             # HostUi: widgets, overlay, notify, key observation, thinking label, columns
│   │   ├── pi-form.ts           # HostUi.showForm: the inline form shell
│   │   ├── pi-overlay.ts        # overlaysCleared: waits until no overlay is visible
│   │   ├── pi-text-input.ts     # form TextInput over pi-tui's Editor, its theme and focus
│   │   ├── pi-transcript.ts     # transcript pane, pi renderer capture
│   │   ├── pi-tools.ts          # tool wrapping, themeLike (role tokens -> pi colours) and textMetrics
│   │   │                        #   (width, truncate, wrap), fitLines (cut lines to a width)
│   │   ├── pi-keys.ts           # KeyPress naming through pi keybinding ids
│   │   ├── pi-editor.ts         # editor subclass: optional EditorFrame, empty-←/↓/Esc hooks, key capture
│   │   ├── pi-editor-history.ts # ↑ input history shared by every editor, seeded on resume and fork
│   │   ├── pi-editor-input.ts   # editor submit key, command completion, re-submit
│   │   ├── pi-footer.ts         # custom footer, live context/model/thinking getters
│   │   ├── pi-notice.ts         # HostUi.setNotice: one-line notices between the editor and the footer
│   │   ├── pi-context.ts        # Host.contextFacts and request usage, composed
│   │   ├── pi-context-prompt.ts # prompt sections (replay or system prompt) and tools with source and exposure
│   │   ├── pi-context-messages.ts # per-message and per-block token estimates
│   │   ├── pi-usage.ts          # last and main request usage, main memoised on session and leaf
│   │   ├── pi-entries.ts        # Host.registerEntryRenderer and registerMessageRenderer over pi's renderers
│   │   ├── pi-thinking-label.ts # hidden thinking label: composed hint, record on globalThis, OSC 133 prefix
│   │   ├── pi-row-component.ts  # RowComponent (padded row lines plus an indented pi body under ↳), the
│   │   │                        #   tool-rows record on globalThis and the shared output pad
│   │   ├── pi-tool-rows.ts      # Host.registerToolRows: a pi tool renderer resolver that draws rows (built-ins
│   │   │                        #   included) in the self shell, shared with transcript panes
│   │   ├── pi-models.ts / model-resolver.ts  # model catalog (availableModels: credentialed models with
│   │   │                        #   their thinking levels), matching
│   │   ├── pi-phase.ts          # turn phase reducer (waiting/thinking/writing/toolArgs/tool/idle)
│   │   ├── pi-scope.ts          # child scope (no extension boots in an agent)
│   │   ├── pi-codemode.ts       # codemode worker cap (PI_CODEMODE_MAX_WORKERS), owned value shared by adapter copies
│   │   ├── pi-sections.ts       # prompt sections shared by every adapter copy (main and agents), each with its owner
│   │   ├── pi-working.ts        # working message and visibility (HostUi)
│   │   ├── main-prompt.ts       # rebuilds the main session system prompt
│   │   ├── session-file.ts      # reads session jsonl: entries, transcripts, context tokens
│   │   └── usage.ts / messages.ts / route.ts # usage sums, text (finalRunTexts: a child's final run), routing
│   ├── manager/                 # pi-free shared code
│   │   ├── extension-manager.ts # enables plugins in dependency order
│   │   ├── plugin.ts / bus.ts   # plugin and typed event bus types
│   │   ├── handoff.ts           # handoff sections and validator (shared format)
│   │   ├── channels.ts          # busy/awaiting-input/usage/totals channel names, payloads, parsers
│   │   ├── format.ts            # token, window, duration, error-text, ~/ and short path formatters,
│   │   │                        #   noun/counted, and the receipt: formatCost, formatCalls, receipt,
│   │   │                        #   receiptText, plainReceipt
│   │   ├── cache.ts             # cache hit rate, its colour thresholds and coloured percentage
│   │   ├── layout.ts            # padding, dot separator, ELLIPSIS and cutStart, accent rule, wrapped lines
│   │   ├── list.ts              # selectable list: lines, keys, shared hints
│   │   ├── select.ts            # single-choice form over the list
│   │   ├── tabs.ts              # tab bar and Tab/←→ keys (questionnaire, /agents setup)
│   │   ├── multi-select.ts      # checkbox list (Space, a all, n none, scroll window) and multiSelectForm
│   │   ├── marks.ts             # state marks: MARKS (◌ ✓ ✗ ⊘ » ↳ ›), Mark, markGlyph, markOf
│   │   ├── hints.ts             # hint grammar: EXPAND_BINDING, expandHint, appendHint, countLine,
│   │   │                        #   keyHints and hintLines (bottom strips)
│   │   ├── row.ts               # pi-native row layout: the 0/2/4 grid, row/rowChildren, titleLine,
│   │   │                        #   failureSuffix, wrapChild, preview
│   │   └── settings.ts / settle.ts  # settings (schema, file merge, session watch), timeouts
│   └── test/                    # mirrors core/adapter and core/manager
│       ├── adapter/             # adapter tests, wake.live.test.ts, live.ts, render-theme.ts,
│       │                        #   offline.ts (pi loaded offline for extension tests), tool-rows.ts
│       │                        #   (tool rows rendered through pi for extension tests)
│       ├── manager/
│       └── helpers/             # fakes.ts (fake host, runtime and child session), fake-form.ts (fake showForm)
├── extensions/
│   ├── subagents/               # background agents (main extension)
│   │   ├── src/
│   │   │   ├── index.ts         # entry point, wires settings + plugins
│   │   │   ├── plugins.ts       # ordered plugin list
│   │   │   ├── model/           # types, events, plugin, settings, paths,
│   │   │   │                    #   agent-schema, agent-override (override value checks),
│   │   │   │                    #   model-resolution (resolutionProblem), context-limit
│   │   │   ├── components/      # pure TUI render helpers (format.ts formatters and agentReceipt, padding and
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
│   │   ├── test/                # mirrors src, plus helpers/ and live/ (+ live/fixtures; routing.live.test.ts
│   │   │                        #   checks the main session's routing, planner-plan.live.test.ts
│   │   │                        #   the planner's plan on past commits, reviewer-review and
│   │   │                        #   implementer-change score the reviewer and implementer
│   │   │                        #   on past commits too)
│   │   └── README.md
│   ├── session-limits/          # main session hands over before it fills
│   │   ├── src/                 # index, conversation, limits, thresholds,
│   │   │                        #   handoff, settings, seed-row (the handoff seed message as a row)
│   │   ├── prompts/handoff.md   # handoff instruction template
│   │   ├── test/
│   │   └── README.md
│   ├── spending/                # footer with total session cost
│   │   ├── src/                 # index, ledger, footer, spending
│   │   ├── test/
│   │   └── README.md
│   ├── working-indicator/       # current activity and prompt time in the working line
│   │   ├── src/                 # index, working-indicator
│   │   ├── test/
│   │   └── README.md
│   ├── notifications/           # terminal notification when pi waits for you
│   │   ├── src/                 # index, notifications, settings
│   │   ├── test/
│   │   └── README.md
│   ├── command-aliases/         # friendlier names for built-in commands
│   │   ├── src/                 # index, command-aliases (ALIASES)
│   │   ├── test/
│   │   └── README.md
│   ├── composer/                # input between two rules with pi's › message cursor as the prompt
│   │   ├── src/                 # index, composer, frame
│   │   ├── test/
│   │   └── README.md
│   ├── questionnaire/           # questionnaire tool: batch of multiple-choice questions in one form
│   │   ├── src/                 # index, questionnaire (tool spec, execute), view (form view, arm delay),
│   │   │                        #   form (pure state; tab keys from core/manager/tabs.ts), render (form
│   │   │                        #   lines), summary (call and result renderers), result (types,
│   │   │                        #   normalising, model text)
│   │   ├── test/
│   │   └── README.md
│   ├── style/                   # /style: output style for the main session and every agent
│   │   ├── src/                 # index, style (wiring), styles (prompt files), settings (file I/O),
│   │   │                        #   pick (the list)
│   │   ├── prompts/concise.md   # one file per style, front matter `description:`
│   │   ├── test/
│   │   └── README.md
│   ├── context/                 # /context: context window breakdown and cache hits
│   │   ├── src/                 # index, context (command, entry renderer, short paths), buckets (facts
│   │   │                        #   to breakdown), breakdown (usage model, cache figures), snapshot
│   │   │                        #   (stored entry validation), grid, details (sections, message buckets),
│   │   │                        #   render (compose), summary (plain one-line summary)
│   │   ├── test/
│   │   └── README.md
│   ├── footer/                  # multi-line status footer with session totals
│   │   ├── src/                 # index, footer (wiring), render (pure line builders)
│   │   ├── test/
│   │   └── README.md
│   ├── transcript/              # tool rows (state glyph, title, ↳ outcome) and the thinking label
│   │   ├── src/                 # index, transcript (wiring), tools (the look per tool, titles, outcomes),
│   │   │                        #   look (shared look types and helpers), shell (bash, powershell),
│   │   │                        #   codemode (summary and nested call rows), generic (MCP and unknown
│   │   │                        #   tools), output (clean lines, shell status, previews, count lines),
│   │   │                        #   diff (parse, count and draw an edit's diff), words (changed words)
│   │   ├── test/
│   │   └── README.md
│   └── mcp-import/              # /mcp-import: MCP servers from Claude Code or Cursor into pi's mcp.json
│       ├── src/                 # index, mcp-import (command, file I/O), args (parse, complete),
│       │                        #   sources (each tool's files), convert (one entry), plan (merge
│       │                        #   without overwriting), pick (source and server choice without
│       │                        #   arguments), report (messages)
│       ├── test/
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
agent-registry/     # in-memory agent records (registry.ts)
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

- Only `core/adapter/**` (and its tests in `core/test/adapter/**`) may import pi packages; enforced by biome (`noRestrictedImports`). `test/architecture.test.ts` enforces the other import and layout rules, including that extension tests reach the adapter only through `contract.ts` and `core/test/adapter`.
- Each plugin folder has `index.ts` (the plugin) plus helpers; plugins never import each other.
- Extensions never import each other; they only share `core/`. Cross-extension formats and channel names live in `core/manager/handoff.ts` and `core/manager/channels.ts`.
- Tests live outside `src/` and mirror the source path (`src/plugins/x` -> `test/plugins/x`).
- `*.live.test.ts` (in `extensions/subagents/test/live/`, plus the adapter's `core/test/adapter/wake.live.test.ts`) are local-only and need `PI_LIVE_MODEL` plus pi credentials. Their helper API in `core/test/adapter/live.ts`: `setupLive()` and `teardownLive()` create and remove the temporary agent dir (`describeLive` calls them in `beforeAll`/`afterAll` and fails, never skips, when setup is impossible), `liveAgentModel()` returns the model from `PI_LIVE_MODEL`, `liveChoreModel()` the one from the optional `PI_LIVE_CHORE_MODEL` (else the same). `extensions/subagents/test/helpers/live.ts` builds the live harness on top (`seed(sha)` fills the project from `git archive`), with the pure `agent-patch.ts`, `plan-rows.ts` and `findings.ts` beside it, `turns.ts` to keep the fake host busy across overlapping runs and settle it once per turn, and `live-runs.ts` to run a lead's chain to its close and repeat a fixture in parallel.
- Settings files are `<agentDir>/pi-<extension>.json` (user) and `<cwd>/.pi/pi-<extension>.json` (trusted projects): `pi-subagents.json`, `pi-session-limits.json`, `pi-notifications.json`, `pi-style.json`. The files the extensions write are listed in ARCHITECTURE.md (Persistence summary).
- Custom entries in the main session file are named `<namespace>:<kind>`, for example `pi-spending:usage` and `pi-context:snapshot` (one per `/context` in tui mode).
- Prompts (`prompts/*.md`) and agent definitions (`agents/**/*.md`) are markdown read at runtime.
- No provider or model names in code or prompts (unit-test fixtures use neutral fake names). The shipped agent files name their models as configuration, and the subagents README lists them.

### Published vs development-only

- Published: the explicit `files` list in `package.json`: `core/adapter`, `core/manager`, `extensions/*/src/**`, `extensions/*/prompts/**`, `extensions/subagents/agents`, `extensions/*/README.md`, and the root `README.md`, `LICENSE`, `ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`. No tests, fixtures or snapshots are packed; CI fails if they appear in `npm pack`.
- Entry points (`pi.extensions`): `extensions/{subagents,session-limits,spending,working-indicator,notifications,command-aliases,composer,questionnaire,style,context,footer,mcp-import,transcript}/src/index.ts`.
- Development-only: `core/test`, `extensions/*/test`, `test/`, `.github/`, config files below.

### Config files

- `package.json`: version, pi entry points, `files`, scripts (`check`, `test`, `test:live`).
- `tsconfig.json`: strict NodeNext, no emit, includes `core`, `extensions`, `test`.
- `vitest.config.ts`: unit tests (`core/test`, `extensions/*/test`, `test`), excludes `*.live.test.ts`.
- `vitest.live.config.ts`: only live tests, serial, long timeouts.
- `biome.json`: format/lint, plus the pi-import restriction outside the adapter.
- `.github/workflows/ci.yml`: Node 22, `npm run check` and the pack contents check; no credentials, no live tests.
- `.gitignore`: node_modules, .DS_Store, .claude.
