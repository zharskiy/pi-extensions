# Architecture

Fourteen pi extensions in one package, on a small set of shared layers. This file holds the rules that span folders; how each folder works is in its own `ARCHITECTURE.md`, linked below. Where things are is in [STRUCTURE.md](STRUCTURE.md).

## Layers

```
pi-adapter ← shared ← ui-kit ← extension-manager ← extensions (core ← ui ← api ← index.ts) ← test/framework ← test/evals
```

An arrow points at what a layer may import. `extension-manager` sits after `ui-kit` in the chain but imports only `pi-adapter` and `shared`. Each folder reaches the folders to its left only through their `index.ts`, never through an inner file.

- `platform/pi-adapter/` imports nothing from the repo. Its `types/` imports only other `types/` files.
- `platform/shared/` imports only `platform/pi-adapter/index.ts`. What may enter it is narrow: no host, no theme painting (the admission rule in [platform/shared/STRUCTURE.md](platform/shared/STRUCTURE.md)).
- `platform/ui-kit/` imports `platform/pi-adapter/index.ts` and `platform/shared/index.ts`.
- `platform/extension-manager/` imports `platform/pi-adapter/index.ts` and `platform/shared/index.ts`, never `platform/ui-kit/`.
- Inside an extension, `core/` is logic: it imports its own `core/`, `platform/shared/` and `platform/pi-adapter/` and never its own `ui/`, `api/` or `index.ts`, `platform/ui-kit/`, `platform/extension-manager/` or another extension. `ui/` is rendering: it may add its own `core/` and `platform/ui-kit/`, and still never imports `api/`, `index.ts`, `platform/extension-manager/` or another extension. `api/` is the composition root: it may import its own `core/` and `ui/`, all four platform layers and another extension's `index.ts`. `index.ts` holds nothing but `export … from "./api/…"`.
- Extensions import each other only through `index.ts`, and only from `api/`. None does today: they talk over pi's shared event bus (`Host.publish`/`subscribe`; the channel names and payloads are in `platform/shared/channels/host-channels.ts`; among them `pi:handoff-pending` and `pi:held-results`), through formats in `platform/shared/` (the handoff document and its seed format, the handoff limit, the handoff prompt template in `platform/shared/handoff/handoff-prompt.md`, which has the model call the `handoff` tool and end its turn without a reply, filled from the audience each consumer owns, and the `handoff` tool), through a bus channel session-limits publishes its settings on (`session-limits:limits`) for the footer, which then labels its context figure `working context` since the base is the handoff point, through two shared status-key prefixes (`HINT_STATUS_PREFIX` for statuses the footer moves into its hint row, such as subagents' `hint:subagents`, and `MIRROR_STATUS_PREFIX` for statuses it hides because it draws their figures itself, such as spending's `mirror:spending`; each extension owns its key), and, for tool rows and message renderers, through the records the adapter keeps on `globalThis`, through which rows and renderers one extension registers reach the transcript panes another draws.
- An extension's `tests/` may import anything inside the extension, `test/framework/`, the four platform layers and another extension's `index.ts`.
- `test/framework/` imports the four platform layers' `index.ts` and never an extension or `test/evals/`. Its pi-free modules never import `test/framework/pi/`.
- `test/evals/` imports `test/framework/`, the four platform layers, `extensions/<name>/index.ts` and `extensions/<name>/tests/support/`. Nothing imports `test/evals/`.
- There are no import cycles anywhere.

## Repo rules

