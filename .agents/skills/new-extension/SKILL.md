---
name: new-extension
description: Add a new pi extension to this repository under extensions/<name>/, from the folder skeleton through registration, docs and a green `npm run check`. Use it whenever the user asks to add, create, scaffold or start an extension, wants a new slash command, tool, footer segment, widget, overlay, notification or prompt section that no existing extension owns, or describes a feature and it is not clear which extension it belongs to (deciding that is the first step here). Also use it when a user wants to split part of an existing extension out into its own, because the same registration and checks apply. The outcome is a branch with the new folder, every count and list in the repo updated, the five required docs written, and the checks passing.
---

# New extension

An extension here is one folder under `extensions/`, booted by `createManagedExtension`, that reaches pi only through the adapter and sits behind four kinds of checks: biome's import rules, `test/architecture.test.ts`, `test/docs-sync.test.ts` and knip. The repo is built so that a new extension needs no new config, no biome override and no vitest entry; the globs already cover `extensions/*/`. What it does need is to be shaped exactly like its siblings, to be listed where the siblings are listed, and to come with its docs in the same diff. Most of the friction is in those three things, so this skill is mostly about them.

Done means: the folder exists in the shape below, pi loads it, `npm run check` is green, the extension count and lists are updated in every place named in step 6, and the work sits on a branch off `main`.

## 1. Decide what it is before writing code

Three questions decide most of the shape, so answer them first and keep the answers for the docs.

- **Does it belong in an existing extension?** Read the extension list in the root `README.md` (Quick start) and the one-line pitches. A feature that extends what an existing extension already shows or owns (another footer line, another transcript row kind, another limit) goes there, because users get one settings file and one README per concern. A new extension is for a new concern.
- **Name.** The folder name is lowercase letters and hyphens only (`/^[a-z-]+$/`, enforced by the architecture test), one or two words that say what the user gets: `footer`, `session-limits`, `command-aliases`. The name fixes three more identifiers: the namespace `pi-<name>`, the settings file `pi-<name>.json` and custom session entries `pi-<name>:<kind>`.
- **Which host capabilities it needs.** The adapter's `Host` is the whole surface an extension has (`platform/pi-adapter/types/host-capabilities.ts` and `types/host-ui.ts`): commands and tools (`registerCommand`, `registerTool`), prompt sections, lifecycle (`onSessionStart`, `onIdle`, `onTurnEnd`, `onAgentStart`, `onPhase`, `onDialog`, `onSessionShutdown`), the bus (`publish`/`subscribe`), session entries (`appendEntry`/`readEntries`/`registerEntryRenderer`), session facts (`session()`, `model()`, `context()`, `sessionUsage()`), and under `host.ui`: notices, overlays and forms, widgets and the footer, editor hooks and keys. `SessionInfo` carries only `id`, `file`, `cwd`, `agentDir`, `projectTrusted`, `subscription` and `mode`; anything else about the session (when it started, what happened in it) the extension tracks itself from the lifecycle hooks or reads back from its own session entries. Pick from that list; if the feature needs something pi has and the adapter does not expose, the adapter grows first (its own `ARCHITECTURE.md` says how), never the extension importing pi.

Say which of these the feature uses, in one paragraph, before scaffolding. It becomes the opening of the extension's `ARCHITECTURE.md`.

## 2. Orient

Start from a clean tree on a branch off `main` named `feat/<name>`, unless the environment already put you on a working branch. Then read, in this order, because every rule below is visible in them:

- the layer rules in the root `ARCHITECTURE.md` (what `core/`, `ui/` and `api/` may import);
- `extensions/command-aliases/`, the smallest extension: its `index.ts`, `api/extension.ts`, `api/plugin.ts`, `core/aliases.ts`, the test, and its three docs. The snippets in step 3 are copied from it, so once you have read them you have read it; what the folder adds is the test and the docs;
- the sibling closest to the new feature: `notifications` for settings read through the manager, `style` for a command with a picker and `prompts/`, `footer` for a `ui/` folder that renders with a theme, `spending` for session entries and publishing on the bus, `context` for an entry renderer, `subagents` for tools and overlays;
- the export list of `platform/shared/index.ts` before writing any helper: durations, token counts, money, paths, plural nouns, settings parsing and the channel payloads are already there, and a second copy fails review.

