# Footprint declarations

> Status: planned, not part of PR #43. Date: 2026-11-21. Checked at commit `2d587a19`; revised the same day at `51f54c22` for the owner's rule on `platform/shared` (section 3.1). A design note: it records an idea, what the code says about it, and a sized plan. The direction is decided by the owner; the design is not. Findings come from reading code; nobody ran pi to confirm them. Line numbers are from `2d587a19`; prune and `platform/shared` did not change in the merge to `51f54c22` (only `AGENTS.md` did).

## 1. The idea, in the owner's words

> I still see agent-run, handoff-scan in the prune/core folder. Was it left deliberately? Can't we organise extensions so that each of them would declare what it's being writing into host's system and then extension manager would check all of that, so that prune will do removal itself. Basically the idea is to decouple responsibilities.

Short answer: yes, it was left on purpose. This PR moved the facts about agent runs into `platform/shared/agent-runs/agent-runs.ts` (folder names, the manifest file, the links and the keep rule). What stayed in prune is how prune finds, measures and removes those folders. That code still has the shape of the two things it cleans, so the owner's point stands: prune has one module per writer. This note says what a "footprint" model would take. Since then the owner has ruled that `platform/shared` holds only what is purely shareable (3.1), so the layout that PR #43 put there also has to move back to subagents.

A footprint here means: the files and folders one writer leaves on the host, how each is tied to a session, how old it is, when it must be kept, and how to remove it.

## 2. What the code says

### 2.1 What prune still knows about agent runs and handoff folders

Everything below is in `extensions/prune/core/agent-runs.ts` or `core/handoff-scan.ts`. The names and rules that come from `platform/shared` are marked "shared".

| # | Specific knowledge | Where | Generic or specific |
|---|---|---|---|
| 1 | A session's runs are the subfolders of `runsDir(stem)`, one folder per run. `runsDir` is shared (`platform/shared/agent-runs/agent-runs.ts:16`); "each subfolder is one run" is not. | `agent-runs.ts:69` | specific |
| 2 | A run is read through its manifest (`RUN_MANIFEST`, shared), and the links and keep flag come from `runRules` (shared). A manifest that cannot be read or parsed keeps the run, with an age of infinity. | `agent-runs.ts:22-48` | the rules are shared; "unreadable keeps" is prune's safety policy |
| 3 | A run's id is its folder name, and the links point at ids of runs in the same `agents/` folder. A run expires only when every run reachable through its links is old and none is kept. | `agent-runs.ts:44`, `:50-66`, `:95-101` | specific; that links are folder names in one folder is not written down in `platform/shared` |
| 4 | Runs of sessions without a file live under `fallbackStemsRoot(agentDir)/<session id>/` (root shared). Prune reads the folder name back as a session id and skips the ids it keeps. | `agent-runs.ts:79-81`, `:91`; `sweep-plan.ts:59` | the inverse of the shared `sessionRunsDir` (`platform/shared/agent-runs/agent-runs.ts:20-21`) |
| 5 | A stem folder beside the session files with no `.jsonl` of its name, and not live, is an orphan; its runs are judged as orphans. | `agent-runs.ts:82-84`; listed in `sweep-scan.ts:44-46` | pi's session layout plus the shared stem rule |
| 6 | `SESSION_EXT = ".jsonl"` is spelled again, beside the shared `sessionStem`, which uses its own regular expression. | `agent-runs.ts:16`; `platform/shared/agent-runs/agent-runs.ts:14` | pi's format, spelled twice |
| 7 | Removal order: the run folder (recursive `rm`), then its parent `agents/` and then the stem folder, each with a non-recursive `rmdir` that fails harmlessly when not empty. | `agent-runs.ts:105-117` | specific: it assumes exactly two levels between a run and the folder its session owns |
| 8 | A handoff folder's name is a session id. It is the folder of a removable session when its name is in `measured`, never an orphan when its name is in `claimed` (a session with a file, or a live id), and an orphan otherwise once old. | `handoff-scan.ts:28-51`; the sets are built in `sweep-scan.ts:84-94` | the inverse of the shared `handoffPath` (`platform/shared/handoff/handoff-document.ts:60-61`) |
| 9 | Fresh-folder shortcut: a folder whose own mtime is at or after the latest cutoff is not read at all. This is exact because the age is the newest of the folder's own mtime and its entries'. | `handoff-scan.ts:44-46`; `real-dirs.ts:32` | generic for any folder whose age is "newest entry" |
| 10 | Empty folders: every folder whose own mtime is older than a day and whose name is not a live id is listed, and a non-recursive `rmdir` decides whether it was empty. The scan does not count entries. This runs only on the automatic sweep, not from `/prune`. | `handoff-scan.ts:36`; `sweep-apply.ts:75-79`; `prune.ts:30` | specific to folders a writer creates ahead of its file |
| 11 | Root safety: the handoff root is used only when it is a real folder the user owns that group and others cannot write to; otherwise it is named in `skipped`. | `handoff-scan.ts:16-26`; `sweep-scan.ts:83`, `:109` | generic for a root in a shared place (the OS temp dir) |
| 12 | The root is read once with `opendir` and streamed through the bounded pool (64 at a time). | `handoff-scan.ts:53-60`; `pool.ts:1`, `:8` | generic |
| 13 | Age and size: newest mtime and file bytes one level deep, through `lstat`, so a symbolic link is never followed. Used for both runs and handoff folders. | `real-dirs.ts:26-35` | generic; already shared by both scans |

