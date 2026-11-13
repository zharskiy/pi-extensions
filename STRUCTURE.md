# Repository structure

Where things are at the top level. Each code folder has its own `STRUCTURE.md` with one line per file; the rules are in [ARCHITECTURE.md](ARCHITECTURE.md).

```
pi-extensions/
├── platform/
│   ├── pi-adapter/          the only shipped code that imports pi packages; `tools/` also holds the skill-read detection
│   ├── shared/              pi-free, theme-free, host-free helpers
│   ├── ui-kit/              theme-aware rendering components
│   └── extension-manager/   createManagedExtension, plugins, bus, settings
├── extensions/<name>/   14 extensions: index.ts api/ core/ ui/ tests/ (prompts/ agents/)
├── launcher/            the standalone `pi-sandbox` command: bin/ cli/ config/ workspace/ backend/ container/ image/ proxy/ grants/ hostpi/ provision/ shared/ examples/ schema/ tests/
├── test/
│   ├── architecture.test.ts
│   ├── docs-sync.test.ts
│   ├── framework/           fakes, harnesses, pi/ (real pi), live/, eval-runs/
│   └── evals/               prompt-quality evals, local only
├── future-plans/        research and specs for work not started, one folder per topic (sandbox-services/: sidecar services next to the sandbox)
├── .github/workflows/   ci.yml
├── README.md  AGENTS.md  ARCHITECTURE.md  STRUCTURE.md  LICENSE
└── package.json  tsconfig.json  biome.json  knip.json  vitest.config.ts
```

## Folders