Read the sibling you need rather than all of them; the point is to copy a living pattern, not to invent one.

## 3. Scaffold

The folder may contain only `index.ts`, `api/`, `core/`, `ui/`, `tests/`, `prompts/`, `agents/`, `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md`, with source at most three folders deep (`core/a/b/file.ts` is the limit). Leave out `core/` or `ui/` when there is nothing to put in them; `composer` has no `core/`, `command-aliases` no `ui/`.

```
extensions/<name>/
├── index.ts              # the pi entry, re-exports only
├── api/
│   ├── extension.ts      # createManagedExtension
│   └── plugin.ts         # <name>Plugin, and the wiring it enables
├── core/                 # logic: pure where possible, no ui, no manager, no other extension
├── ui/                   # rendering: theme-aware lines, forms, frames; may use ui-kit
├── tests/                # *.test.ts, flat; tests/live/ for *.live.test.ts; tests/support/ for helpers
├── README.md  ARCHITECTURE.md  STRUCTURE.md
```

`index.ts` is checked statement by statement: after block comments are stripped and the file is split on `;`, every statement must match `export … from "./api/…"`. So it is exactly this, with no line comment, no import and double quotes:

```ts
/** @public */
export { default } from "./api/extension.ts";
```

`api/extension.ts` is the composition root and the only place that names the manager:

```ts
import { resolve } from "node:path";
import { createManagedExtension } from "../../../platform/extension-manager/index.ts";
import { <name>Plugin } from "./plugin.ts";

export default createManagedExtension({
  namespace: "pi-<name>",
  root: resolve(import.meta.dirname, ".."),
  plugins: [<name>Plugin],
});
```

`api/plugin.ts` holds the `Plugin` the manager enables and the wiring function it calls:

```ts
import type { Host } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";

const create<Name> = (host: Host) => {
  host.registerCommand("<cmd>", { description: "…", run: async (args) => { /* … */ } });

  host.onSessionStart((info) => {
    // anything that needs info.cwd, info.mode or info.agentDir, or sets a widget or footer
  });
};

export const <name>Plugin: Plugin<never, never, undefined> = {
  id: "<name>",
  enable({ host }) {
    create<Name>(host);

    return undefined;
  },
};
```

Export `create<Name>` only when a test imports it to wire a fake host without booting (as `command-aliases` does); when the tests boot the extension instead (step 5), keep it unexported, because knip fails `npm run check` on any export nothing imports. Siblings register commands either at enable time (`style`, `context`) or inside `onSessionStart` (`command-aliases`); both work, what matters is that code needing the session's `info` waits for `onSessionStart`, and that `enable` itself stays synchronous and cheap. `enable` may return a function to undo its wiring; the manager runs those on shutdown. It also receives `paths.root`, which is how `prompts/` files are found (`readFileSync(join(paths.root, "prompts", "x.md"))`, as `session-limits` and `style` do). The generics are `Plugin<Events, Services, Settings>`; `never, never, undefined` is right until the extension has settings.

Rules that bite while writing the code, all enforced by `npm run check`:

- Imports carry the `.ts` extension and use `import type` for types (`verbatimModuleSyntax`); no enums or namespaces (`erasableSyntaxOnly`); relative paths are normalised (`../x`, never `./../x`).
- `core/` imports its own `core/`, `platform/shared/` and `platform/pi-adapter/` only. `ui/` adds `platform/ui-kit/`. `api/` sees everything, including another extension's `index.ts`, though none does today: extensions talk over the bus (channel names and payload parsers live in `platform/shared/channels/host-channels.ts`; add a channel there, with a parser, when the new extension publishes something others may want) or through session entries.
- Every export is used somewhere, including by tests, or knip fails; `index.ts` exports are checked too. Write the export when the consumer exists, not before.
- No provider or model names anywhere, in code, prompts or docs.
- Failures become data: a bad setting is a warning and a default, a tool misuse is an error result, an exception never reaches the user.
- Code that only makes sense in the terminal checks `host.session().mode === "tui"` (see `working-indicator`), because extensions also load in print and child sessions where there is no screen.