- Only `platform/pi-adapter/` (with its `tests/`) and `test/framework/pi/` import pi packages (`@earendil-works/*`, `typebox`). Everything else sees pi through `platform/pi-adapter/index.ts`.
- Shipped code never imports `test/` (`test/framework/`, `test/evals/`, `test/architecture.test.ts`, `test/docs-sync.test.ts`) or any `tests/` folder.
- No provider knowledge: no code or prompt names a model provider or a model id. Pi resolves providers, credentials and models; the harness passes `provider/id[:thinking]` strings through, and cost is pi's own usage figure. The only exception is configuration: the shipped agent files name their `model`. Unit-test fixtures use invented names.
- Folder shape: an extension folder holds only `index.ts`, `api/`, `core/`, `ui/`, `tests/`, `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md`, `prompts/` and `agents/`; source sits at most three folders below it, in `api/`, `core/` and `ui/` only. `*.test.ts` live only in `tests/` (or directly in `test/`), `*.eval.ts` only in `test/evals/`. Non-index, non-test files have unique basenames.
- No dead code: no unused exports, types, enum members, files or dependencies, and no unused locals, imports, parameters or private members. Class members outside the API are `private` or `#` by convention, since no tool checks them.
- User-facing failures become data, not exceptions: a failed agent is a closed record with its error, tool misuse returns an error result, bad settings or agent files become warnings and are skipped.

## Who enforces what

- Biome (`biome.json`, part of `npm run check`) enforces the import rules: one `noRestrictedImports` override per folder and per folder depth bans the pi packages outside the two allowed folders, inner files of another layer, the layers an extension's `core/` and `ui/` may not see, other extensions except their `index.ts`, and test code from shipped code. The `test/framework/**` override also keeps its pi-free modules from importing `test/framework/pi/`. It also rejects import cycles, `export *`, self-imports and unused locals, imports, parameters and private members.
- `test/architecture.test.ts` checks what an import pattern cannot express: the shape of each extension's `index.ts`, the folder shape and depth, where `*.test.ts` and `*.eval.ts` may live, unique basenames, that `package.json` `pi.extensions` lists exactly the 14 `extensions/<name>/index.ts` files, that in `subagents` no plugin (`api/plugins/<p>.ts`, `core/<p>/**`, `ui/<p>/**`) imports a sibling plugin, and that relative imports are written in normalised form with no `./../`, so the Biome path rules cannot be bypassed.
- `test/docs-sync.test.ts` checks that every extension whose code changed since the base commit also changed its `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md`. It checks only that they changed, not how. The base is the merge base of `HEAD` with `origin/main`, or `main` when there is no `origin/main`; `DOCS_SYNC_BASE` overrides it, and CI sets it to the pull request's base commit.
- knip (`knip.json`, part of `npm run check`) finds unused exports, types, enum members, files and dependencies, the entry exports of the 14 `index.ts` files included.
- `tsc` checks types only. CI runs `npm run check` and checks that `npm pack` ships the 14 entry files and no tests, fixtures, `test/framework/` or `test/evals/`.
- Provider names and the write locations below are kept by review.

## Files the extensions write

Everything lives under pi's agent dir or session dir (`~/.pi/agent` by default; the `sessionDir` setting or `--session-dir` moves session data), except:

- handoff documents, in the OS temp dir: `pi-handoff/<session id>/main-handoff.md` for the main session and `pi-handoff/<session id>/<agent id>-handoff.md` for agents;
- `worktree: true` agents: a checkout under `<cwd>/.pi/worktrees/`, git's `pi-agents/…` branch and `.git/worktrees/` metadata;
- two project files written on the user's command in a trusted project: `.pi/pi-subagents.json` (`/agents setup`, which offers only the user file in an untrusted project and whose write may follow a model tool call once the user confirms the form) and `.pi/mcp.json` (`/mcp-import … project apply`, or the interactive `/mcp-import` picker);
- `<cwd>/.pi/.gitignore` (`*`), written once by whichever of the writers above creates `<cwd>/.pi/`; every write under `<cwd>/.pi/` goes through `platform/shared` (`writeSettingsFile` for a project settings file, `ensureProjectSubdir` for a folder), which owns the `.pi` name and the `.gitignore`, so no extension can create `.pi/` without it, so a new `.pi/` stays out of git; an existing `.pi/` is never touched, and deleting the file tracks `.pi/`.

