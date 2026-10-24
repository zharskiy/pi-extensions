# Architecture

Thirteen pi extensions in one package, on a small set of shared layers. This file holds the rules that span folders; how each folder works is in its own `ARCHITECTURE.md`, linked below. Where things are is in [STRUCTURE.md](STRUCTURE.md).

## Layers

```
pi-adapter ← shared ← ui-kit ← extension-manager ← extensions (core ← ui ← api ← index.ts) ← test-framework ← evals
```

An arrow points at what a layer may import. Each folder reaches the folders to its left only through their `index.ts`, never through an inner file.

- `pi-adapter/` imports nothing from the repo. Its `types/` imports only other `types/` files.
- `shared/` imports only `pi-adapter/index.ts`. What may enter it is narrow: no host, no theme painting (the admission rule in [shared/STRUCTURE.md](shared/STRUCTURE.md)).
- `ui-kit/` imports `pi-adapter/index.ts` and `shared/index.ts`.
- `extension-manager/` imports `pi-adapter/index.ts` and `shared/index.ts`, never `ui-kit/`.
- Inside an extension, `core/` is logic: it imports its own `core/`, `shared/` and `pi-adapter/` and never its own `ui/`, `api/` or `index.ts`, `ui-kit/`, `extension-manager/` or another extension. `ui/` is rendering: it may add its own `core/` and `ui-kit/`, and still never imports `api/`, `index.ts`, `extension-manager/` or another extension. `api/` is the composition root: it may import its own `core/` and `ui/`, all four root layers and another extension's `index.ts`. `index.ts` holds nothing but `export … from "./api/…"`.
- Extensions import each other only through `index.ts`, and only from `api/`. None does today: they talk over pi's shared event bus (`Host.publish`/`subscribe`; the channel names and payloads are in `shared/host-channels.ts`), through formats in `shared/` (the handoff document), and, for tool rows, through the tool-rows record the adapter keeps on `globalThis`, through which rows one extension registers reach the transcript panes another draws.
- An extension's `tests/` may import anything inside the extension, `test-framework/`, the four root layers and another extension's `index.ts`.
- `test-framework/` imports the four root layers' `index.ts` and never an extension or `evals/`. Its pi-free modules never import `test-framework/pi/`.
- `evals/` imports `test-framework/`, the four root layers, `extensions/<name>/index.ts` and `extensions/<name>/tests/support/`. Nothing imports `evals/`.
- There are no import cycles anywhere.

## Repo rules

- Only `pi-adapter/` (with its `tests/`) and `test-framework/pi/` import pi packages (`@earendil-works/*`, `typebox`). Everything else sees pi through `pi-adapter/index.ts`.
- Shipped code never imports `test-framework/`, `evals/`, `test/` or any `tests/` folder.
- No provider knowledge: no code or prompt names a model provider or a model id. Pi resolves providers, credentials and models; the harness passes `provider/id[:thinking]` strings through, and cost is pi's own usage figure. The only exceptions are configuration: the shipped agent files name their `model`, and the subagents README lists those models. Unit-test fixtures use invented names.
- Folder shape: an extension folder holds only `index.ts`, `api/`, `core/`, `ui/`, `tests/`, `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `prompts/` and `agents/`; source sits at most three folders below it, in `api/`, `core/` and `ui/` only. `*.test.ts` live only in `tests/` (or `test/`), `*.eval.ts` only in `evals/`. Non-index, non-test files have unique basenames.
- No dead code: no unused exports, types, enum members, files or dependencies, and no unused locals, imports, parameters or private members. Class members outside the API are `private` or `#` by convention, since no tool checks them.
- User-facing failures become data, not exceptions: a failed agent is a closed record with its error, tool misuse returns an error result, bad settings or agent files become warnings and are skipped.

## Who enforces what