`npm run format` applies biome's formatting (two spaces, 110 columns), so run it before reading lint output.

## 4. Settings, if the extension has any

Put the type, the file name, the defaults and the schema in `core/settings.ts`, exactly as `extensions/notifications/core/settings.ts` does: `SETTINGS_FILE = "pi-<name>.json"`, a `defaults` object and a `SettingsSchema<T>` with `number`, `choice`, `list` or `object` rules. Then pass `settings: { defaults: () => defaults, schema, file: SETTINGS_FILE }` to `createManagedExtension` (`defaults` receives the extension's `ExtensionPaths`, useful when a default depends on `agentDir`) and type the plugin `Plugin<never, never, <Name>Settings>`; `enable({ host, settings })` receives one object that the manager fills at each session start from defaults, then `<agentDir>/pi-<name>.json`, then `<cwd>/.pi/pi-<name>.json` when the project is trusted, with invalid keys dropped and warned once. Read `settings.x` at use time, not at enable time, because the object is patched in place.

Only when the user and project values must be told apart (as `style` needs, to warn that the project file wins) read them yourself with `readSettingsFiles` and `reportSettingsErrors`. Document every key, its default and its effect in the extension's `ARCHITECTURE.md`; the README does not list settings.

## 5. Tests

A new extension ships with unit tests in `tests/<name>.test.ts` (one file per unit as it grows: `render.test.ts` beside `ui/render.ts`). `test/framework/index.ts` has what they need, in two styles; pick one per test file and let the `create<Name>` export follow (step 3):

- **Wire a fake host directly**: `createFakeHost({ mode?, cwd?, agentDir? })`, then `create<Name>(host)`, then `host.start()` to fire session start, then assert on what the host recorded: `commands`, `notices`, `footer`, `published`, `editorSubmissions`, `completionMaps`, and drive it with `host.runCommand("x", args)` and `host.emit(channel, data)`. Read `test/framework/fake-host.ts` for the field a test needs rather than guessing. `extensions/command-aliases/tests/command-aliases.test.ts` is this style.
- **Boot the real extension**: `startExtension({ extension, runtime: createFakeAgentRuntime(), host })` runs `api/extension.ts` through the manager, which is the test that proves the wiring and the settings (`extensions/footer/tests/footer.test.ts`). For settings files, `useTempDirs()`, write `join(agentDir, SETTINGS_FILE)`, then boot with `extension.boot(host, createFakeAgentRuntime(), { root: extension.options.root, agentDir })` and `host.start()` (`extensions/notifications/tests/notifications.test.ts`).

`plainTheme`, `plainText` and `visibleWidth` are for anything rendered. Anything that reads the clock uses vitest's `vi.useFakeTimers()`, `vi.setSystemTime` and `vi.advanceTimersByTime` (again `notifications`); `flushTimers` and `waitUntil` are for promises and microtasks, not for wall-clock logic.

Test behaviour the user sees (the lines, the notice text, the command's effect), not the shape of internal calls, so that refactors keep the tests. A live test (`tests/live/<x>.live.test.ts`, wrapped in `describeLive` from `test/framework/pi/live/index.ts`) is for behaviour that only a real pi run shows; small extensions do not need one.

## 6. Register it everywhere the siblings are listed

Nothing here is discovered automatically. Each item is a check or a doc that names the fourteen current extensions, so each one must change; the count moves from 14 to 15 (then onward):

| Where | What |
|---|---|
| `package.json` | add `./extensions/<name>/index.ts` to `pi.extensions`; add `<name>` to `keywords`; add one clause for the new extension to the single-sentence `description`, before its last clause, keeping it one sentence |
| `test/architecture.test.ts` | `expect(entries).toHaveLength(14)` becomes the new count |
| `.github/workflows/ci.yml` | the pack check `= 14` becomes the new count |
| root `README.md` | the count word in the header line and in "The package installs … extensions:"; a bullet in the right Quick start group (Agents and tools, Session awareness, Look and feel), in the form `- **[<name>](extensions/<name>/README.md)**: <lowercase one-line pitch>.`, paraphrasing the extension's own pitch; a try row only if the new command is one of the three or four things a first-time user should try, since that table is a showcase, not a list |
| root `ARCHITECTURE.md` | the count word in the first line and the `14` in the "Who enforces what" bullets; a link in the alphabetical "Extensions, each with its own architecture" list |
| root `STRUCTURE.md` | the `14` in the tree line and in the `package.json` and `knip.json` bullets; a link in the alphabetical extensions list under Folders |
| `platform/extension-manager/ARCHITECTURE.md` | the count word of the extensions that pass one plugin (all but subagents) |

Then `grep -rn "14\|[Ff]ourteen\|[Tt]hirteen" README.md ARCHITECTURE.md STRUCTURE.md platform/extension-manager/ARCHITECTURE.md test/architecture.test.ts .github/workflows/ci.yml` to confirm nothing was missed, because the architecture test and CI fail on the count and the docs silently go stale.

Nothing else needs an edit: `knip.json`, `biome.json`, `vitest.config.ts`, `tsconfig.json` and the `files` list in `package.json` are glob-based. The one exception is an `agents/` folder: `files` names `extensions/subagents/agents` explicitly, so a second extension that ships agent files adds its own line there.

## 7. The three docs

`test/docs-sync.test.ts` fails `npm run check` until the new extension's `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md` all appear in the diff against the merge base with `main`; untracked files count, so the rule is meaningful before the first commit, and the registration step already covers the root pair. Write the three in the extension's folder:

- **README.md**: use the `readme` skill (`.agents/skills/readme/SKILL.md`); it fixes the six-part shape and the root README's list.
- **ARCHITECTURE.md**: `# <name> architecture`. It opens with the boot chain, as a bullet or a short paragraph (siblings do both): `index.ts` re-exports the default of `api/extension.ts`, which calls `createManagedExtension` with the namespace `pi-<name>` and which plugins, whether there are settings, bus channels or services, and what `enable` returns to undo. The rest says how it works: which `Host` and `HostUi` calls, in what order, what is kept in memory, what is written where, every settings key with its default, mode caveats, and what happens on each failure. Cite files in backticks. `extensions/command-aliases/ARCHITECTURE.md` is the small form, `extensions/style/ARCHITECTURE.md` the density expected once there are settings and a command.
- **STRUCTURE.md**: `# <name> structure`, then either a fenced tree rooted at `extensions/<name>/` with a `#` comment per file naming its exports (`command-aliases`, `style`) or a bullet per file (`footer`); every test file listed with its purpose; a closing sentence for any missing layer ("There is no `ui/`: …").

## 8. Verify and hand over

`npm run check` must pass; it is what CI runs and it covers typecheck, biome, knip, the architecture and docs-sync tests and the unit tests. It does not run CI's pack check, so confirm that one by hand, and then load the extension once in the real binary, because unit tests boot on a fake host:

```sh
npm pack --dry-run 2>&1 | grep -c 'extensions/[a-z-]*/index.ts'   # must print the new count
pi -e ./extensions/<name>/index.ts
```

Try the feature, watch for a load error or a warning, and quit. If pi is configured to load this repo as a package (`packages` in `~/.pi/agent/settings.json`), plain `pi` loads the new extension too, so a broken one shows up in the user's daily session; that is another reason to try it before committing.

Commit on the branch in the repo's convention, `feat(<name>): <what the user gets>`, with the scaffold, tests, registration and docs in one commit so that the docs-sync rule holds at every commit on the branch. Do not push or open a pull request unless asked.

Close with a report in this shape:

```
extensions/<name>: <one-line pitch>
Host surface: <commands, hooks, ui calls used>
Settings: pi-<name>.json (<keys>) | none
Talks to others: <channels published/subscribed, entries> | none
Registered: package.json, architecture test (14), ci.yml (14), README, ARCHITECTURE.md, STRUCTURE.md
Docs: extensions/<name>/{README,ARCHITECTURE,STRUCTURE}.md
Checks: check ✓, pack count ✓, pi -e ✓ | skipped (<why>)
Branch: <name>, <n> commit
```