Correction to the brief: the brief said the handoff scan "finds empties". It does not; it lists every folder older than a day and lets `rmdir` fail on the ones that are not empty (#10).

Already generic and footprint-free: `core/pool.ts`, `core/real-dirs.ts`, `core/path-key.ts`, `core/session-chains.ts`, `core/live-markers.ts`.

### 2.2 Where the rest of prune names runs and handoffs

This is the cost of going generic beyond the two modules.

| File | What names runs or handoffs |
|---|---|
| `core/sweep-scan.ts` | `Sources.handoffRoot` (`:14`); the handoff scan with `measured`, `claimed`, `live` (`:83-95`); `scanRuns` with `files`, `stems`, `live`, `kept` (`:97-102`); the result fields (`:104-113`) |
| `core/sweep-plan.ts` | `Scan.runs`, `orphanRuns`, `fallbackRuns`, `owned`, `orphanHandoffs`, `empties` (`:8-19`); `Candidate.runs`, `Candidate.handoff` (`:26-27`); `Plan.orphans.runs`, `.handoffs` (`:32`); `Removed.runs`, `.handoffs` (`:37`); `plan`, `contents`, `totals`, `within` (`:53-132`) |
| `core/sweep-apply.ts` | `NOTHING` and `added` count runs and handoffs (`:10`, `:18-23`); `removeRuns`, `removeHandoff` (`:25-33`); a member's runs, then its handoff folder, after its session file (`:66-67`); `apply` (`:81-89`) |
| `ui/prune-report.ts` | the nouns `agent run` and `handoff dir` (`:32-39`), `Handoff dirs are skipped…` (`:72`), `empty handoff dir` (`:79`) |
| `ui/prune-picker.ts` | nothing: it uses only `Removed` and `itemsOf` (`:5`, `:15`, `:51`) |
| `api/extension.ts`, `api/plugin.ts` | the handoff root is injected as a dependency (`extension.ts:4`, `:18`; `plugin.ts:12`, `:22`) |

### 2.3 How the extension manager runs

Confirmed: there is no single manager that sees all extensions.

- Each extension is its own entry in `package.json` `pi.extensions` (`package.json:48-65`). Pi loads them one after another and awaits each (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:584-592`).
- Each entry is a `createManagedExtension` factory. Every call of the factory runs `boot` (`platform/pi-adapter/runtime/extension.ts:71`), and every boot builds its own manager (`platform/extension-manager/managed-extension.ts:102-111`) with its own bus and service registry (`platform/extension-manager/extension-manager.ts:75-76`). Pi builds a new extension per session (`platform/extension-manager/ARCHITECTURE.md:29`), so there is even a new manager per session.
- Inside an agent's child session the factory returns before booting (`platform/pi-adapter/runtime/extension.ts:42-44`), so child sessions register nothing.
- Cross-extension paths in one process: pi's shared event bus through `Host.publish`/`subscribe` (`platform/pi-adapter/runtime/host.ts:651-658`, channels in `platform/shared/channels/host-channels.ts`), and records on `globalThis` through `globalRecord` (`platform/pi-adapter/runtime/global-record.ts:1-8`). The root `ARCHITECTURE.md:18` names both.
- `Host.publish` drops the message when there is no live session context yet (`host.ts:652-654`). A footprint "registration" sent on the bus while the extension loads would be lost. A `globalRecord` write at load time is not lost.

Load order: plugins enable inside `boot`, at factory time (`managed-extension.ts:94-111`, `extension-manager.ts:82-109`), and prune's sweep runs in a session-start handler (`extensions/prune/api/plugin.ts:39-62`). Pi runs all factories before it emits `session_start` (it awaits each load, `loader.js:584-592`; the start event is set up in `dist/core/agent-session.js:230`; the exact emit point was not traced). So a registration made while enabling would be in place before prune sweeps, in the same process, whatever the order of `pi.extensions`. Prune is last in that list anyway (`package.json:64`). Not guaranteed: other pi processes, a pi that does not load this package, and extensions turned off.

### 2.4 Layering rules that decide where declarations can live

- `platform/*` may never import `extensions/*`: Biome bans `**/extensions/**` in `platform/pi-adapter` (`biome.json:63`), `platform/shared` (`:187`), `platform/ui-kit` (`:259`) and `platform/extension-manager` (`:331`). So the manager cannot collect declarations from extension folders.
- An extension's `core/` and `ui/` may not import another extension (`biome.json:567-569` for `core/*.ts`) or the extension manager (`:559-561`). Only `api/` may import another extension's `index.ts` (`ARCHITECTURE.md:17-18`, `biome.json:447`). No extension does today: a grep of shipped extension code for an import of another extension's `index.ts` finds none.
- `test/architecture.test.ts:273-279` fails on any `platform/<x>` folder that is not one of the four layers (`:11`). A `platform/footprints/` folder would be a new layer; `platform/shared/footprint/` would not.
- Each extension's `index.ts` may hold only re-exports from `./api/` (`test/architecture.test.ts:450`), and `package.json` `pi.extensions` must list exactly the fifteen `./extensions/<name>/index.ts` files (`:442-447`).
- What may enter `platform/shared`: node built-ins, other shared files and adapter types only, no `Host` (`platform/shared/ARCHITECTURE.md:7-11`). Under the owner's rule (3.1) it must also be purely shareable: a generic contract fits, one writer's layout does not. Prune's sweep engine needs `readSessionHeader` from the adapter's runtime (`core/sweep-scan.ts:3`), which shared may not import, and it would have one user. A `platform/` helper that exists for one extension is a reverse leak (kind E, README section 2). So the engine stays in prune.

### 2.5 What the extensions write, from the docs

Taken only from `AGENTS.md:18` and the extensions' `README.md` and `ARCHITECTURE.md`. **Not checked in code.** Settings files that only the user writes are left out.

| Writer | Path pattern | Keyed by | Who should ever delete it | Source |
|---|---|---|---|---|
| subagents | `<session stem>/agents/<agent id>/` (manifest, child session) | session file | prune, once the session file is gone; never while the run holds a worktree | `AGENTS.md:18`; `extensions/subagents/ARCHITECTURE.md:42`, `:75`; `extensions/prune/README.md:17` |
| subagents | `<agentDir>/pi-subagents/<session id>/agents/<agent id>/` | session id (no session file) | prune (orphans) | `AGENTS.md:18` |
| subagents | `<cwd>/.pi/worktrees/<id>-<stamp>/`, branch `pi-agents/<id>-<stamp>`, git's `.git/worktrees` | cwd | subagents only, when the agent closes; prune never | `AGENTS.md:18`; `extensions/subagents/ARCHITECTURE.md:99` |
| subagents, session-limits, mcp-import (through `ensureProjectSubdir`, `writeSettingsFile`) | `<cwd>/.pi/.gitignore`, `<cwd>/.pi/worktrees/.gitignore` | cwd | nobody | `AGENTS.md:18`; `extensions/subagents/ARCHITECTURE.md:99`; `extensions/mcp-import/ARCHITECTURE.md:7` |
| subagents | `<agentDir>/pi-subagents.json`, `<cwd>/.pi/pi-subagents.json` (`/agents setup`) | nothing | the user | `AGENTS.md:18`; `extensions/subagents/ARCHITECTURE.md:91` |
| subagents (through the main session's write tool) | `<agentDir>/agents/<name>.md`, `<cwd>/.pi/agents/<name>.md` (`/agents create`) | nothing | the user | `AGENTS.md:18`; `extensions/subagents/ARCHITECTURE.md:95` |
| subagents | `pi-subagents:prompt-record` entries in the child session file | session file | with the file | `extensions/subagents/ARCHITECTURE.md:46` |
| session-limits | `<OS temp>/pi-handoff/<session id>/main-handoff.md` | session id | prune, once the session file is gone, or by age | `AGENTS.md:18`; `extensions/session-limits/ARCHITECTURE.md:13`, `:21` |
| subagents | `<OS temp>/pi-handoff/<session id>/<agent id>-handoff.md` | session id | same | `AGENTS.md:18`; `extensions/subagents/ARCHITECTURE.md:71-72` |
| prune | `<agentDir>/pi-prune/live/<session id>.<pid>.json` | session id and process | prune (its own; dead markers) | `AGENTS.md:18`; `extensions/prune/ARCHITECTURE.md:18`, `:27` |
| prune | `<agentDir>/pi-prune.json` (`/prune`, Auto-prune) | nothing | the user | `AGENTS.md:18`; `extensions/prune/ARCHITECTURE.md:17` |
| spending | `pi-spending:usage` entries in the main session file | session file | with the file | `extensions/spending/ARCHITECTURE.md:8` |
| style | `<agentDir>/pi-style.json` | nothing | the user | `extensions/style/ARCHITECTURE.md:7` |
| model-default | `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, maybe `enabledModels` in `<agentDir>/settings.json`, through pi | nothing | the user | `extensions/model-default/ARCHITECTURE.md:5`, `:7` |
| mcp-import | `<agentDir>/mcp.json`, `<cwd>/.pi/mcp.json` | nothing | the user | `AGENTS.md:18`; `extensions/mcp-import/ARCHITECTURE.md:7` |
| command-aliases, composer | nothing | | | `extensions/command-aliases/README.md:47`; `extensions/composer/README.md:48` |
| context, footer, notifications, questionnaire, transcript, working-indicator | no file named in their docs | | | their `README.md` and `ARCHITECTURE.md`, grepped for paths |

What this shows: about fifteen kinds of writes, but only **two footprints that a cleaner acts on**, agent runs (in two homes) and handoff folders. Session entries go with their file. Worktrees and branches are never prune's. Settings and agent files are the user's. Prune's own markers are its own.

## 3. Options

### 3.1 The rule that now applies

The owner's words, given after the first version of this note: "platform/shared must be having something purely shareable, not something specific to an extensions, reflect that in the plan. so we'll be refactoring the whole list of extensions".

How this note reads it (interpretation, not the owner's words): `platform/` holds only generic code. It names no extension and encodes no layout, format or rule that one extension owns. Under that reading, option B of the first version (declarations in `platform/shared`, a list in `platform/shared/footprints/`) breaks the rule, and so does `platform/shared/agent-runs/agent-runs.ts` itself: subagents writes that layout, prune only reads it, and `:18` spells subagents' namespace. [platform-audit.md](platform-audit.md) rates it ONE EXTENSION'S. It stays in PR #43 as an interim step and moves back to subagents in step 1 of 4.5.

### 3.2 Who acts on the files

| | Disabled writer's old data | Orphans (no session) | Other pi processes | Prune's code per footprint |
|---|---|---|---|---|
| **A. Runtime registration** (each writer registers through a `globalRecord` at enable time; the bus would drop it, 2.3) | **never cleaned**: nothing registers | only for registered writers | only what the sweeping process loaded | none |
| **B. Static declarations, one generic engine in prune** | cleaned | cleaned | cleaned (on disk) | none |
| **C. Each writer cleans its own**, told on the bus that a session file is gone | **never cleaned** | nobody owns them | the message does not leave the process | none |

- **A** turns "is the writer enabled in this process" into "is its data cleaned". It repeats on every session, since pi builds a new extension per session (2.3).
- **C** loses the two checks that make removal safe: one liveness and mtime check per chain before the first unlink (`extensions/prune/core/sweep-apply.ts:41-55`), and "a member's runs and handoff folder go only after its own session file is gone" (`:60-67`). The `/prune` picker could no longer show counts and bytes before removal.
- **B** is the only one without a new gap. The rest of this section is about where B's declarations live.

### 3.3 Where a declaration may live under the rule

| | Declaration | Contract types | How it reaches prune | Rule changes needed | Who names the writer |
|---|---|---|---|---|---|
| **(i) Owner's folder, through its `index.ts`** | in the owner's `api/`, re-exported by its `index.ts` | wherever the owner chooses; prune must agree | prune's `api/` imports the owner's `index.ts` | none: `biome.json:447` lets depth-one files import another extension's `index.ts`, `test/architecture.test.ts:450` lets `index.ts` re-export from `./api/` | prune |
| **(ii) Generic contract in the platform, declaration in the owner** | as (i) | `platform/shared/footprint/footprint.ts`: types only, naming no extension | as (i), or as (iii) | none | prune, or the composition root |
| **(iii) Composition level above the extensions** | as (i) | as (ii) | a new top-level module imports each owner's declaration and builds prune with the list; `package.json` lists it in place of `./extensions/prune/index.ts` | `test/architecture.test.ts:442-447` requires every entry to be `./extensions/<name>/index.ts`; a new folder needs Biome overrides, a place in the layer chain (`ARCHITECTURE.md:8`) and docs-sync rules | only the composition root |

Facts that hold for all three:

- `platform/*` may not import `extensions/*` (2.4). So no platform layer can collect declarations. The collector is an extension's `api/` or a module above the extensions.
- A disabled writer's declaration still reaches prune only by a static import. Pi skips the disabled entry's factory, but the file is still in the package, and an `import` loads it like any module. Not verified: how pi's resource config turns one entry off (`launcher/README.md:162` is the only pointer). The declaration is data and pure functions, so it needs nothing from the writer's runtime.
- Importing an owner's `index.ts` loads its whole module graph: every `extensions/*/index.ts` is one line, `export { default } from "./api/extension.ts";`. A throw while subagents' modules load would also stop prune. Not checked: whether any subagents module does work at load time.
- A consumer's `core/` may not import another extension (`biome.json:567-569`). So the declaration crosses at `api/`, and prune's `api/` hands it to `core/` as a value.

### 3.4 Recommendation

Take (ii): the generic contract is a types-only file in `platform/shared/footprint/`, each writer declares its footprint in its own `api/` and re-exports it from its `index.ts`, and prune's `api/extension.ts` imports those declarations and passes them to the engine in prune's `core/`. It needs no rule change, keeps every layout in the extension that writes it, and a disabled writer's old data is still cleaned because the import is static. If the owner wants no extension to name another, the same declarations and contract move unchanged to a composition root (iii); only the collector moves.

Strongest objection: prune becomes the first extension that imports another one (no shipped extension does today, 2.4), and through `index.ts` it loads all of subagents' code to read one value. That is the opposite of "extensions know nothing about each other" in the strict sense, even though the edge runs from reader to writer and the writer still knows nothing about prune.

The handoff folder has two writers: session-limits (`extensions/session-limits/core/handoff.ts:64`) and subagents (`extensions/subagents/core/model/paths.ts:12`), both from `platform/shared/handoff/handoff-document.ts:60-61`. Subagents uses it in `core/`, which may not import session-limits. So neither extension can own it under today's import rules. This note keeps its declaration beside `handoffRoot` in `platform/shared/handoff/`, as a shared format. That depends on the owner accepting shared formats in `platform/shared` (README section 8, question 1).

## 4. Recommended design

### 4.1 What the contract must express

To cover today's two footprints without losing behaviour:

| Need | Agent runs | Handoff folders |
|---|---|---|
| Homes, and how a home folder's name ties to a session | stems beside the session files (name + `.jsonl` = the session file); the fallback root (name = session id) | `handoffRoot()` (name = session id) |
| Where the units are inside a home folder | each subfolder of `runsDir(home)` | the home folder itself |
| Whether the home is in a shared place | no | yes: the owner and mode checks of 2.1 #11 |
| Keep rule and links | the manifest read through `runRules`; unreadable keeps | none |
| Age, size | newest mtime and bytes one level deep | same |
| Folders to clear after removal | the `agents/` folder and the home folder, non-recursive | none |
| Empty folders | no | older than a day, not live, non-recursive `rmdir` |
| Report noun | `agent run` | `handoff dir` |

Safety rules that the engine holds for every footprint, not the declarations: never follow a symbolic link (`lstat`, `Dirent`), use a shared-place home only when it passes the owner and mode checks, keep a unit that cannot be read, never remove a unit whose linked units are kept or fresh, one liveness and mtime check per chain before the first unlink, and remove a member's units only after its own session file is gone. Performance rules the engine holds: one `opendir` stream per home through one bounded pool, the fresh-folder shortcut for units without a keep rule, and measuring one level deep. The owner reported 387,000 folders in their handoff root; that figure is theirs and is not in the repository. Commit `2b67f448` measured the streaming change on a 50,000-folder fixture.

### 4.2 Contract sketch

In this note only, not in code. The types name no extension, so they fit `platform/shared` under the rule.

```ts
// platform/shared/footprint/footprint.ts
export type Owner = { file: string } | { id: string };

export type UnitRules = { keep: boolean; links: readonly string[] };

export type Home = {
  root(agentDir: string): string;
  shared: boolean;
  owner(root: string, name: string): Owner;
  units: { kind: "itself" } | { kind: "subfolders"; of(home: string): string };
};

export type Footprint = {
  noun: string;
  homes: readonly Home[];
  rules?: { file: string; read(json: unknown): UnitRules };
  emptyAfterMs?: number;
};
```

```ts
// extensions/subagents/index.ts
/** @public */
export { default } from "./api/extension.ts";
export { runsFootprint } from "./api/footprint.ts";

// extensions/prune/api/extension.ts
import { runsFootprint } from "../../subagents/index.ts";
import { handoffFootprint } from "../../../platform/shared/index.ts";
// … plugins({ footprints: [runsFootprint, handoffFootprint], … })
```

`extensions/subagents/api/footprint.ts` builds `runsFootprint` from the layout in `extensions/subagents/core/model/` (today's `platform/shared/agent-runs/agent-runs.ts`, moved back). "Clear the folders above a removed unit" follows from `units.kind`: for `subfolders`, the `of(home)` folder and then the home folder.

Open in the sketch: the stems home has one root per slug folder under `<agentDir>/sessions/`, and prune lists those folders already when it reads session files (`core/sweep-scan.ts:36-48`). Either `root` returns many roots, or prune hands the engine the stems it listed. The second keeps one `readdir` per slug, as today.

### 4.3 What moves where

| Today | After |
|---|---|
| `platform/shared/agent-runs/agent-runs.ts` (33 lines) and `platform/shared/tests/agent-runs.test.ts` (36 lines) | removed; the layout back in `extensions/subagents/core/model/` (beside `paths.ts`), its test in `extensions/subagents/tests/`; `sessionStem` to `platform/pi-adapter` |
| none | `extensions/subagents/api/footprint.ts`: `runsFootprint` (about 20 lines), re-exported from `extensions/subagents/index.ts` |
| none | `platform/shared/footprint/footprint.ts`: the types (about 30 lines) |
| none | `handoffFootprint` (about 10 lines) beside `handoffRoot` in `platform/shared/handoff/handoff-document.ts`, if shared formats stay |
| `extensions/prune/core/agent-runs.ts` (117 lines), `core/handoff-scan.ts` (69 lines) | removed |
| none | `extensions/prune/core/footprint-scan.ts` and `footprint-remove.ts`: the engine (about 220 lines) |
| `extensions/prune/api/extension.ts`, `api/plugin.ts` | import the declarations and pass `footprints` instead of `handoffRoot` |
| `core/sweep-scan.ts`, `sweep-plan.ts`, `sweep-apply.ts` (335 lines) | rewritten around `Map<noun, …>` instead of named fields (about 250 lines touched) |
| `ui/prune-report.ts` | the nouns come from the declarations (about 20 lines) |
| `core/pool.ts`, `real-dirs.ts`, `path-key.ts`, `session-chains.ts`, `live-markers.ts`, `ui/prune-picker.ts` | unchanged |

What prune holds afterwards: the engine, session chains, liveness markers, the cutoff, the plan, the picker and the report. No layout of another extension.

### 4.4 Size

- Shipped code: about 650 to 750 lines moved or rewritten, net about the same size. The first version said 550 to 650; the difference is moving the layout back to subagents and the declaration and wiring in subagents' and prune's `api/`.
- Tests: `extensions/prune/tests/sweep.test.ts` (845 lines, 38 cases) and `tests/handoff-scan.test.ts` (175 lines, 7 cases) assert on the named fields and would be largely rewritten; `tests/prune.test.ts` (909 lines, 28 cases) drives the use cases on a real temp folder and would mostly keep its assertions; `tests/support/session-layout.ts` (210 lines) imports the run layout from `platform/shared` today and would take it from subagents' `index.ts` (whether Biome allows that import from a `tests/support/` file was not checked). Roughly 1,050 to 1,350 test lines touched.
- Verification to repeat: prune's safety guards went through two rounds of mutation testing that each found guards the tests missed (`4334eed4`, `79bc02e8`), and a live pass on a real pi (reported by the orchestrator; not recorded in the repository). Both would have to be done again, because every guard moves.
- Docs: under `test/docs-sync.test.ts` (`AGENTS.md:19`), each step that touches prune's or subagents' shipped files also changes that extension's `README.md`, `ARCHITECTURE.md` and `STRUCTURE.md` and the root `ARCHITECTURE.md` and `STRUCTURE.md`; plus `platform/shared`'s docs, and the `AGENTS.md:18` rule if its wording changes.
- About six PRs.

### 4.5 Steps, each one PR

1. **Move the run layout back to subagents.** Move `platform/shared/agent-runs/agent-runs.ts` into `extensions/subagents/core/model/`, except `sessionStem` (`:14`), which is pi's format and goes to `platform/pi-adapter` (`findings/prune.md` #4). Add the types-only `platform/shared/footprint/footprint.ts` and `extensions/subagents/api/footprint.ts`, re-exported from subagents' `index.ts`. Prune's `api/extension.ts` imports `runsFootprint` and passes it into `core/`; `core/agent-runs.ts` and `sweep-*.ts` read the layout from the passed value instead of `platform/shared`. No behaviour change. This undoes the interim step of PR #43.
2. **Handoff folders on the engine.** Add `handoffFootprint`, write the engine for the `itself` kind with the root checks, streaming, the fresh shortcut and empties. Port `handoff-scan.test.ts`. Remove `handoff-scan.ts`.
3. **Agent runs on the engine.** Extend the engine to the `subfolders` kind with rules and links, both homes. Port the run cases of `sweep.test.ts`. Remove `agent-runs.ts`.
4. **Key by noun.** Make `Scan`, `Plan`, `Removed` and the report keyed by footprint noun. Port the rest of `sweep.test.ts` and `report.test.ts`.
5. **Verify.** A mutation round over the engine and `sweep-apply.ts`, and a live pass on a real pi.
6. **Enforce.** The `platform/` name check proposed in README section 9 can then hold without an allowlist entry for `pi-subagents`.

Step 1 has a user for every new export in the same PR, so knip passes. If the owner picks (iii), step 1 adds the composition root instead of the import in prune's `api/`; steps 2 to 6 are the same.

### 4.6 Risks

- The contract is shaped by exactly two cases. A third writer may not fit it, and then the contract grows a flag per case.
- The safety guards move. They were hardened by two mutation rounds; a rewrite can lose one without a test failing until the next round.
- Links across folders: the engine, like today's code, treats a link to a run it did not load as absent (`extensions/prune/core/agent-runs.ts:53-55`). If a successor can live in another session's `agents/` folder (for example after a handoff), a run could be removed while its partner is kept. Not checked in this note; it is a risk today as well.
- The fresh-folder shortcut must not be applied to units with links: a fresh run that is not loaded drops out of an old run's chain. Today runs are always read, which avoids this.
- Generic report wording can read worse than today's hand-written sentences (`ui/prune-report.ts:72`, `:79`).
- Prune loads subagents' module graph (3.3). A load-time failure there stops prune.

### 4.7 When it is not worth doing

The owner has decided the direction: knowledge one extension owns leaves `platform/`, across all fifteen extensions. So the points below no longer argue against the work. They bear on its order and on when prune's engine is worth rewriting, as against only moving the layout back (step 1).

- Only two footprints exist (2.5). What remains in prune after step 1 is mostly naming and shape.
- A change to the shape of a layout (another nesting level, a new home) needs a prune change today, and would also need a contract change under B, unless the contract already foresaw it.
- The rewrite redoes code that has been mutation tested twice and run live.

Step 1 alone meets the owner's rule for agent runs. Steps 2 to 5 remove prune's remaining shape knowledge; they could wait for a third footprint without breaking the rule.

## 5. Open points

- **Launcher write-back table.** `launcher/shared/write-back-table.ts:68-103` lists the settings keys the launcher copies back from the sandbox. It is about user settings, not per-session folders, so it is a different list. The launcher may not import `platform/shared` (`AGENTS.md:18`; `test/architecture.test.ts:348` checks that it imports only `node:*` and its own files), so it cannot read the declarations. `pi-prune.json` is not in the table (`write-back-table.ts:83-103`).
- **The `AGENTS.md:18` sentence.** Its paths could be checked against the declarations. Most of the sentence is policy (who may delete, chains, what is never touched), which a list of paths does not carry.
- **A test that an extension writes nothing outside what it declares.** Two ways, neither tried: (1) static, an architecture test that finds every write call (`writeFile`, `mkdir`, `rm`, `rename`, `appendFile`, `writeSettingsFile`, `ensureProjectSubdir`) in shipped code and requires an allowlist entry per call site; cheap but approximate. (2) Dynamic: run each extension on the fake host (`startExtension` in `test/framework/`) with a temp agent dir, session dir and temp dir, and compare what appeared on disk with the declared patterns; exact for what the fakes exercise, blind to what they do not (child runs, git worktrees).
- **Registration on top of B.** If the owner wants a disabled extension's data left alone, the engine can skip a footprint whose writer has not registered in this process through a `globalRecord`. That brings back A's gaps for that footprint only.

## 6. Questions for the owner

1. May prune's `api/` import subagents' `index.ts` for its declaration (3.4), or do they want a composition root above the extensions (iii), so that no extension names another?
2. Does the handoff protocol, written by two extensions, stay in `platform/shared` as a shared format, or must it have one owning extension? Under today's import rules neither writer can own it (3.4).
3. Is step 1 alone enough for now, with the engine (steps 2 to 5) when a third footprint appears?
4. When a writer is turned off, should its old data still be cleaned (B) or left until it is turned on again (A, or B plus registration)?
5. Should the declarations also list user settings files and project files, so that one list could back the `AGENTS.md:18` check? That widens the contract past cleanup.