- Biome (`biome.json`, part of `npm run check`) enforces the import rules: one `noRestrictedImports` override per folder and per folder depth bans the pi packages outside the two allowed folders, inner files of another layer, the layers an extension's `core/` and `ui/` may not see, other extensions except their `index.ts`, and test code from shipped code. It also rejects import cycles, `export *`, self-imports and unused locals, imports, parameters and private members.
- `test/architecture.test.ts` checks what an import pattern cannot express: the shape of each extension's `index.ts`, the folder shape and depth, where `*.test.ts` and `*.eval.ts` may live, unique basenames, that `package.json` `pi.extensions` lists exactly the 13 `extensions/<name>/index.ts` files, and that the pi-free `test-framework/` modules never import `test-framework/pi/`.
- knip (`knip.json`, part of `npm run check`) finds unused exports, types, enum members, files and dependencies, the entry exports of the 13 `index.ts` files included.
- `tsc` checks types only. CI runs `npm run check` and checks that `npm pack` ships the 13 entry files and no tests, fixtures, `test-framework/` or `evals/`.
- Provider names and the write locations below are kept by review.

## Files the extensions write

Everything lives under pi's agent dir or session dir (`~/.pi/agent` by default; the `sessionDir` setting or `--session-dir` moves session data), except:

- handoff documents, in the OS temp dir: `pi-session-limits/<session id>-handoff.md` for the main session and `pi-subagents/<session id>/<agent id>-handoff.md` for agents;
- `worktree: true` agents: a checkout under `<cwd>/.pi/worktrees/`, git's `pi-agents/…` branch and `.git/worktrees/` metadata;
- two project files written on the user's command in a trusted project: `.pi/pi-subagents.json` (`/agents setup`) and `.pi/mcp.json` (`/mcp-import … project apply`, or the interactive `/mcp-import` picker).

`/agents create` writes nothing itself: it briefs the main session, whose own write tool creates the agent file. Inside the agent and session dirs: settings files `<agentDir>/pi-<extension>.json` (and `<cwd>/.pi/pi-<extension>.json` in trusted projects), custom session entries named `<namespace>:<kind>` (such as `pi-spending:usage`, `pi-context:snapshot`), and the agents dir of each session, described in the [subagents architecture](extensions/subagents/ARCHITECTURE.md). Registries, ledgers and limit phases live in memory and are lost on reload.

## Folders

- [pi-adapter](pi-adapter/ARCHITECTURE.md): the only shipped code that imports pi; the host, the agent runtime and the UI bridge.
- [shared](shared/ARCHITECTURE.md): pi-free, theme-free, host-free helpers and the cross-extension formats.
- [ui-kit](ui-kit/ARCHITECTURE.md): theme-aware components: the row language, hints, lists, forms and tabs.
- [extension-manager](extension-manager/ARCHITECTURE.md): `createManagedExtension`, plugins, the bus and settings.
- Extensions, each with its own architecture: [command-aliases](extensions/command-aliases/ARCHITECTURE.md), [composer](extensions/composer/ARCHITECTURE.md), [context](extensions/context/ARCHITECTURE.md), [footer](extensions/footer/ARCHITECTURE.md), [mcp-import](extensions/mcp-import/ARCHITECTURE.md), [notifications](extensions/notifications/ARCHITECTURE.md), [questionnaire](extensions/questionnaire/ARCHITECTURE.md), [session-limits](extensions/session-limits/ARCHITECTURE.md), [spending](extensions/spending/ARCHITECTURE.md), [style](extensions/style/ARCHITECTURE.md), [subagents](extensions/subagents/ARCHITECTURE.md), [transcript](extensions/transcript/ARCHITECTURE.md), [working-indicator](extensions/working-indicator/ARCHITECTURE.md).
- [test-framework](test-framework/ARCHITECTURE.md): fakes, harnesses, real-pi helpers, live and eval mechanics.
- [evals](evals/README.md): prompt-quality runs with real agents, local only.
- `test/architecture.test.ts`: the repo-wide structure test above.
