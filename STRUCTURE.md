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
├── test/
│   ├── architecture.test.ts
│   ├── docs-sync.test.ts
│   ├── framework/           fakes, harnesses, pi/ (real pi), live/, eval-runs/
│   └── evals/               prompt-quality evals, local only
├── future-plans/        research and specs for work not started
├── .github/workflows/   ci.yml
├── README.md  AGENTS.md  ARCHITECTURE.md  STRUCTURE.md  LICENSE
└── package.json  tsconfig.json  biome.json  knip.json  vitest.config.ts
```

## Folders

- [platform/pi-adapter/](platform/pi-adapter/STRUCTURE.md): `index.ts` and `types/`, `runtime/`, `child/`, `ui/`, `editor/`, `tools/`, `context/`, `prompt/`, `tests/`; `editor/` holds the editor subclass behind the empty-editor key hooks, `ui/key-layout.ts` the Cyrillic-to-QWERTY table behind layout-independent letter hotkeys, `runtime/` the record of custom follow-ups queued in a session, which tells a run's final reply and the model and thinking level a handoff keeps and restores outside the model and thinking callbacks, and `tools/transcript.ts` the transcript pane, which draws only what the session file holds.
- [platform/shared/](platform/shared/STRUCTURE.md): helper modules grouped by concern (`plugin/`, `handoff/` with the handoff prompt template `handoff-prompt.md` (call the `handoff` tool, then end the turn without a reply), `channels/`, `text/`), three top-level helpers (`project-dir.ts` owns `<cwd>/.pi/`, creating it with its `.gitignore` for every project write) and `tests/`; its admission rule is at the top of that file.
- [platform/ui-kit/](platform/ui-kit/STRUCTURE.md): flat component modules (rows, including the handoff rows) and `tests/`.
- [platform/extension-manager/](platform/extension-manager/STRUCTURE.md): the manager, the managed-extension factory, the bus, the settings error report and `tests/`.
- `extensions/`: one folder per extension (the footer's context label reads `working context` against a session-limits handoff point), each with `README.md` (for users), `ARCHITECTURE.md` and `STRUCTURE.md`: [command-aliases](extensions/command-aliases/STRUCTURE.md), [composer](extensions/composer/STRUCTURE.md), [context](extensions/context/STRUCTURE.md), [footer](extensions/footer/STRUCTURE.md), [mcp-import](extensions/mcp-import/STRUCTURE.md), [model-default](extensions/model-default/STRUCTURE.md), [notifications](extensions/notifications/STRUCTURE.md), [questionnaire](extensions/questionnaire/STRUCTURE.md), [session-limits](extensions/session-limits/STRUCTURE.md), [spending](extensions/spending/STRUCTURE.md), [style](extensions/style/STRUCTURE.md), [subagents](extensions/subagents/STRUCTURE.md), [transcript](extensions/transcript/STRUCTURE.md), [working-indicator](extensions/working-indicator/STRUCTURE.md). The `style` prompts live in `extensions/style/prompts/`, `concise.md` being the default, and the `subagents` prompts in `extensions/subagents/prompts/`. The `session-limits` rule for continuing after a handoff is `continueWithSeed: !handedOff` (the local copy of `state.handedOff` taken when the switch runs) in `extensions/session-limits/core/limits.ts`; the seed's late-results section and the grouping of kept messages into the new session's user prompts are in `extensions/session-limits/core/handoff.ts`, the input capture in `extensions/session-limits/core/limits.ts` over `Host.onInput` (`platform/pi-adapter/runtime/host.ts`), shown in the chat as the entries of `extensions/session-limits/core/kept-entries.ts` drawn by `extensions/session-limits/ui/kept-entries.ts` (the kept message flush with the chat through `registerEntryRenderer`'s `flush` option in `platform/pi-adapter/tools/entry-renderers.ts`), the subagents hold in `extensions/subagents/api/plugins/run-agent.ts` and an agent's own handoff hold in `heldHandoff`, `releaseHold` and `unhold` in `extensions/subagents/core/run-agent/runner.ts`.
- [test/framework/](test/framework/STRUCTURE.md): root fakes, `live/`, `eval-runs/`, `pi/`, `pi/live/`, `tests/`.
- [test/evals/](test/evals/README.md): `subagents/<subject>/` with `*-cases.ts` and `*.eval.ts`, shared helpers in `subagents/support/` and their tests in `subagents/tests/`; results go to the gitignored `test/evals/.results/`.
- `test/architecture.test.ts`: the structure rules Biome cannot express.
- `test/docs-sync.test.ts`: the rule that extension code changes come with doc changes.

## Config files

- `package.json`: version, `pi.extensions` (the 14 `extensions/<name>/index.ts` entries), the published `files`, and the scripts: `check` (typecheck, lint, knip, test), `test`, `test:live`, `evals`, `lint`, `format`, `typecheck`, `knip`.
- `tsconfig.json`: strict NodeNext, no emit, over every code folder.
- `vitest.config.ts`: three projects, picked with `--project`:
  - `unit` (`npm run test`): every `tests/` folder and `test/`, without `*.live.test.ts`.
  - `live` (`npm run test:live`): only live tests (`extensions/*/tests/live/`, `platform/pi-adapter/tests/live/`), serial, long timeouts.
  - `evals` (`npm run evals`): only evals (`test/evals/**/*.eval.ts`), one forked worker, serial, 30 minutes per test, results under `test/evals/.results/<timestamp>/`.
- `biome.json`: format and lint, the import-cycle and unused-code rules, and the per-folder `noRestrictedImports` overrides that hold each layer to its imports.
- `knip.json`: unused exports, types, files and dependencies; entries are the 14 extension `index.ts` files, the evals and the MCP fixture server.
- `.github/workflows/ci.yml`: Node 22, `npm run check` and the pack contents check; no credentials, no live tests, no evals.
- `.gitignore`: `node_modules`, `.DS_Store`, `.claude`, `test/evals/.results`.

## Published vs development-only

- Published (`files` in `package.json`): `platform/` (`pi-adapter/`, `extension-manager/`, `ui-kit/`, `shared/`), each extension's `index.ts`, `api/`, `core/`, `ui/`, `prompts/`, `README.md` and the subagents `agents/`, plus the root `README.md`, `LICENSE`, `ARCHITECTURE.md`, `STRUCTURE.md` and `AGENTS.md`; every `tests/` folder is excluded.
- Development-only: `test/` (with `test/framework/` and `test/evals/`), every `tests/`, `future-plans/`, `.github/` and the config files.
