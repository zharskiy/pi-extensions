# Repository structure

Folder layout only. Runtime behavior is described in ARCHITECTURE.md.

### Tree

```
pi-extensions/
├── core/                        # shared code, no extension-specific logic
│   ├── adapter/                 # the only place that imports pi packages
│   │   ├── contract.ts          # host/runtime interfaces and shared types
│   │   ├── pi-adapter.ts        # createPiExtension: contract -> pi API
│   │   ├── pi-child.ts          # runtime that starts child agent sessions
│   │   ├── pi-ui.ts / pi-tools.ts   # pi TUI components, tool wrapping
│   │   ├── pi-models.ts / model-resolver.ts  # model catalog, matching
│   │   ├── pi-scope.ts          # child scope (no extension boots in an agent)
│   │   ├── main-prompt.ts       # rebuilds the main session system prompt
│   │   ├── session-file.ts      # reads session jsonl: entries, transcripts, context tokens
│   │   └── usage.ts / messages.ts / route.ts # usage sums, text, routing
│   ├── manager/                 # pi-free shared code
│   │   ├── extension-manager.ts # enables plugins in dependency order
│   │   ├── plugin.ts / bus.ts   # plugin and typed event bus types
│   │   ├── handoff.ts           # handoff sections and validator (shared format)
│   │   ├── channels.ts          # busy/usage channel names, payloads, parsers
│   │   └── settings.ts / settle.ts  # settings, timeouts
│   └── test/                    # mirrors core/adapter and core/manager
│       ├── adapter/             # adapter tests, live.ts, render-theme.ts
│       ├── manager/
│       └── helpers/fakes.ts     # fake host, runtime and child session
├── extensions/
│   ├── subagents/               # background agents (main extension)
│   │   ├── src/
│   │   │   ├── index.ts         # entry point, wires settings + plugins
│   │   │   ├── plugins.ts       # ordered plugin list
│   │   │   ├── model/           # types, events, plugin, settings, paths,
│   │   │   │                    #   agent-schema, context-limit
│   │   │   ├── components/      # pure TUI render helpers (agent-row, agent-list,
│   │   │   │                    #   collapsible, context-breakdown,
│   │   │   │                    #   system-prompt-block, refresh.ts throttle/ticker, hints.ts)
│   │   │   └── plugins/         # one folder per feature, see below
│   │   ├── agents/              # bundled agent definitions (*.md)
│   │   ├── prompts/             # main-session.md, main-session-agent-status.md,
│   │   │                        #   base-system-prompt.md, handoff.md
│   │   ├── test/                # mirrors src, plus helpers/ and live/ (+ live/fixtures)
│   │   └── README.md
│   ├── session-limits/          # main session hands over before it fills
│   │   ├── src/                 # index, conversation, limits, thresholds,
│   │   │                        #   handoff, settings
│   │   ├── prompts/handoff.md   # handoff instruction template
│   │   ├── test/
│   │   └── README.md
│   └── spending/                # footer with total session cost
│       ├── src/                 # index, ledger, footer, spending
│       ├── test/
│       └── README.md
├── test/architecture.test.ts    # import-boundary and layout rules
├── research/                    # pi extension API and SDK notes (development only)
├── AGENTS.md                    # short guide for coding agents
├── ARCHITECTURE.md              # how it works
├── STRUCTURE.md                 # this file
├── LICENSE
├── README.md                    # package overview
└── .github/workflows/ci.yml     # npm run check, package contents check
```

### Subagents plugins (extensions/subagents/src/plugins/)

```
agent-definitions/  # loads agents/*.md: loader.ts, fields.ts (field rules),
                    #   yaml-lite.ts (frontmatter parser), prompt assembly
agent-registry/     # in-memory agent records (registry.ts)
run-agent/          # runner.ts, tools.ts (run_agent, message_agent), placement.ts
                    #   + worktree.ts, task.ts (task text), outbox.ts, result.ts,
                    #   prompts.ts (forwarded dialogs), model-text.ts, semaphore.ts,
                    #   handoff.ts (handoff template and schema service)
agent-status/       # status tool and snapshots
agent-view/         # /agents command view, view-mode store
agent-list-view/    # agent list overlay
progress-widget/    # live progress widget below the editor
notifications/      # completion notifications
limits/             # per-agent context limit steps
usage-report/       # reports agent usage to the spending channel
```

### Conventions

- Only `core/adapter/**` (and its tests in `core/test/adapter/**`) may import pi packages; enforced by biome (`noRestrictedImports`). `test/architecture.test.ts` enforces the other import and layout rules.
- Each plugin folder has `index.ts` (the plugin) plus helpers; plugins never import each other.
- Extensions never import each other; they only share `core/`. Cross-extension formats and channel names live in `core/manager/handoff.ts` and `core/manager/channels.ts`.
- Tests live outside `src/` and mirror the source path (`src/plugins/x` -> `test/plugins/x`).
- `*.live.test.ts` (in `extensions/subagents/test/live/`) are local-only and need `PI_LIVE_MODEL` plus pi credentials. Their helper API in `core/test/adapter/live.ts`: `setupLive()` and `teardownLive()` create and remove the temporary agent dir (`describeLive` calls them in `beforeAll`/`afterAll` and fails, never skips, when setup is impossible), `liveAgentModel()` returns the model from `PI_LIVE_MODEL`. `extensions/subagents/test/helpers/live.ts` builds the live harness on top.
- Prompts (`prompts/*.md`) and agent definitions (`agents/*.md`) are markdown read at runtime.
- No provider or model names in code or prompts (unit-test fixtures use neutral fake names). The shipped agent files name their models as configuration, and the subagents README lists them.

### Published vs development-only

- Published: the explicit `files` list in `package.json`: `core/adapter`, `core/manager`, `extensions/*/src/**`, `extensions/*/prompts/**`, `extensions/subagents/agents`, `extensions/*/README.md`, and the root `README.md`, `LICENSE`, `ARCHITECTURE.md`, `STRUCTURE.md`, `AGENTS.md`. No tests, fixtures or snapshots are packed; CI fails if they appear in `npm pack`.
- Entry points (`pi.extensions`): `extensions/{subagents,session-limits,spending}/src/index.ts`.
- Development-only: `core/test`, `extensions/*/test`, `test/`, `research/`, `.github/`, config files below.

### Config files

- `package.json`: version, pi entry points, `files`, scripts (`check`, `test`, `test:live`).
- `tsconfig.json`: strict NodeNext, no emit, includes `core`, `extensions`, `test`.
- `vitest.config.ts`: unit tests, excludes `*.live.test.ts`.
- `vitest.live.config.ts`: only live tests, serial, long timeouts.
- `biome.json`: format/lint, plus the pi-import restriction outside the adapter.
- `.github/workflows/ci.yml`: Node 22, `npm run check` and the pack contents check; no credentials, no live tests.
- `.gitignore`: node_modules, .DS_Store, .claude.