- [platform/pi-adapter/](platform/pi-adapter/STRUCTURE.md): `index.ts` and `types/`, `runtime/`, `child/`, `ui/`, `editor/`, `tools/`, `context/`, `prompt/`, `tests/`; `editor/` holds the editor subclass behind the empty-editor key hooks, `ui/key-layout.ts` the Cyrillic-to-QWERTY table behind layout-independent letter hotkeys, `runtime/` the record of custom follow-ups queued in a session, which tells a run's final reply and the model and thinking level a handoff keeps and restores outside the model and thinking callbacks, `tools/transcript.ts` the transcript pane, which draws only what the session file holds plus `rule` items a caller inserts (the subagents view's chain seams, each followed by the successor's seed, which starts it with no task prompt), and `tools/previous-session.ts` the renderer that draws the previous session after a handoff above a labelled seam rule (`ui/rules.ts`'s `labelledRule`, which session-limits and transcript import from the adapter too) (its custom entries through the entry renderer record in `tools/entry-renderers.ts`, minus those registered with `previousSession: false`, such as session-limits' kept entries).
- [platform/shared/](platform/shared/STRUCTURE.md): helper modules grouped by concern (`plugin/`, `handoff/` with the handoff prompt template `handoff-prompt.md` (call the `handoff` tool, then end the turn without a reply), `channels/`, `text/`), three top-level helpers (`project-dir.ts` owns `<cwd>/.pi/`, creating it with its `.gitignore` for every project write) and `tests/`; its admission rule is at the top of that file.
- [platform/ui-kit/](platform/ui-kit/STRUCTURE.md): flat component modules (rows, including the handoff rows, and the context limit's look, `context-limit.ts`) and `tests/`.
- [platform/extension-manager/](platform/extension-manager/STRUCTURE.md): the manager, the managed-extension factory, the bus, the settings error report and `tests/`.
- `extensions/`: one folder per extension (the footer's context label reads `working context` against a session-limits handoff point), each with `README.md` (for users), `ARCHITECTURE.md` and `STRUCTURE.md`: [command-aliases](extensions/command-aliases/STRUCTURE.md), [composer](extensions/composer/STRUCTURE.md), [context](extensions/context/STRUCTURE.md), [footer](extensions/footer/STRUCTURE.md), [mcp-import](extensions/mcp-import/STRUCTURE.md), [model-default](extensions/model-default/STRUCTURE.md), [notifications](extensions/notifications/STRUCTURE.md), [questionnaire](extensions/questionnaire/STRUCTURE.md), [session-limits](extensions/session-limits/STRUCTURE.md), [spending](extensions/spending/STRUCTURE.md), [style](extensions/style/STRUCTURE.md), [subagents](extensions/subagents/STRUCTURE.md), [transcript](extensions/transcript/STRUCTURE.md), [working-indicator](extensions/working-indicator/STRUCTURE.md). The `style` prompts live in `extensions/style/prompts/`, `concise.md` being the default, and the `subagents` prompts in `extensions/subagents/prompts/`. The `subagents` launch and settle guards live in `extensions/subagents/core/run-agent/runner.ts`. The `session-limits` rule for continuing after a handoff is `continueWithSeed: !handedOff` (the local copy of `state.handedOff` taken when the switch runs) in `extensions/session-limits/core/limits.ts`; the seed's late-results section and the grouping of kept messages into the new session's user prompts are in `extensions/session-limits/core/handoff.ts`, the input capture in `extensions/session-limits/core/limits.ts` over `Host.onInput` (`platform/pi-adapter/runtime/host.ts`), shown in the chat as the entries of `extensions/session-limits/core/kept-entries.ts` drawn by `extensions/session-limits/ui/kept-entries.ts` (the kept message flush with the chat through `registerEntryRenderer`'s `flush` option in `platform/pi-adapter/tools/entry-renderers.ts`, compared with pi's user message through `test/framework/pi/entry-rendering.ts`), the subagents hold in `extensions/subagents/api/plugins/run-agent.ts` (which also registers `run_agent`, `message_agent` and `stop_agent`, specified in `extensions/subagents/core/run-agent/tools.ts`) and an agent's own handoff hold in `heldHandoff`, `releaseHold` and `unhold` in `extensions/subagents/core/run-agent/runner.ts`. The transcript's shell status patterns, both forms of pi's timeout line included, are in `extensions/transcript/ui/output.ts`. The chain walks every subagents surface shares, `chainTerminal` and `chainLinks`, each stopping at an id it already visited, are in `extensions/subagents/core/model/agent-record.ts`.
- [launcher/](launcher/STRUCTURE.md): the host-side `pi-sandbox` command that runs pi on Colima in one container per launch; `bin/` (the published entry runs the built `dist/`, the dev entry the sources), `cli/` (the launch context, the pipeline with its VM step, the commands, the hidden uninstall command, the sweep, the host routing of every `pi update` form, of `pi config` without `-l` and of the commands that start no session, the host pi lookup, which takes only pi's managed install, and the one line printed when there is none, and the doctor's report by area), `config/` (the one config file over the defaults, the default `pi.dev` host, the parent proxy parser), `workspace/` (discovery, workspace mode with its bare and detached folders, the guard, the read-only hooks dirs and the git change report), `backend/` (the Colima adapter and VM), `container/` (the spec, the volume plan, the per-launch container), `image/` (a minimal image, without curl, python3, gh or glab; the entrypoint links the render dir into the agent dir and copies `auth.json` read-only), `proxy/` (one egress proxy per repository), `grants/` (grants and the launch registry), `hostpi/` (host pi files and host tools to placeholders and rules), `provision/` (the render dir, the agent files sync with its write-back of allowlisted preferences to the host, host sessions), `shared/` (locks, liveness, the paths under `<agent dir>/pi-sandbox/`, state layout, the npmrc, ini and Maven parsers), `examples/` (a sample config file), `schema/`, `install.sh`, `uninstall.sh`, `THREAT-MODEL.md`, `REMOVED-DEFAULTS.md` (what earlier versions shipped and how to add it back) and `tests/` (fakes and an isolated git in `support/`, real-engine tests in `live/`). The files it writes are listed in [Files written](launcher/ARCHITECTURE.md#files-written) in `launcher/ARCHITECTURE.md`.
- [test/framework/](test/framework/STRUCTURE.md): root fakes, `live/`, `eval-runs/`, `pi/`, `pi/live/`, `tests/`.
- [test/evals/](test/evals/README.md): `subagents/<subject>/` with `*-cases.ts` and `*.eval.ts`, shared helpers in `subagents/support/` and their tests in `subagents/tests/`; results go to the gitignored `test/evals/.results/`.
- `test/architecture.test.ts`: the structure rules Biome cannot express.
- `test/docs-sync.test.ts`: the rule that extension and launcher code changes come with doc changes.

## Config files

- `package.json`: version, `bin` (`pi-sandbox`, `launcher/bin/pi-sandbox.js`), `pi.extensions` (the 14 `extensions/<name>/index.ts` entries), the published `files`, and the scripts: `check` (typecheck, lint, knip, test), `build:launcher` (compiles `launcher/` to the gitignored `launcher/dist/`, run by `prepack`, because Node does not strip types under `node_modules`), `test`, `test:live`, `evals`, `lint`, `format`, `typecheck`, `knip`.
- `tsconfig.json`: strict NodeNext, no emit, over every code folder.
- `vitest.config.ts`: three projects, picked with `--project`:
  - `unit` (`npm run test`): every `tests/` folder (`launcher/tests/` included) and `test/`, without `*.live.test.ts`.
  - `live` (`npm run test:live`): only live tests (`extensions/*/tests/live/`, `platform/pi-adapter/tests/live/`, `launcher/tests/live/`), serial, long timeouts.
  - `evals` (`npm run evals`): only evals (`test/evals/**/*.eval.ts`), one forked worker, serial, 30 minutes per test, results under `test/evals/.results/<timestamp>/`.
- `biome.json`: format and lint, the import-cycle and unused-code rules, and the per-folder `noRestrictedImports` overrides that hold each layer to its imports (`launcher/**` may not import pi packages, `platform/`, `extensions/` or `test/`).
- `knip.json`: unused exports, types, files and dependencies; entries are the 14 extension `index.ts` files, the evals, the MCP fixture server, `launcher/cli/main.ts` and `launcher/proxy/daemon.ts`.
- `.github/workflows/ci.yml`: Node 22, `npm run check` and the pack contents check; no credentials, no live tests, no evals.
- `.gitignore`: `node_modules`, `.DS_Store`, `.claude`, `test/evals/.results`, `launcher/dist`.

## Published vs development-only

- Published (`files` in `package.json`): `launcher/` (with the built `launcher/dist/`, without `bin/pi-sandbox-dev.js` and `tsconfig.build.json`), `platform/` (`pi-adapter/`, `extension-manager/`, `ui-kit/`, `shared/`), each extension's `index.ts`, `api/`, `core/`, `ui/`, `prompts/`, `README.md` and the subagents `agents/`, plus the root `README.md`, `LICENSE`, `ARCHITECTURE.md`, `STRUCTURE.md` and `AGENTS.md`; every `tests/` folder is excluded.
- Development-only: `test/` (with `test/framework/` and `test/evals/`), every `tests/`, `future-plans/`, `.github/` and the config files.