`/agents create` writes nothing itself: it briefs the main session, whose own write tool creates the agent file. Inside the agent and session dirs: settings files `<agentDir>/pi-<extension>.json` (and `<cwd>/.pi/pi-<extension>.json` in trusted projects), pi's own global `<agentDir>/settings.json` (model-default writes `defaultProvider` and `defaultModel` through pi's `SettingsManager` whenever the user picks a model in the main session, and adds the model to `enabledModels` when a scope exists and leaves it out, as pi's Ctrl+S does, and writes `defaultThinkingLevel` whenever the user picks a thinking level in the main session, never for the reset or clamp of a model switch, nor for the model and thinking level a handoff restores), custom session entries named `<namespace>:<kind>` (such as `pi-spending:usage`, `pi-adapter:kept-selection`, the model and thinking level a handoff carries into the new session and restores without moving pi's defaults, `pi-context:snapshot`, `pi-transcript:answer`, the rule drawn above the final answer of a settled turn and stored before it, `pi-session-limits:kept-rule` and `pi-session-limits:kept-message`, the rule and the user-message look a message typed during a handoff is shown with in the old session), and the agents dir of each session, described in the [subagents architecture](extensions/subagents/ARCHITECTURE.md). Registries, ledgers and limit phases live in memory and are lost on reload.

## Folders

- [pi-adapter](platform/pi-adapter/ARCHITECTURE.md): the only shipped code that imports pi; the host, the agent runtime and the UI bridge. Its `KeyPress.shortcut` is what every letter hotkey matches, so the hotkeys fire on the same physical key in a Cyrillic layout.
- [shared](platform/shared/ARCHITECTURE.md): pi-free, theme-free, host-free helpers and the cross-extension formats.
- [ui-kit](platform/ui-kit/ARCHITECTURE.md): theme-aware components: the row language, hints, lists, fixed-height scroll windows, forms and tabs, flat or grouped in labelled rows.
- [extension-manager](platform/extension-manager/ARCHITECTURE.md): `createManagedExtension`, plugins, the bus and settings.
- Extensions, each with its own architecture: [command-aliases](extensions/command-aliases/ARCHITECTURE.md), [composer](extensions/composer/ARCHITECTURE.md), [context](extensions/context/ARCHITECTURE.md), [footer](extensions/footer/ARCHITECTURE.md), [mcp-import](extensions/mcp-import/ARCHITECTURE.md), [model-default](extensions/model-default/ARCHITECTURE.md), [notifications](extensions/notifications/ARCHITECTURE.md), [questionnaire](extensions/questionnaire/ARCHITECTURE.md), [session-limits](extensions/session-limits/ARCHITECTURE.md), [spending](extensions/spending/ARCHITECTURE.md), [style](extensions/style/ARCHITECTURE.md), [subagents](extensions/subagents/ARCHITECTURE.md) (every `run_agent` batch runs in the background and wakes its caller once; an agent's handoff waits for its open batches and passes their results to its successor), [transcript](extensions/transcript/ARCHITECTURE.md), [working-indicator](extensions/working-indicator/ARCHITECTURE.md). `style` applies its `concise` prompt when no settings file names a style. `session-limits` lets the new session carry on by itself after every automatic handoff, whatever its Status, and keeps the messages the user sends while a handoff is in flight (through the adapter's `Host.onInput`, pi's `input` event) for the new session, as its user messages after the seed or in its editor, instead of answering them in the old one, composed only when the new session is ready.
- [test/framework](test/framework/ARCHITECTURE.md): fakes, harnesses, real-pi helpers, live and eval mechanics.
- [test/evals](test/evals/README.md): prompt-quality runs with real agents, local only.
- `test/architecture.test.ts`: the repo-wide structure test above.
- `test/docs-sync.test.ts`: the docs sync test above.
